/**
 * POST /api/v1/students/:id/withdraw
 *
 * Its own route rather than a generic transition: it is the one offices perform
 * most and get asked about most. `finance` decides what happens to dues; this
 * is a lifecycle event, not a settlement.
 */
import {
  withdrawStudent,
  WithdrawStudentSchema,
} from '../../../../../../modules/directory/index';
import type { StudentId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof WithdrawStudentSchema.parse>,
  unknown,
  { studentId: string }
>(WithdrawStudentSchema, (ctx, input, params) =>
  withdrawStudent(ctx, {
    studentId: params.studentId as StudentId,
    reason: input.reason,
    ...(input.effectiveDate !== undefined ? { effectiveDate: input.effectiveDate } : {}),
  }),
);
