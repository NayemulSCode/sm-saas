/** GET /api/v1/structure — the whole shape of a school, in one read. */
import { getStructure } from '../../../../modules/structure/index';
import type { SchoolId } from '../../../../shared/ids';
import { authedRead } from '../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead(async (ctx, _params, req) => {
  // Most tenants have one school, so the id is optional: the caller should not
  // need to know it to ask what the school looks like.
  const schoolId = new URL(req.url).searchParams.get('schoolId');
  return getStructure(ctx, (schoolId ?? undefined) as SchoolId | undefined);
});
