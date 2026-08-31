/**
 * POST /api/v1/discounts/:id/approve — §13.7. `fee.waive`: the principal
 * alone, per the permission matrix. Collect / waive / refund stay separate.
 */
import { approveDiscount, ApproveDiscountSchema } from '../../../../../../modules/finance/index';
import type { DiscountId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof ApproveDiscountSchema.parse>,
  unknown,
  { discountId: string }
>(ApproveDiscountSchema, (ctx, input, params) =>
  approveDiscount(ctx, {
    discountId: params.discountId as DiscountId,
    reason: input.reason,
  }),
);
