/**
 * Editing a student's details. §10.5.
 *
 * OPTIMISTIC LOCKING, via `version`. Two office assistants correcting the same
 * record at the same counter is not hypothetical — one has the paper form, the
 * other has the parent on the phone — and last-write-wins silently discards
 * whichever of them saved first.
 *
 * The alternative, a row lock held across a human filling in a form, holds a
 * transaction open for minutes. A version check costs one column and turns the
 * collision into a 409 the second person can see and resolve.
 *
 * Personal details live on `person`, not `student`: the student row is the
 * school's relationship with a human, and the human is the same human whether
 * they are a student, a guardian, or both.
 */

import { withTenant } from '../../../db/rls';
import { audit } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { CommonErrors } from '../../../shared/result';
import { LocalDate } from '../../../shared/date';
import type { StudentId } from '../../../shared/ids';
import { directory } from '../infrastructure/repositories';
import { AdmissionErrors } from './admitStudent';

export const UpdateErrors = defineErrors({
  INVALID_DATE: {
    code: 'INVALID_DATE',
    messageKey: 'directory.error.invalidDate',
    httpStatus: 400,
  },
  NOTHING_TO_UPDATE: {
    code: 'NOTHING_TO_UPDATE',
    messageKey: 'directory.error.nothingToUpdate',
    httpStatus: 400,
  },
});

export interface UpdateStudentInput {
  studentId: StudentId;
  /** The version the editor was shown. A mismatch is a 409, never a silent
   *  overwrite of somebody else's correction. */
  version: number;
  nameBn?: string | undefined;
  nameEn?: string | undefined;
  dateOfBirth?: string | null | undefined;
  gender?: 'male' | 'female' | 'other' | null | undefined;
  /** CONTACT detail. The login identifier is a different column entirely. */
  phone?: string | null | undefined;
  email?: string | null | undefined;
  house?: string | null | undefined;
  religion?: string | null | undefined;
  bloodGroup?: string | null | undefined;
}

export async function updateStudent(
  ctx: AuthContext,
  input: UpdateStudentInput,
): Promise<Result<{ version: number }, DomainError>> {
  authorize(ctx, 'student.write');

  let dob: LocalDate | null | undefined;
  if (input.dateOfBirth !== undefined) {
    if (input.dateOfBirth === null) {
      dob = null;
    } else {
      const parsed = LocalDate.parse(input.dateOfBirth);
      if (!parsed.ok) return err(UpdateErrors.INVALID_DATE);
      dob = parsed.value;
    }
  }

  const personPatch = {
    ...(input.nameBn !== undefined ? { nameBn: input.nameBn } : {}),
    ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
    ...(dob !== undefined ? { dateOfBirth: dob } : {}),
    ...(input.gender !== undefined ? { gender: input.gender } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
  };
  const studentPatch = {
    ...(input.house !== undefined ? { house: input.house } : {}),
    ...(input.religion !== undefined ? { religion: input.religion } : {}),
    ...(input.bloodGroup !== undefined ? { bloodGroup: input.bloodGroup } : {}),
  };

  if (Object.keys(personPatch).length + Object.keys(studentPatch).length === 0) {
    return err(UpdateErrors.NOTHING_TO_UPDATE);
  }

  return withTenant(ctx, async (tx) => {
    const before = await directory.studentForEdit(tx, input.studentId);
    if (!before) return err(AdmissionErrors.STUDENT_NOT_FOUND);

    /*
     * The version check is on the STUDENT row and covers both tables. The
     * person row is only reachable through this student, so one version is one
     * editable record as far as an office assistant is concerned.
     */
    const bumped = await directory.updateStudentVersioned(
      tx,
      input.studentId,
      input.version,
      studentPatch,
      ctx.personId,
    );
    if (bumped === undefined) return err(CommonErrors.CONCURRENT_MODIFICATION);

    if (Object.keys(personPatch).length > 0) {
      await directory.updatePerson(tx, before.personId, personPatch, ctx.personId);
    }

    const after = await directory.studentForEdit(tx, input.studentId);

    await audit(tx, ctx, 'student.updated', input.studentId, {
      entityType: 'student',
      // Whole rows, redacted on the way in: the audit records WHICH fields
      // changed, never the names or numbers themselves (invariant 12).
      before: { ...before },
      after: { ...after },
    });

    return ok({ version: bumped });
  });
}
