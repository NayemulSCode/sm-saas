/**
 * GET /api/v1/students/:id/outstanding — §13.7. Drives the collection screen.
 */
import { listOutstanding } from '../../../../../../modules/finance/index';
import type { StudentId } from '../../../../../../shared/ids';
import { authedRead } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead<unknown, { studentId: string }>((ctx, params) =>
  listOutstanding(ctx, params.studentId as StudentId),
);
