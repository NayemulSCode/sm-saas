/**
 * POST /api/v1/collection-sessions — §13.3, §13.7. Opens today's session for
 * the caller.
 */
import { openCollectionSession, OpenCollectionSessionSchema } from '../../../../modules/finance/index';
import type { SchoolId } from '../../../../shared/ids';
import { authed } from '../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed(
  OpenCollectionSessionSchema,
  (ctx, input) => openCollectionSession(ctx, { schoolId: input.schoolId as SchoolId }),
  { status: 201 },
);
