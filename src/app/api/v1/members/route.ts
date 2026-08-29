/** GET /api/v1/members — who works here, and what each of them may do. */
import { listMembers } from '../../../../modules/identity/index';
import { authedRead } from '../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead((ctx) => listMembers(ctx));
