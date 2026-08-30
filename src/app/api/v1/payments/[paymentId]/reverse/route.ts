/** POST /api/v1/payments/:id/reverse — a refund. Reason required. §13.3. */
import { reversePayment, ReversePaymentSchema } from '../../../../../../modules/finance/index';
import type { PaymentId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof ReversePaymentSchema.parse>,
  { reversalPaymentId: string },
  { paymentId: string }
>(ReversePaymentSchema, (ctx, input, params) =>
  reversePayment(ctx, params.paymentId as PaymentId, input.reason),
);
