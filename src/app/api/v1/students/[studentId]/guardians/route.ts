/**
 * POST /api/v1/students/:id/guardians
 *
 * At most one billing guardian and one primary contact per student. The
 * incumbent is demoted in the same transaction, so the student is never
 * briefly unbilled.
 */
import { linkGuardian, LinkGuardianSchema } from '../../../../../../modules/directory/index';
import type { PersonId, StudentId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof LinkGuardianSchema.parse>,
  unknown,
  { studentId: string }
>(
  LinkGuardianSchema,
  (ctx, input, params) =>
    linkGuardian(ctx, {
      studentId: params.studentId as StudentId,
      ...(input.guardianPersonId !== undefined
        ? { guardianPersonId: input.guardianPersonId as PersonId }
        : {}),
      ...(input.person !== undefined ? { person: input.person } : {}),
      relationship: input.relationship,
      isBillingGuardian: input.isBillingGuardian,
      isPrimaryContact: input.isPrimaryContact,
      canReceiveResults: input.canReceiveResults,
      canCollectStudent: input.canCollectStudent,
    }),
  { status: 201 },
);
