/**
 * POST /api/v1/collection-sessions/:id/close — §13.3, §13.7. Variance
 * reason required if non-zero.
 */
import {
  closeCollectionSession,
  CloseCollectionSessionSchema,
} from '../../../../../../modules/finance/index';
import type { CollectionSessionId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof CloseCollectionSessionSchema.parse>,
  unknown,
  { sessionId: string }
>(CloseCollectionSessionSchema, (ctx, input, params) =>
  closeCollectionSession(ctx, {
    sessionId: params.sessionId as CollectionSessionId,
    countedMinor: input.countedMinor,
    ...(input.varianceReason !== undefined ? { varianceReason: input.varianceReason } : {}),
  }),
);
