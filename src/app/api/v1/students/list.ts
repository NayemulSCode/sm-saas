/**
 * The GET half of /api/v1/students.
 *
 * A separate file only because `route.ts` already exports POST, and keeping the
 * query-string parsing beside the handler that uses it reads better than an
 * inline block in the middle of a route file.
 */

import type { NextRequest } from 'next/server';
import { listStudents } from '../../../../modules/directory/index';
import type { AcademicYearId, SectionId } from '../../../../shared/ids';
import type { StudentStatus } from '../../../../modules/directory/index';
import { authedRead } from '../../_lib/handler';

const STATUSES = new Set<string>([
  'applicant',
  'admitted',
  'active',
  'on_leave',
  'withdrawn',
  'alumni',
]);

export const listStudentsHandler = authedRead((ctx, _params, req: NextRequest) => {
  const q = new URL(req.url).searchParams;

  const status = q.get('status');
  const limit = Number(q.get('limit'));

  return listStudents(ctx, {
    ...(q.get('sectionId') ? { sectionId: q.get('sectionId') as SectionId } : {}),
    ...(q.get('academicYearId')
      ? { academicYearId: q.get('academicYearId') as AcademicYearId }
      : {}),
    // An unrecognised status is ignored rather than rejected: it arrives from a
    // bookmarked URL as often as from a client, and dropping the filter shows
    // more than intended rather than less.
    ...(status && STATUSES.has(status) ? { status: status as StudentStatus } : {}),
    ...(q.get('search') ? { search: q.get('search')! } : {}),
    ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    ...(q.get('cursor') ? { cursor: q.get('cursor')! } : {}),
  });
});
