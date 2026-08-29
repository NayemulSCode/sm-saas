/**
 * POST /api/v1/students
 *
 * Creates person + student + first enrolment + status event in one transaction.
 */
import { admitStudent, AdmitStudentSchema } from '../../../../modules/directory/index';
import type { AcademicYearId, SchoolId, SectionId } from '../../../../shared/ids';
import { authed } from '../../_lib/handler';
import { listStudentsHandler } from './list';

export const runtime = 'nodejs';

/**
 * GET /api/v1/students
 *
 * Keyset paginated, scope narrowed IN SQL. A class teacher scoped to two
 * sections receives two sections' worth of rows, not the school with the rest
 * hidden by the client.
 */
export const GET = listStudentsHandler;

export const POST = authed(
  AdmitStudentSchema,
  (ctx, input) =>
    admitStudent(ctx, {
      schoolId: input.schoolId as SchoolId,
      sectionId: input.sectionId as SectionId,
      academicYearId: input.academicYearId as AcademicYearId,
      nameBn: input.nameBn,
      nameEn: input.nameEn,
      ...(input.dateOfBirth !== undefined ? { dateOfBirth: input.dateOfBirth } : {}),
      ...(input.gender !== undefined ? { gender: input.gender } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.rollNo !== undefined ? { rollNo: input.rollNo } : {}),
      ...(input.admittedOn !== undefined ? { admittedOn: input.admittedOn } : {}),
    }),
  { status: 201 },
);
