/**
 * POST /api/v1/students/:id/guardians/unlink
 *
 * Refused for the last guardian: a student nobody can contact is unreachable,
 * and the consequence appears weeks later looking like broken SMS.
 */
import {
  unlinkGuardian,
  UnlinkGuardianSchema,
} from '../../../../../../../modules/directory/index';
import type { PersonId, StudentId } from '../../../../../../../shared/ids';
import { authed } from '../../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof UnlinkGuardianSchema.parse>,
  unknown,
  { studentId: string }
>(UnlinkGuardianSchema, (ctx, input, params) =>
  unlinkGuardian(ctx, {
    studentId: params.studentId as StudentId,
    guardianPersonId: input.guardianPersonId as PersonId,
    reason: input.reason,
  }),
);
