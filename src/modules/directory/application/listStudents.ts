/**
 * The student list. §10.5.
 *
 * The screen a school actually looks at, and the one that decides whether the
 * product feels usable. Three things it has to get right:
 *
 * SCOPE IS APPLIED IN SQL, never by filtering in JavaScript (§8.5). A class
 * teacher scoped to two sections must not receive the whole school and have the
 * rest hidden by the client — that is the classic leak where the data is on the
 * wire and only the rendering is restricted.
 *
 * KEYSET, not offset. Somebody working through a list while admissions continue
 * would otherwise skip a child.
 *
 * The COUNT is deliberately absent. "Showing 25 of 1,847" costs a second scan
 * of the same predicate on every page, and nobody working through a list needs
 * the total — they need the next page.
 */

import { withTenantReadonly } from '../../../db/rls';
import { type Result, ok, type DomainError } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { decodeCursor, toPage, type Page } from '../../../shared/keyset';
import type { AcademicYearId, SectionId, StudentId } from '../../../shared/ids';
import type { StudentStatus } from '../domain/studentStatus';
import { directory } from '../infrastructure/repositories';

export interface ListStudentsInput {
  sectionId?: SectionId | undefined;
  academicYearId?: AcademicYearId | undefined;
  status?: StudentStatus | undefined;
  /** Matches a name in either script, or a student code. */
  search?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface StudentRow {
  id: StudentId;
  studentCode: string;
  nameBn: string;
  nameEn: string;
  status: StudentStatus;
  rollNo: number | null;
  sectionId: SectionId | null;
  sectionNameEn: string | null;
  classNameEn: string | null;
}

export async function listStudents(
  ctx: AuthContext,
  input: ListStudentsInput = {},
): Promise<Result<Page<StudentRow>, DomainError>> {
  authorize(ctx, 'student.read');

  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const cursor = decodeCursor(input.cursor);

  return withTenantReadonly(ctx, async (tx) => {
    // One extra row answers "is there more?" without a second count.
    const rows = await directory.searchStudents(tx, ctx, {
      // Spread field by field: `input.cursor` is the RAW string from the query
      // string, and spreading it would quietly shadow the decoded one.
      ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
      ...(input.academicYearId !== undefined ? { academicYearId: input.academicYearId } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.search !== undefined ? { search: input.search } : {}),
      limit: limit + 1,
      ...(cursor ? { cursor } : {}),
    });

    return ok(
      toPage(rows, limit, (r) => ({
        // Sorted by id, which is a ULID and therefore already in admission
        // order — newest first, with no second column to tie-break on.
        sort: r.id,
        id: r.id,
      })),
    );
  });
}
