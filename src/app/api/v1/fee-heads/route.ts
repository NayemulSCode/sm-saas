/** GET/POST /api/v1/fee-heads — what a school charges for. §13.1. */
import { createFeeHead, listFeeHeads, CreateFeeHeadSchema } from '../../../../modules/finance/index';
import { authed, authedRead } from '../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead(async (ctx) => listFeeHeads(ctx));

export const POST = authed(CreateFeeHeadSchema, (ctx, input) => createFeeHead(ctx, input), {
  status: 201,
});
