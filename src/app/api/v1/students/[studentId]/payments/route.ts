/**
 * GET /api/v1/students/:id/payments — §13.3, §13.7. Drives the reversal screen.
 */
import { listPaymentsForStudent } from '../../../../../../modules/finance/index';
import type { StudentId } from '../../../../../../shared/ids';
import { authedRead } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead<unknown, { studentId: string }>((ctx, params) =>
  listPaymentsForStudent(ctx, params.studentId as StudentId),
);
