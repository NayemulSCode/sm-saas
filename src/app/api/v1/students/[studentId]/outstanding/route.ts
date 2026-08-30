/** GET /api/v1/students/:id/outstanding — aged outstanding lines. §13.7. */
import { getOutstanding } from '../../../../../../modules/finance/index';
import type { StudentId } from '../../../../../../shared/ids';
import { authedRead } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead<unknown, { studentId: string }>((ctx, params) =>
  getOutstanding(ctx, params.studentId as StudentId),
);
