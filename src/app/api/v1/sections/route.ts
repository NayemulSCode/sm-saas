/** POST /api/v1/sections */
import { createSection, CreateSectionSchema } from '../../../../modules/structure/index';
import type {
  CampusId,
  ClassLevelId,
  SchoolId,
  ShiftId,
  StaffId,
} from '../../../../shared/ids';
import { authed } from '../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed(
  CreateSectionSchema,
  (ctx, input) =>
    createSection(ctx, {
      schoolId: input.schoolId as SchoolId,
      classLevelId: input.classLevelId as ClassLevelId,
      campusId: input.campusId as CampusId,
      shiftId: input.shiftId as ShiftId,
      nameBn: input.nameBn,
      nameEn: input.nameEn,
      ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
      ...(input.classTeacherId !== undefined
        ? { classTeacherId: input.classTeacherId as StaffId }
        : {}),
    }),
  { status: 201 },
);
