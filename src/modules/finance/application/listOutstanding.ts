/**
 * What a student currently owes. §13.7 — "drives the collection screen".
 *
 * Read-only, and the same repository read `recordPayment` allocates against
 * — a collector sees exactly the lines a payment could land on, in the
 * `oldest_first` order `allocatePayment`'s default policy would apply them.
 */

import { withTenant } from '../../../db/rls';
import { type Result, ok, type DomainError } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { LocalDate } from '../../../shared/date';
import type { FeeHeadId, InvoiceId, InvoiceLineId, StudentId } from '../../../shared/ids';
import { finance } from '../infrastructure/repositories';

export interface OutstandingLineView {
  invoiceLineId: InvoiceLineId;
  invoiceId: InvoiceId;
  feeHeadId: FeeHeadId;
  feeHeadName: string;
  outstandingMinor: string;
  dueDate: string;
}

export async function listOutstanding(
  ctx: AuthContext,
  studentId: StudentId,
): Promise<Result<OutstandingLineView[], DomainError>> {
  authorize(ctx, 'fee.read');

  return withTenant(
    ctx,
    async (tx) => {
      const [lines, heads] = await Promise.all([
        finance.outstandingLinesFor(tx, studentId),
        finance.listFeeHeads(tx),
      ]);
      const nameByHead = new Map(heads.map((h) => [h.id, h.nameEn]));

      const sorted = [...lines].sort((a, b) => {
        const byDate = LocalDate.compare(a.dueDate, b.dueDate);
        return byDate !== 0 ? byDate : a.feeHeadSequence - b.feeHeadSequence;
      });

      return ok(
        sorted.map((l) => ({
          invoiceLineId: l.invoiceLineId,
          invoiceId: l.invoiceId,
          feeHeadId: l.feeHeadId,
          feeHeadName: nameByHead.get(l.feeHeadId) ?? '',
          outstandingMinor: l.outstandingMinor.toString(),
          dueDate: LocalDate.toISO(l.dueDate),
        })),
      );
    },
    { readOnly: true },
  );
}
