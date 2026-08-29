/** GET /api/v1/roles — what each role confers, for the grant screen. */
import { listRoles } from '../../../../modules/identity/index';
import { authedRead } from '../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead((ctx) => listRoles(ctx));
