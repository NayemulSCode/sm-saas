/**
 * POST /api/v1/payments/:id/reverse — §13.3, §13.7. `fee.refund`, reason
 * required. Refunds are reversing rows, never deletes — the original
 * receipt number stays consumed.
 */
import { reversePayment, ReversePaymentSchema } from '../../../../../../modules/finance/index';
import type { PaymentId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof ReversePaymentSchema.parse>,
  unknown,
  { paymentId: string }
>(ReversePaymentSchema, (ctx, input, params) =>
  reversePayment(ctx, {
    paymentId: params.paymentId as PaymentId,
    reason: input.reason,
    ...(input.collectedAt !== undefined ? { collectedAt: input.collectedAt } : {}),
  }),
);
