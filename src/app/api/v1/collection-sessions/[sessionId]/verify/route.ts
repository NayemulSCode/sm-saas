/**
 * POST /api/v1/collection-sessions/:id/verify — §13.3, §13.7. `fee.reconcile`
 * — separate from `fee.collect`, so the person who counted the drawer is not
 * the same person who confirms the deposit matches it.
 */
import {
  verifyCollectionSession,
  VerifyCollectionSessionSchema,
} from '../../../../../../modules/finance/index';
import type { CollectionSessionId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof VerifyCollectionSessionSchema.parse>,
  unknown,
  { sessionId: string }
>(VerifyCollectionSessionSchema, (ctx, input, params) =>
  verifyCollectionSession(ctx, {
    sessionId: params.sessionId as CollectionSessionId,
    ...(input.depositReference !== undefined ? { depositReference: input.depositReference } : {}),
  }),
);
