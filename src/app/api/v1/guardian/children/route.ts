/**
 * GET /api/v1/guardian/children
 *
 * The caller's own children — never a student id in the path or the query
 * string. `listMyChildren` derives the entire result from `ctx.personId`;
 * there is nothing here for a guardian to tamper with to see a different
 * family (see the use case's docstring).
 */
import { listMyChildren } from '../../../../../modules/directory/index';
import { authedRead } from '../../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead((ctx) => listMyChildren(ctx));
