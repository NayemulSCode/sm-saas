/**
 * Recording and reversing payments. §13.3, §13.4.
 *
 * The reason this slice exists: a gapless, per-school-per-fiscal-year receipt
 * number, issued inside the same transaction as the allocation it pays for.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { InvoiceId, PaymentId, SchoolId, StudentId } from '../../../shared/ids';
import { Money } from '../../../shared/money';
import { LocalDate, type LocalDate as LocalDateType } from '../../../shared/date';
import { allocatePayment, type AllocationRequest } from '../domain/allocate';
import { sumLines, recomputeStatus } from '../domain/invoice';
import { invoices, payments, receiptSequences, schools } from '../infrastructure/repositories';

export const PaymentErrors = defineErrors({
  BACKDATE_NOT_PERMITTED: {
    code: 'BACKDATE_NOT_PERMITTED',
    messageKey: 'finance.error.backdateNotPermitted',
    httpStatus: 403,
  },
  PAYMENT_NOT_FOUND: {
    code: 'PAYMENT_NOT_FOUND',
    messageKey: 'finance.error.paymentNotFound',
    httpStatus: 404,
  },
  ALREADY_REVERSED: {
    code: 'ALREADY_REVERSED',
    messageKey: 'finance.error.alreadyReversed',
    httpStatus: 409,
  },
});

/** Primitive shapes at the application boundary — parsed into Money/branded
 *  ids inside `recordPayment`, the same division of labour as every other
 *  use case's string dates and raw ids. */
export type RecordPaymentAllocationInput =
  | { mode: 'auto' }
  | { mode: 'manual'; lines: ReadonlyArray<{ invoiceLineId: string; amountMinor: bigint }> };

export interface RecordPaymentInput {
  schoolId: SchoolId;
  studentId: StudentId;
  amountMinor: bigint;
  channel: 'cash' | 'bank' | 'cheque' | 'mfs' | 'online';
  channelRef?: string | undefined;
  /** A calendar day — may be backdated. */
  collectedAt: string;
  allocation: RecordPaymentAllocationInput;
  idempotencyKey: string;
}

export interface RecordPaymentResult {
  paymentId: PaymentId;
  receiptNo: bigint;
  fiscalYear: number;
  replay: boolean;
}

/** Fixed UTC+6, no DST — a `LocalDate` at noon Dhaka, so the stored instant
 *  falls unambiguously on the requested calendar day regardless of the
 *  server's own timezone. */
function localDateToDhakaNoon(d: LocalDateType): Date {
  return new Date(Date.UTC(d.y, d.m - 1, d.d, 12 - 6, 0, 0));
}

/** '2027' if the school's fiscal year starts in January and the date falls in
 *  2027; a school whose fiscal year starts in July treats Jan–Jun 2027 as
 *  fiscal year 2026, matching how `payment.fiscal_year` groups a receipt
 *  sequence that must not reset mid-session. */
function fiscalYearFor(date: LocalDateType, startMonth: number): number {
  return date.m >= startMonth ? date.y : date.y - 1;
}

async function recomputeInvoice(
  tx: Parameters<typeof invoices.linesFor>[0],
  invoiceId: InvoiceId,
): Promise<void> {
  const [lines, current] = await Promise.all([invoices.linesFor(tx, invoiceId), invoices.byId(tx, invoiceId)]);
  const totals = sumLines(
    lines.map((l) => ({
      amountMinor: Money.fromMinor(l.amountMinor),
      discountMinor: Money.fromMinor(l.discountMinor),
      paidMinor: Money.fromMinor(l.paidMinor),
    })),
  );
  const status = recomputeStatus({ ...totals, lateFeeMinor: Money.zero() }, current?.status ?? 'issued');
  await invoices.updateTotals(tx, invoiceId, {
    totalMinor: totals.totalMinor.minor,
    discountMinor: totals.discountMinor.minor,
    paidMinor: totals.paidMinor.minor,
    status,
  });
}

export async function recordPayment(
  ctx: AuthContext,
  input: RecordPaymentInput,
): Promise<Result<RecordPaymentResult, DomainError>> {
  authorize(ctx, 'fee.collect');

  const collectedParsed = LocalDate.parse(input.collectedAt);
  if (!collectedParsed.ok) return err({ code: 'VALIDATION_FAILED', messageKey: 'common.error.validation', httpStatus: 400 });
  const collectedDate = collectedParsed.value;

  // Backdated: any day before today in Dhaka. `fee.backdate` gates it —
  // checked here, not in the DTO, because it depends on WHO is asking, not
  // just what was asked.
  if (LocalDate.compare(collectedDate, LocalDate.today()) < 0) {
    authorize(ctx, 'fee.backdate');
  }

  return withTenant(
    ctx,
    async (tx) => {
      // Idempotency: `payment.idempotency_key` is UNIQUE per tenant (§13.3).
      // A retried request with the same key replays the original result
      // rather than erroring OR double-charging — the point of the header.
      const existing = await payments.byIdempotencyKey(tx, input.idempotencyKey);
      if (existing) {
        return ok({
          paymentId: existing.id,
          receiptNo: existing.receiptNo,
          fiscalYear: existing.fiscalYear,
          replay: true,
        });
      }

      const outstandingRows = await invoices.outstandingFor(tx, input.studentId);
      const outstanding = outstandingRows.map((r) => ({
        invoiceLineId: r.invoiceLineId,
        dueDate: r.dueDate,
        feeHeadSequence: r.feeHeadSequence,
        outstanding: Money.fromMinor(r.outstandingMinor),
      }));

      const request: AllocationRequest =
        input.allocation.mode === 'manual'
          ? {
              mode: 'manual',
              lines: input.allocation.lines.map((l) => ({
                invoiceLineId: l.invoiceLineId as (typeof outstanding)[number]['invoiceLineId'],
                amount: Money.fromMinor(l.amountMinor),
              })),
            }
          // No per-school configured allocation policy in this slice
          // (§13.5's `head_priority`/`proportional` need a settings screen
          // that does not exist yet) — 'oldest_first' is the spec's own
          // default and the one an accountant expects without being told.
          : { mode: 'auto', policy: 'oldest_first' };

      const allocationResult = allocatePayment(Money.fromMinor(input.amountMinor), outstanding, request);
      if (!allocationResult.ok) return err(allocationResult.error);

      const fiscalYearStartMonth = await schools.fiscalYearStartMonth(tx, input.schoolId);
      const fiscalYear = fiscalYearFor(collectedDate, fiscalYearStartMonth);

      // The gapless issuance itself: SELECT ... FOR UPDATE on receipt_sequence
      // serialises concurrent payments for this (school, fiscal year), and
      // the counter rolls back with the transaction on any failure below —
      // which is the entire reason this is a row, not a SEQUENCE (§13.4).
      const receiptNo = await receiptSequences.nextAndIncrement(tx, input.schoolId, fiscalYear);

      const paymentId = await payments.create(tx, {
        schoolId: input.schoolId,
        studentId: input.studentId,
        fiscalYear,
        receiptNo,
        amountMinor: input.amountMinor,
        channel: input.channel,
        channelRef: input.channelRef,
        collectedAt: localDateToDhakaNoon(collectedDate),
        collectedBy: ctx.personId,
        idempotencyKey: input.idempotencyKey,
      });

      await payments.recordAllocations(
        tx,
        paymentId,
        allocationResult.value.map((a) => ({ invoiceLineId: a.invoiceLineId, amountMinor: a.amount.minor })),
      );

      for (const a of allocationResult.value) {
        await invoices.applyPaymentToLine(tx, a.invoiceLineId, a.amount.minor);
      }

      const touchedInvoices = await payments.invoicesForLines(
        tx,
        allocationResult.value.map((a) => a.invoiceLineId),
      );
      for (const invoiceId of touchedInvoices) {
        await recomputeInvoice(tx, invoiceId);
      }

      await audit(tx, ctx, 'fee.paymentRecorded', paymentId, {
        entityType: 'payment',
        after: {
          paymentId,
          studentId: input.studentId,
          receiptNo: fact(receiptNo.toString()),
          fiscalYear: fact(fiscalYear),
          amountMinor: fact(input.amountMinor.toString()),
          channel: fact(input.channel),
        },
      });

      return ok({ paymentId, receiptNo, fiscalYear, replay: false });
    },
    // Money-moving: wait for the replica, not just the local WAL (§4.5).
    { synchronousCommit: 'remote_write' },
  );
}

export interface ReversePaymentResult {
  reversalPaymentId: PaymentId;
}

/**
 * A refund is a reversing row, never a delete — the original receipt number
 * stays consumed (invariant 1). The reversal gets its OWN receipt number from
 * the same gapless sequence, so it is exactly as accountable as the payment
 * it undoes.
 */
export async function reversePayment(
  ctx: AuthContext,
  paymentId: PaymentId,
  reason: string,
): Promise<Result<ReversePaymentResult, DomainError>> {
  authorize(ctx, 'fee.refund');

  return withTenant(
    ctx,
    async (tx) => {
      const original = await payments.byId(tx, paymentId);
      if (!original) return err(PaymentErrors.PAYMENT_NOT_FOUND);
      if (original.reversedByPaymentId) return err(PaymentErrors.ALREADY_REVERSED);

      const allocations = await payments.allocationsFor(tx, paymentId);

      // The reversal draws its own receipt from the SAME (school, fiscal
      // year) sequence as the payment it undoes — it is exactly as
      // accountable as the original, not a footnote to it.
      const receiptNo = await receiptSequences.nextAndIncrement(tx, original.schoolId, original.fiscalYear);

      // A reversal is deterministically idempotent on its own key: a retried
      // reversal request for the same payment lands on the same row rather
      // than issuing a second receipt, and ALREADY_REVERSED above already
      // catches a second reversal AFTER the first one committed.
      const reversalId = await payments.create(tx, {
        schoolId: original.schoolId,
        studentId: original.studentId,
        fiscalYear: original.fiscalYear,
        receiptNo,
        // Positive, per the database CHECK — a reversal is its own payment
        // row, distinguished by reversesPaymentId, not by a negative amount.
        amountMinor: original.amountMinor,
        channel: original.channel,
        collectedAt: localDateToDhakaNoon(LocalDate.today()),
        collectedBy: ctx.personId,
        idempotencyKey: `reversal:${paymentId}`,
        reversesPaymentId: paymentId,
        reversalReason: reason,
      });

      // Undoes exactly what the original allocated — negative amounts are
      // valid on payment_allocation (CHECK amount_minor <> 0), so the same
      // repository calls that applied the payment now reverse it.
      await payments.recordAllocations(
        tx,
        reversalId,
        allocations.map((a) => ({ invoiceLineId: a.invoiceLineId, amountMinor: -a.amountMinor })),
      );
      for (const a of allocations) {
        await invoices.applyPaymentToLine(tx, a.invoiceLineId, -a.amountMinor);
      }

      const touchedInvoices = await payments.invoicesForLines(tx, allocations.map((a) => a.invoiceLineId));
      for (const invoiceId of touchedInvoices) {
        await recomputeInvoice(tx, invoiceId);
      }

      await payments.markReversedBy(tx, paymentId, reversalId);

      await audit(tx, ctx, 'fee.paymentReversed', reversalId, {
        entityType: 'payment',
        reason,
        before: { paymentId: fact(paymentId), receiptNo: fact(original.receiptNo.toString()) },
        after: { reversalPaymentId: fact(reversalId), receiptNo: fact(receiptNo.toString()) },
      });

      return ok({ reversalPaymentId: reversalId });
    },
    { synchronousCommit: 'remote_write' },
  );
}
