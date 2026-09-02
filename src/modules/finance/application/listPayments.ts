/**
 * A student's payment history. §13.3, §13.7 — the read a reversal screen
 * needs and neither `recordPayment` nor `reversePayment` returns: both hand
 * back the ONE payment they just acted on, never the list a person picks
 * from. Read-only, same `fee.read` gate `listOutstanding` uses.
 */

import { withTenant } from '../../../db/rls';
import { type Result, ok, type DomainError } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { LocalDate } from '../../../shared/date';
import type { PaymentId, StudentId } from '../../../shared/ids';
import { finance } from '../infrastructure/repositories';

export interface PaymentListRow {
  id: PaymentId;
  receiptNo: number;
  amountMinor: string;
  channel: 'cash' | 'bank' | 'cheque' | 'mfs' | 'online';
  channelRef: string | null;
  collectedAt: string;
  recordedAt: string;
  reversesPaymentId: PaymentId | null;
  reversedByPaymentId: PaymentId | null;
  reversalReason: string | null;
}

export async function listPaymentsForStudent(
  ctx: AuthContext,
  studentId: StudentId,
): Promise<Result<PaymentListRow[], DomainError>> {
  authorize(ctx, 'fee.read');

  return withTenant(
    ctx,
    async (tx) => {
      const rows = await finance.paymentsForStudent(tx, studentId);

      return ok(
        rows.map((r) => ({
          id: r.id,
          receiptNo: Number(r.receiptNo),
          amountMinor: r.amountMinor.toString(),
          channel: r.channel,
          channelRef: r.channelRef,
          collectedAt: LocalDate.toISO(LocalDate.fromInstant(r.collectedAt)),
          recordedAt: r.recordedAt.toISOString(),
          reversesPaymentId: r.reversesPaymentId,
          reversedByPaymentId: r.reversedByPaymentId,
          reversalReason: r.reversalReason,
        })),
      );
    },
    { readOnly: true },
  );
}
