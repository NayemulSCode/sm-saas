/**
 * Reversing a payment. §13.3, §13.7, §13.9's acceptance criterion 4.
 *
 * "Refunds are REVERSING rows, never deletes. A deleted payment is an
 * unexplainable gap in a gapless sequence." (§13.3.) This is that: a new
 * `payment` row, its own new receipt number, `reverses_payment_id` pointing
 * back — the original's receipt number stays permanently consumed, exactly
 * as issued.
 *
 * `payment_allocation.amount_minor` allows negative values (unlike
 * `payment.amount_minor`, which does not) specifically so a reversal can
 * mirror the original's allocations with the sign flipped. `addPaidToLine`
 * and `recomputeInvoicePaidStatus` — the same functions `recordPayment`
 * uses to move money onto a line — move it back off with no special case:
 * "increment by a negative number" already means "decrement".
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { LocalDate, systemClock, type Clock } from '../../../shared/date';
import type { InvoiceId, PaymentId } from '../../../shared/ids';
import { fiscalYearOf } from '../domain/rules/fiscalYear';
import { finance } from '../infrastructure/repositories';
import type { PaymentAllocationView, PaymentView } from './recordPayment';

export const ReversalErrors = defineErrors({
  PAYMENT_NOT_FOUND: {
    code: 'PAYMENT_NOT_FOUND',
    messageKey: 'finance.error.paymentNotFound',
    httpStatus: 404,
  },
  /** A payment can be reversed exactly once — reversing a reversal is a NEW
   *  payment (money changing hands again), not this operation. */
  ALREADY_REVERSED: {
    code: 'ALREADY_REVERSED',
    messageKey: 'finance.error.paymentAlreadyReversed',
    httpStatus: 409,
  },
  INVALID_COLLECTED_AT: {
    code: 'INVALID_COLLECTED_AT',
    messageKey: 'finance.error.invalidCollectedAt',
    httpStatus: 400,
  },
  /** Same gate `recordPayment` applies, same reasoning: an office assistant
   *  reverses same-day, an accountant or a head can correct an earlier day. */
  BACKDATE_NOT_PERMITTED: {
    code: 'BACKDATE_NOT_PERMITTED',
    messageKey: 'finance.error.backdateNotPermitted',
    httpStatus: 403,
  },
});

export interface ReversePaymentInput {
  paymentId: PaymentId;
  reason: string;
  /** When the reversal itself happened. Defaults to today. */
  collectedAt?: string | undefined;
}

export async function reversePayment(
  ctx: AuthContext,
  input: ReversePaymentInput,
  deps: { clock?: Clock } = {},
): Promise<Result<PaymentView, DomainError>> {
  authorize(ctx, 'fee.refund');

  const clock = deps.clock ?? systemClock;
  const now = clock.now();
  const today = LocalDate.today(clock);

  const collectedAt =
    input.collectedAt === undefined ? { ok: true as const, value: today } : LocalDate.parse(input.collectedAt);
  if (!collectedAt.ok) return err(ReversalErrors.INVALID_COLLECTED_AT);
  if (LocalDate.compare(collectedAt.value, today) < 0 && !ctx.permissions.has('fee.backdate')) {
    return err(ReversalErrors.BACKDATE_NOT_PERMITTED);
  }

  return withTenant(
    ctx,
    async (tx) => {
      const original = await finance.paymentById(tx, input.paymentId);
      if (!original) return err(ReversalErrors.PAYMENT_NOT_FOUND);
      if (original.reversedByPaymentId) return err(ReversalErrors.ALREADY_REVERSED);

      const fiscalYearStartMonth = (await finance.schoolFiscalYearStartMonth(tx, original.schoolId)) ?? 1;
      const fiscalYear = fiscalYearOf(collectedAt.value, fiscalYearStartMonth);
      const receiptNo = await finance.nextReceiptNo(tx, { schoolId: original.schoolId, fiscalYear });

      const reversingPaymentId = await finance.createPayment(tx, {
        schoolId: original.schoolId,
        studentId: original.studentId,
        fiscalYear,
        receiptNo,
        amountMinor: original.amountMinor,
        channel: original.channel,
        channelRef: original.channelRef,
        collectedAt: LocalDate.toInstantAtStartOfDay(collectedAt.value),
        recordedAt: now,
        collectedBy: ctx.personId,
        // No client-supplied Idempotency-Key for this endpoint (§13.7 does
        // not mark one required, unlike POST /payments) — synthesised from
        // the original's own id instead. It is still a real backstop: a
        // second reversal of the SAME payment collides on `payment`'s own
        // `UNIQUE (tenant_id, idempotency_key)`, alongside the explicit
        // `ALREADY_REVERSED` check above.
        idempotencyKey: `reversal:${original.id}`,
        actorId: ctx.personId,
        reversesPaymentId: original.id,
        reversalReason: input.reason,
      });

      const allocations = await finance.paymentAllocationsFor(tx, original.id);
      const affectedInvoices = new Set<InvoiceId>();

      for (const a of allocations) {
        await finance.createPaymentAllocation(tx, {
          paymentId: reversingPaymentId,
          invoiceLineId: a.invoiceLineId,
          amountMinor: -a.amountMinor,
          actorId: ctx.personId,
        });
        await finance.addPaidToLine(tx, a.invoiceLineId, -a.amountMinor, ctx.personId);
        affectedInvoices.add(a.invoiceId);
      }

      for (const invoiceId of affectedInvoices) {
        await finance.recomputeInvoicePaidStatus(tx, invoiceId, ctx.personId);
      }

      await finance.markPaymentReversed(tx, original.id, reversingPaymentId, ctx.personId);

      await audit(tx, ctx, 'payment.reversed', reversingPaymentId, {
        entityType: 'payment',
        reason: input.reason,
        before: { paymentId: fact(original.id) },
        after: {
          reversesPaymentId: fact(original.id),
          receiptNo: fact(Number(receiptNo)),
          amountMinor: fact(original.amountMinor.toString()),
        },
      });

      const heads = await finance.listFeeHeads(tx);
      const nameByHead = new Map(heads.map((h) => [h.id, h.nameEn]));
      const viewAllocations: PaymentAllocationView[] = allocations.map((a) => ({
        invoiceLineId: a.invoiceLineId,
        feeHeadName: nameByHead.get(a.feeHeadId) ?? '',
        amountMinor: (-a.amountMinor).toString(),
      }));

      const remaining = await finance.outstandingLinesFor(tx, original.studentId);
      const remainingDueMinor = remaining.reduce((sum, o) => sum + o.outstandingMinor, 0n);

      const view: PaymentView = {
        id: reversingPaymentId,
        receiptNo: Number(receiptNo),
        amountMinor: original.amountMinor.toString(),
        collectedAt: LocalDate.toISO(collectedAt.value),
        recordedAt: now.toISOString(),
        allocations: viewAllocations,
        remainingDueMinor: remainingDueMinor.toString(),
      };

      return ok(view);
    },
    { synchronousCommit: 'remote_write' },
  );
}
