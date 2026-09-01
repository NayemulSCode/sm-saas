/**
 * Recording a payment and issuing its receipt, in one transaction. §13.3, §13.4.
 *
 * Follows §13.4's own sketch in order: the `Idempotency-Key` check first,
 * before anything else; the receipt number locked, read and incremented
 * before the payment that will carry it exists, so a rollback later in the
 * same transaction returns the counter with it — a `SEQUENCE` cannot do
 * that, which is why `receipt_sequence` is a plain table under `FOR UPDATE`
 * rather than one.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { beginIdempotent, completeIdempotent } from '../../../db/idempotency';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { LocalDate, systemClock, type Clock } from '../../../shared/date';
import { Money } from '../../../shared/money';
import type {
  CollectionSessionId,
  InvoiceId,
  InvoiceLineId,
  PaymentId,
  StudentId,
} from '../../../shared/ids';
import { allocatePayment, type AllocationPolicy } from '../domain/rules/allocate';
import { fiscalYearOf } from '../domain/rules/fiscalYear';
import { finance } from '../infrastructure/repositories';

export const PaymentErrors = defineErrors({
  STUDENT_NOT_FOUND: {
    code: 'STUDENT_NOT_FOUND',
    messageKey: 'finance.error.studentNotFound',
    httpStatus: 404,
  },
  INVALID_COLLECTED_AT: {
    code: 'INVALID_COLLECTED_AT',
    messageKey: 'finance.error.invalidCollectedAt',
    httpStatus: 400,
  },
  /** §13.7. `oldest_first`/manual named more than everything owed can absorb. */
  ALLOCATION_EXCEEDS_OUTSTANDING: {
    code: 'ALLOCATION_EXCEEDS_OUTSTANDING',
    messageKey: 'finance.error.allocationExceedsOutstanding',
    httpStatus: 422,
  },
  /** `manual` named a line this student has no outstanding balance on at all
   *  — never issued to them, already fully paid, or on a void/written-off
   *  invoice. One code for all three: the actionable fact is the same. */
  UNKNOWN_INVOICE_LINE: {
    code: 'UNKNOWN_INVOICE_LINE',
    messageKey: 'finance.error.unknownInvoiceLine',
    httpStatus: 404,
  },
  /** `manual` named amounts that do not sum to the payment, or a zero/negative
   *  amount on a named line. */
  MANUAL_ALLOCATION_INCOMPLETE: {
    code: 'MANUAL_ALLOCATION_INCOMPLETE',
    messageKey: 'finance.error.manualAllocationIncomplete',
    httpStatus: 422,
  },
  /** `collectedAt` is before today and the caller holds `fee.collect` but not
   *  `fee.backdate` — an office assistant enters same-day cash only; an
   *  accountant or a head can correct an earlier day's entry. */
  BACKDATE_NOT_PERMITTED: {
    code: 'BACKDATE_NOT_PERMITTED',
    messageKey: 'finance.error.backdateNotPermitted',
    httpStatus: 403,
  },
  IDEMPOTENCY_KEY_REUSED: {
    code: 'IDEMPOTENCY_KEY_REUSED',
    messageKey: 'finance.error.idempotencyKeyReused',
    httpStatus: 409,
  },
  /** Every channel except cash needs a reference — a deposit slip, a cheque
   *  number, a transaction id. The DTO's own `.refine()` is a real client's
   *  first line of defence; this is the second, for any caller that reaches
   *  the use case directly. Money-moving code gets both — an uncaught
   *  constraint violation here is a worse failure than the extra check. */
  CHANNEL_REFERENCE_REQUIRED: {
    code: 'CHANNEL_REFERENCE_REQUIRED',
    messageKey: 'finance.error.channelReferenceRequired',
    httpStatus: 400,
  },
  /** The collector's session for today has already been closed (or
   *  verified) — §13.7's own error for this endpoint. Reopening it is a
   *  deliberate, separate decision this use case does not make; the
   *  collector opens a new one tomorrow, or an accountant intervenes. */
  SESSION_CLOSED: {
    code: 'SESSION_CLOSED',
    messageKey: 'finance.error.sessionClosed',
    httpStatus: 423,
  },
});

export interface RecordPaymentInput {
  studentId: StudentId;
  /** Minor units, as a wire string. */
  amountMinor: string;
  channel: 'cash' | 'bank' | 'cheque' | 'mfs' | 'online';
  channelRef?: string | undefined;
  /** A DATE, not an instant — "the office enters Saturday's cash on Monday",
   *  so what is backdated is which BUSINESS DAY, not a time of day. */
  collectedAt: string;
  allocation:
    | { mode: 'auto' }
    | { mode: 'manual'; lines: ReadonlyArray<{ invoiceLineId: string; amountMinor: string }> };
  /**
   * §13.7 lists this on the wire, but `payment` (§13.3) has no column for
   * it — the schema and the contract disagree, in a small way, and adding a
   * migration for one optional annotation is disproportionate to what it is
   * for. It lands in the audit row's `reason` instead, which exists
   * precisely for free-text human context on a mutation.
   */
  note?: string | undefined;
}

export interface PaymentAllocationView {
  invoiceLineId: string;
  feeHeadName: string;
  amountMinor: string;
}

export interface PaymentView {
  id: PaymentId;
  receiptNo: number;
  amountMinor: string;
  collectedAt: string;
  recordedAt: string;
  allocations: PaymentAllocationView[];
  /** What this student still owes, across every line, AFTER this payment. */
  remainingDueMinor: string;
}

export async function recordPayment(
  ctx: AuthContext,
  input: RecordPaymentInput,
  idempotencyKey: string,
  deps: { clock?: Clock } = {},
): Promise<Result<PaymentView, DomainError>> {
  authorize(ctx, 'fee.collect');

  const collectedAt = LocalDate.parse(input.collectedAt);
  if (!collectedAt.ok) return err(PaymentErrors.INVALID_COLLECTED_AT);
  if (input.channel !== 'cash' && !input.channelRef) {
    return err(PaymentErrors.CHANNEL_REFERENCE_REQUIRED);
  }

  const amount = Money.fromJSON(input.amountMinor);
  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const today = LocalDate.today(clock);

  return withTenant(
    ctx,
    async (tx) => {
      // §13.4's own ordering: this is the FIRST statement, before anything
      // else — including the permission check below, which is deliberate.
      // A caller replaying their own earlier request should get that
      // request's answer back even if their role changed in between; a
      // caller reusing the key for a genuinely different request is refused
      // by IDEMPOTENCY_KEY_REUSED regardless of what that answer would be.
      const idem = await beginIdempotent<PaymentView>(tx, {
        key: idempotencyKey,
        endpoint: 'POST /payments',
        requestBody: input,
      });
      if (idem.kind === 'reused') return err(PaymentErrors.IDEMPOTENCY_KEY_REUSED);
      if (idem.kind === 'replay') return ok(idem.body);

      if (LocalDate.compare(collectedAt.value, today) < 0 && !ctx.permissions.has('fee.backdate')) {
        return err(PaymentErrors.BACKDATE_NOT_PERMITTED);
      }

      const studentSchool = await finance.studentCurrentSchool(tx, input.studentId);
      if (!studentSchool) return err(PaymentErrors.STUDENT_NOT_FOUND);

      // Only cash ever attaches to a session — §13.3: `expected_minor` is
      // "Σ cash payments in session". A session for a DIFFERENT school (only
      // reachable in a multi-school tenant — one collector, one session per
      // day, tenant-wide) is simply not attached to rather than refused: the
      // mismatch is a bookkeeping-attribution question, not a reason to stop
      // someone from collecting a student's money.
      let collectionSessionId: CollectionSessionId | undefined;
      if (input.channel === 'cash') {
        const session = await finance.collectorSessionFor(tx, {
          collectorPersonId: ctx.personId,
          businessDate: today,
        });
        if (session && session.schoolId === studentSchool.schoolId) {
          if (session.status !== 'open') return err(PaymentErrors.SESSION_CLOSED);
          collectionSessionId = session.id;
        }
      }

      const outstanding = await finance.outstandingLinesFor(tx, input.studentId);

      const policy: AllocationPolicy =
        input.allocation.mode === 'manual'
          ? {
              mode: 'manual',
              lines: input.allocation.lines.map((l) => ({
                invoiceLineId: l.invoiceLineId,
                amountMinor: Money.fromJSON(l.amountMinor),
              })),
            }
          : { mode: 'oldest_first' };

      // §13.5's ordering table: ascending due date, then fee_head.sequence.
      // `allocatePayment` does not sort — the caller already has.
      const sorted = [...outstanding].sort((a, b) => {
        const byDate = LocalDate.compare(a.dueDate, b.dueDate);
        return byDate !== 0 ? byDate : a.feeHeadSequence - b.feeHeadSequence;
      });

      const verdict = allocatePayment(
        amount,
        sorted.map((o) => ({
          invoiceLineId: o.invoiceLineId,
          outstandingMinor: Money.fromMinor(o.outstandingMinor),
        })),
        policy,
      );

      switch (verdict.kind) {
        case 'exceeds_outstanding':
          return err(PaymentErrors.ALLOCATION_EXCEEDS_OUTSTANDING);
        case 'unknown_invoice_line':
          return err(PaymentErrors.UNKNOWN_INVOICE_LINE);
        case 'manual_incomplete':
          return err(PaymentErrors.MANUAL_ALLOCATION_INCOMPLETE);
        case 'ok':
          break;
      }

      const fiscalYear = fiscalYearOf(collectedAt.value, studentSchool.fiscalYearStartMonth);
      const receiptNo = await finance.nextReceiptNo(tx, {
        schoolId: studentSchool.schoolId,
        fiscalYear,
      });

      const paymentId = await finance.createPayment(tx, {
        schoolId: studentSchool.schoolId,
        studentId: input.studentId,
        fiscalYear,
        receiptNo,
        amountMinor: amount.minor,
        channel: input.channel,
        channelRef: input.channelRef ?? null,
        collectedAt: LocalDate.toInstantAtStartOfDay(collectedAt.value),
        recordedAt: now,
        collectedBy: ctx.personId,
        idempotencyKey,
        actorId: ctx.personId,
        collectionSessionId,
      });

      const lineToInvoice = new Map(outstanding.map((o) => [o.invoiceLineId, o.invoiceId]));
      const lineToHead = new Map(outstanding.map((o) => [o.invoiceLineId, o.feeHeadId]));
      const affectedInvoices = new Set<InvoiceId>();

      for (const a of verdict.allocations) {
        const invoiceLineId = a.invoiceLineId as InvoiceLineId;
        await finance.createPaymentAllocation(tx, {
          paymentId,
          invoiceLineId,
          amountMinor: a.amountMinor.minor,
          actorId: ctx.personId,
        });
        await finance.addPaidToLine(tx, invoiceLineId, a.amountMinor.minor, ctx.personId);
        const invoiceId = lineToInvoice.get(invoiceLineId);
        if (invoiceId) affectedInvoices.add(invoiceId);
      }

      for (const invoiceId of affectedInvoices) {
        await finance.recomputeInvoicePaidStatus(tx, invoiceId, ctx.personId);
      }

      const heads = await finance.listFeeHeads(tx);
      const nameByHead = new Map(heads.map((h) => [h.id, h.nameEn]));

      await audit(tx, ctx, 'payment.recorded', paymentId, {
        entityType: 'payment',
        ...(input.note ? { reason: input.note } : {}),
        after: {
          paymentId,
          studentId: input.studentId,
          schoolId: studentSchool.schoolId,
          receiptNo: fact(Number(receiptNo)),
          fiscalYear: fact(fiscalYear),
          channel: fact(input.channel),
          amountMinor: fact(amount.minor.toString()),
        },
      });

      const remaining = await finance.outstandingLinesFor(tx, input.studentId);
      const remainingDueMinor = remaining.reduce((sum, o) => sum + o.outstandingMinor, 0n);

      const view: PaymentView = {
        id: paymentId,
        receiptNo: Number(receiptNo),
        amountMinor: amount.minor.toString(),
        collectedAt: LocalDate.toISO(collectedAt.value),
        recordedAt: now.toISOString(),
        allocations: verdict.allocations.map((a) => {
          const feeHeadId = lineToHead.get(a.invoiceLineId as InvoiceLineId);
          return {
            invoiceLineId: a.invoiceLineId,
            feeHeadName: (feeHeadId && nameByHead.get(feeHeadId)) ?? '',
            amountMinor: a.amountMinor.minor.toString(),
          };
        }),
        remainingDueMinor: remainingDueMinor.toString(),
      };

      await completeIdempotent(tx, { key: idempotencyKey, status: 201, body: view });

      return ok(view);
    },
    // Financial RPO 0 — §13.4's own words for why this waits for the replica.
    { synchronousCommit: 'remote_write' },
  );
}
