/**
 * POST /api/v1/students/:id/transition
 *
 * Only legal moves. The CHECK constraint says which values exist; it says
 * nothing about which transitions are legal, and active → applicant is
 * representable in SQL while being nonsense in a school.
 */
import {
  transitionStudentStatus,
  TransitionStudentSchema,
} from '../../../../../../modules/directory/index';
import type { StudentId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof TransitionStudentSchema.parse>,
  unknown,
  { studentId: string }
>(TransitionStudentSchema, (ctx, input, params) =>
  transitionStudentStatus(ctx, {
    studentId: params.studentId as StudentId,
    to: input.to,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.effectiveDate !== undefined ? { effectiveDate: input.effectiveDate } : {}),
  }),
);
