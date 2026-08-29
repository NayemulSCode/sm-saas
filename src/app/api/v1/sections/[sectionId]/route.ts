/** PATCH /api/v1/sections/:id */
import { updateSection, UpdateSectionSchema } from '../../../../../modules/structure/index';
import type { SectionId, StaffId } from '../../../../../shared/ids';
import { authed } from '../../../_lib/handler';

export const runtime = 'nodejs';

export const PATCH = authed<
  ReturnType<typeof UpdateSectionSchema.parse>,
  { updated: boolean },
  { sectionId: string }
>(UpdateSectionSchema, (ctx, input, params) =>
  updateSection(ctx, {
    sectionId: params.sectionId as SectionId,
    ...(input.nameBn !== undefined ? { nameBn: input.nameBn } : {}),
    ...(input.nameEn !== undefined ? { nameEn: input.nameEn } : {}),
    ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
    ...(input.classTeacherId !== undefined
      ? { classTeacherId: input.classTeacherId as StaffId | null }
      : {}),
  }),
);
