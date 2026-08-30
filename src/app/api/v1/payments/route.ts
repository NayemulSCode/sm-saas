/**
 * POST /api/v1/payments — record a payment with a gapless receipt. §13.3–13.4.
 *
 * The one endpoint this whole slice exists to make trustworthy: a retried
 * request with the same idempotency key replays the original receipt rather
 * than issuing a second one or double-charging.
 */
import { recordPayment, RecordPaymentSchema } from '../../../../modules/finance/index';
import type { SchoolId, StudentId } from '../../../../shared/ids';
import { authed } from '../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed(
  RecordPaymentSchema,
  (ctx, input) =>
    recordPayment(ctx, {
      schoolId: input.schoolId as SchoolId,
      studentId: input.studentId as StudentId,
      amountMinor: BigInt(input.amountMinor),
      channel: input.channel,
      ...(input.channelRef ? { channelRef: input.channelRef } : {}),
      collectedAt: input.collectedAt,
      idempotencyKey: input.idempotencyKey,
      allocation:
        input.allocation.mode === 'manual'
          ? {
              mode: 'manual',
              lines: input.allocation.lines.map((l) => ({
                invoiceLineId: l.invoiceLineId,
                amountMinor: BigInt(l.amountMinor),
              })),
            }
          : { mode: 'auto' },
    }),
  { status: 201 },
);
