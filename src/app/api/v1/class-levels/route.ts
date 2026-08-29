/** POST /api/v1/class-levels — add a class to the ladder. */
import { createClassLevel, CreateClassLevelSchema } from '../../../../modules/structure/index';
import type { SchoolId } from '../../../../shared/ids';
import { authed } from '../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed(
  CreateClassLevelSchema,
  (ctx, input) => createClassLevel(ctx, { ...input, schoolId: input.schoolId as SchoolId }),
  { status: 201 },
);
