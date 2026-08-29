/**
 * POST /api/v1/promotions/:batchId/undo
 *
 * "Undo the promotion, we ran it on the wrong section." Removes exactly the
 * enrolments that batch created — found by batch id, never by (section, year).
 */
import { undoPromotion, UndoPromotionSchema } from '../../../../../../modules/directory/index';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  { reason: string },
  { removed: number; restored: number },
  { batchId: string }
>(UndoPromotionSchema, (ctx, input, params) =>
  undoPromotion(ctx, { batchId: params.batchId, reason: input.reason }),
);
