/**
 * GET /api/v1/merges
 *
 * The merges already made, newest first — what can still be reversed. A
 * reversal that is only reachable from the response that performed the merge
 * keeps its promise for nobody but the person who ran it.
 */
import { listMerges } from '../../../../modules/directory/index';
import { authedRead } from '../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead((ctx, _params, req) => {
  const raw = Number(new URL(req.url).searchParams.get('limit'));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : undefined;
  return listMerges(ctx, { limit });
});
