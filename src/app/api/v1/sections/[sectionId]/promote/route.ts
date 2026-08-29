/**
 * POST /api/v1/sections/:id/promote
 *
 * The riskiest bulk operation in the product (§14.5). Returns the batch id,
 * which is what `/promotions/:batchId/undo` needs.
 */
import { promoteSection, PromoteSectionSchema } from '../../../../../../modules/directory/index';
import type { AcademicYearId, SectionId } from '../../../../../../shared/ids';
import { authed } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const POST = authed<
  ReturnType<typeof PromoteSectionSchema.parse>,
  unknown,
  { sectionId: string }
>(PromoteSectionSchema, (ctx, input, params) =>
  promoteSection(ctx, {
    sourceSectionId: params.sectionId as SectionId,
    fromYearId: input.fromYearId as AcademicYearId,
    toYearId: input.toYearId as AcademicYearId,
    targetSectionId: input.targetSectionId as SectionId,
    ...(input.retainSectionId !== undefined
      ? { retainSectionId: input.retainSectionId as SectionId }
      : {}),
    defaultOutcome: input.defaultOutcome,
    exceptions: input.exceptions,
    reason: input.reason,
  }),
);
