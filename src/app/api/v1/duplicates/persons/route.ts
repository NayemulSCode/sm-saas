/**
 * GET /api/v1/duplicates/persons
 *
 * Proposed duplicate pairs with the evidence that proposed each one, and what
 * each side would carry. It decides nothing — the winner is whichever id the
 * caller later puts in the merge path.
 */
import { reviewDuplicates } from '../../../../../modules/directory/index';
import { authedRead } from '../../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead((ctx, _params, req) => {
  const raw = Number(new URL(req.url).searchParams.get('limit'));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined;
  return reviewDuplicates(ctx, { limit });
});
