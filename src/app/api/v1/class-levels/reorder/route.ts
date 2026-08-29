/**
 * POST /api/v1/class-levels/reorder
 *
 * `sequence` drives promotion, so this is a structural change to what "the next
 * class up" means — not a display preference. Blocked once a cohort is enrolled.
 */
import {
  reorderClassLevels,
  ReorderClassLevelsSchema,
} from '../../../../../modules/structure/index';
import type { ClassLevelId, SchoolId } from '../../../../../shared/ids';
import { authed } from '../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed(ReorderClassLevelsSchema, (ctx, input) =>
  reorderClassLevels(ctx, {
    schoolId: input.schoolId as SchoolId,
    orderedIds: input.orderedIds as ClassLevelId[],
    reason: input.reason,
  }),
);
