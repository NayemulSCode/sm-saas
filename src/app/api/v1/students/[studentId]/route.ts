/** GET /api/v1/students/:id — the screen an office assistant has open all day. */
import { getStudent } from '../../../../../modules/directory/index';
import type { StudentId } from '../../../../../shared/ids';
import { authed, authedRead } from '../../../_lib/handler';
import { updateStudent, UpdateStudentSchema } from '../../../../../modules/directory/index';

export const runtime = 'nodejs';

export const GET = authedRead<unknown, { studentId: string }>((ctx, params) =>
  getStudent(ctx, params.studentId as StudentId),
);

/**
 * PATCH /api/v1/students/:id
 *
 * Takes `version` for optimistic locking. A mismatch is 409
 * CONCURRENT_MODIFICATION — two people correcting the same record at one
 * counter is not hypothetical, and last-write-wins discards one of them.
 */
export const PATCH = authed<
  ReturnType<typeof UpdateStudentSchema.parse>,
  { version: number },
  { studentId: string }
>(UpdateStudentSchema, (ctx, input, params) =>
  updateStudent(ctx, { ...input, studentId: params.studentId as StudentId }),
);
