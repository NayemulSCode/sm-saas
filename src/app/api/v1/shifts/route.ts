/**
 * POST /api/v1/shifts
 *
 * Provisioning creates one day shift. A school running morning and day adds the
 * second here, deliberately: a shift brings its own timetable and working-day
 * calendar, and an unused one sits empty looking like a bug.
 */
import { createShift, CreateShiftSchema } from '../../../../modules/structure/index';
import type { CampusId } from '../../../../shared/ids';
import { authed } from '../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed(
  CreateShiftSchema,
  (ctx, input) => createShift(ctx, { ...input, campusId: input.campusId as CampusId }),
  { status: 201 },
);
