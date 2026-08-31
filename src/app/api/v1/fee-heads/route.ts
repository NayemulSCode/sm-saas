/**
 * GET/POST /api/v1/fee-heads — the priced items a school charges. §13.1, §13.7.
 */
import { createFeeHead, listFeeHeads, CreateFeeHeadSchema } from '../../../../modules/finance/index';
import { authed, authedRead } from '../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead((ctx) => listFeeHeads(ctx));

export const POST = authed(CreateFeeHeadSchema, (ctx, input) => createFeeHead(ctx, input), {
  status: 201,
});
