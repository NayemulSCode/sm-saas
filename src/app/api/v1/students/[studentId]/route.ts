/** GET /api/v1/students/:id — the screen an office assistant has open all day. */
import { getStudent } from '../../../../../modules/directory/index';
import type { StudentId } from '../../../../../shared/ids';
import { authedRead } from '../../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead<unknown, { studentId: string }>((ctx, params) =>
  getStudent(ctx, params.studentId as StudentId),
);
