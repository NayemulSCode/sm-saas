/**
 * POST /api/v1/payments — §13.3, §13.4, §13.7. Idempotency-Key required.
 */
import { recordPayment, RecordPaymentSchema } from '../../../../modules/finance/index';
import type { StudentId } from '../../../../shared/ids';
import { authedIdempotent } from '../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authedIdempotent(
  RecordPaymentSchema,
  (ctx, input, idempotencyKey) =>
    recordPayment(
      ctx,
      {
        studentId: input.studentId as StudentId,
        amountMinor: input.amountMinor,
        channel: input.channel,
        ...(input.channelRef !== undefined ? { channelRef: input.channelRef } : {}),
        collectedAt: input.collectedAt,
        allocation: input.allocation,
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      idempotencyKey,
    ),
  { status: 201 },
);
