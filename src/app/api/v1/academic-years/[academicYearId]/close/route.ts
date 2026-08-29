/**
 * POST /api/v1/academic-years/:id/close
 *
 * Refused while the year is still current: open its successor first, which
 * flips is_current, then close this one. That sequencing is why a school can
 * never end up with no current year.
 */
import {
  closeAcademicYear,
  CloseAcademicYearSchema,
} from '../../../../../../modules/structure/index';
import type { AcademicYearId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<{ reason: string }, { closed: boolean }, { academicYearId: string }>(
  CloseAcademicYearSchema,
  (ctx, input, params) =>
    closeAcademicYear(ctx, {
      academicYearId: params.academicYearId as AcademicYearId,
      reason: input.reason,
    }),
);
