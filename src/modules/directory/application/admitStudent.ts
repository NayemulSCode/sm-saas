/**
 * Admit a student. §14.5.
 *
 * "Creates person + student + first enrolment + status event in one
 * transaction." A person with no student row is an orphan nobody finds; a
 * student with no enrolment is on no class list. Both are the kind of
 * half-state that gets discovered in week three by a teacher.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { LocalDate, systemClock, type Clock } from '../../../shared/date';
import type {
  AcademicYearId,
  EnrolmentId,
  PersonId,
  SchoolId,
  SectionId,
  StudentId,
} from '../../../shared/ids';
import { DEFAULT_PATTERN, renderCode, sequenceOf, validatePattern } from '../domain/studentCode';
import { directory } from '../infrastructure/repositories';

export const AdmissionErrors = defineErrors({
  SECTION_NOT_FOUND: {
    code: 'SECTION_NOT_FOUND',
    messageKey: 'directory.error.sectionNotFound',
    httpStatus: 404,
  },
  INVALID_CODE_PATTERN: {
    code: 'INVALID_CODE_PATTERN',
    messageKey: 'directory.error.invalidCodePattern',
    httpStatus: 400,
  },
  INVALID_ADMISSION_DATE: {
    code: 'INVALID_ADMISSION_DATE',
    messageKey: 'directory.error.invalidAdmissionDate',
    httpStatus: 400,
  },
  STUDENT_NOT_FOUND: {
    code: 'STUDENT_NOT_FOUND',
    messageKey: 'directory.error.studentNotFound',
    httpStatus: 404,
  },
  PERSON_NOT_FOUND: {
    code: 'PERSON_NOT_FOUND',
    messageKey: 'directory.error.personNotFound',
    httpStatus: 404,
  },
});

export interface AdmitStudentInput {
  schoolId: SchoolId;
  sectionId: SectionId;
  academicYearId: AcademicYearId;
  nameBn: string;
  nameEn: string;
  dateOfBirth?: string | undefined;
  gender?: 'male' | 'female' | 'other' | undefined;
  /** CONTACT detail, not a login. A child may share a parent's handset. */
  phone?: string | undefined;
  rollNo?: number | undefined;
  admittedOn?: string | undefined;
  /** Overrides the school default. Validated before anything is written. */
  codePattern?: string | undefined;
}

export interface AdmitStudentResult {
  studentId: StudentId;
  personId: PersonId;
  enrolmentId: EnrolmentId;
  studentCode: string;
}

export async function admitStudent(
  ctx: AuthContext,
  input: AdmitStudentInput,
  deps: { clock?: Clock } = {},
): Promise<Result<AdmitStudentResult, DomainError>> {
  authorize(ctx, 'student.write');

  const pattern = input.codePattern ?? DEFAULT_PATTERN;
  const problem = validatePattern(pattern);
  if (problem) return err(AdmissionErrors.INVALID_CODE_PATTERN);

  const today = LocalDate.today(deps.clock ?? systemClock);
  let admittedOn = today;
  if (input.admittedOn !== undefined) {
    const parsed = LocalDate.parse(input.admittedOn);
    if (!parsed.ok) return err(AdmissionErrors.INVALID_ADMISSION_DATE);
    admittedOn = parsed.value;
  }

  let dob: LocalDate | undefined;
  if (input.dateOfBirth !== undefined) {
    const parsed = LocalDate.parse(input.dateOfBirth);
    if (!parsed.ok) return err(AdmissionErrors.INVALID_ADMISSION_DATE);
    dob = parsed.value;
  }

  return withTenant(ctx, async (tx) => {
    if (!(await directory.sectionInSchool(tx, input.sectionId, input.schoolId))) {
      return err(AdmissionErrors.SECTION_NOT_FOUND);
    }

    const personId = await directory.createPerson(tx, {
      nameBn: input.nameBn,
      nameEn: input.nameEn,
      dateOfBirth: dob,
      gender: input.gender,
      phone: input.phone,
      actorId: ctx.personId,
    });

    /*
     * The advisory lock inside `nextCodeSequence` is what makes two counters
     * admitting at once safe. Without it both read the same maximum and the
     * second insert fails on the unique constraint, in front of a parent.
     */
    const sequence = await directory.nextCodeSequence(
      tx,
      ctx.activeTenantId,
      admittedOn.y,
      (codes) => {
        const used = codes
          .map((c) => sequenceOf(pattern, admittedOn.y, c))
          .filter((n): n is number => n !== undefined);
        return used.length === 0 ? 1 : Math.max(...used) + 1;
      },
    );
    const studentCode = renderCode(pattern, admittedOn.y, sequence);

    const studentId = await directory.createStudent(tx, {
      personId,
      studentCode,
      // Admission through this path means they are attending, not applying.
      status: 'active',
      admittedOn,
      actorId: ctx.personId,
    });

    // The lifecycle starts recorded, so the history is complete from row one
    // rather than starting at the first change.
    await directory.recordStatusEvent(tx, {
      studentId,
      from: null,
      to: 'active',
      effectiveDate: admittedOn,
      actorId: ctx.personId,
    });

    const enrolmentId = await directory.createEnrolment(tx, {
      studentId,
      sectionId: input.sectionId,
      academicYearId: input.academicYearId,
      rollNo: input.rollNo,
      enrolledOn: admittedOn,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'student.admitted', studentId, {
      entityType: 'student',
      after: {
        studentId,
        personId,
        enrolmentId,
        sectionId: input.sectionId,
        academicYearId: input.academicYearId,
        // A student code is a school-visible identifier, not personal data —
        // it is on the ID card. The name and phone are not recorded.
        studentCode: fact(studentCode),
        admittedOn: fact(LocalDate.toISO(admittedOn)),
      },
    });

    return ok({ studentId, personId, enrolmentId, studentCode });
  });
}
