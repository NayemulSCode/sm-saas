/**
 * GET /api/v1/promotions
 *
 * The recent runs, newest first — the list of promotions that can still be
 * taken back. Guarded by `enrolment.promote` rather than a read permission:
 * deciding what to undo is its only purpose.
 */
import { listPromotionBatches } from '../../../../modules/directory/index';
import { authedRead } from '../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead((ctx, _params, req) => {
  // A junk `limit` is ignored rather than refused: it cannot produce a wrong
  // answer, only a differently sized one, and the use case clamps the range.
  const raw = Number(new URL(req.url).searchParams.get('limit'));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined;

  return listPromotionBatches(ctx, { limit });
});
