/** POST /api/v1/academic-years — open a year. */
import { openAcademicYear, OpenAcademicYearSchema } from '../../../../modules/structure/index';
import type { SchoolId } from '../../../../shared/ids';
import { authed } from '../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed(
  OpenAcademicYearSchema,
  (ctx, input) => openAcademicYear(ctx, { ...input, schoolId: input.schoolId as SchoolId }),
  { status: 201 },
);
