/**
 * Reading a student. The screen an office assistant has open all day.
 */

import { withTenant } from '../../../db/rls';
import { type Result, ok, err, type DomainError } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { StudentId } from '../../../shared/ids';
import { directory } from '../infrastructure/repositories';
import { AdmissionErrors } from './admitStudent';

export async function getStudent(
  ctx: AuthContext,
  studentId: StudentId,
): Promise<Result<unknown, DomainError>> {
  authorize(ctx, 'student.read');

  return withTenant(
    ctx,
    async (tx) => {
      const found = await directory.studentById(tx, studentId);
      if (!found) return err(AdmissionErrors.STUDENT_NOT_FOUND);

      const [enrolments, guardians, history] = await Promise.all([
        directory.enrolmentsFor(tx, studentId),
        directory.linksFor(tx, studentId),
        directory.statusHistory(tx, studentId),
      ]);

      return ok({ student: found, enrolments, guardians, history });
    },
    { readOnly: true },
  );
}
