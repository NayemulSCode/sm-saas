/**
 * GET/POST /api/v1/fee-structures — price by class, optionally narrowed to a
 * section. §13.1. GET takes `academicYearId` as a query param, not a path
 * segment: it filters a collection rather than naming one resource.
 */
import { createFeeStructure, listFeeStructures, CreateFeeStructureSchema } from '../../../../modules/finance/index';
import type { AcademicYearId, ClassLevelId, FeeHeadId, SectionId } from '../../../../shared/ids';
import { zUlid } from '../../../../shared/api/primitives';
import { CommonErrors, err } from '../../../../shared/result';
import { authed, authedRead } from '../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead(async (ctx, _params, req) => {
  const parsed = zUlid().safeParse(req.nextUrl.searchParams.get('academicYearId'));
  if (!parsed.success) return err(CommonErrors.VALIDATION_FAILED);
  return listFeeStructures(ctx, parsed.data as AcademicYearId);
});

export const POST = authed(
  CreateFeeStructureSchema,
  (ctx, input) =>
    createFeeStructure(ctx, {
      academicYearId: input.academicYearId as AcademicYearId,
      feeHeadId: input.feeHeadId as FeeHeadId,
      ...(input.classLevelId ? { classLevelId: input.classLevelId as ClassLevelId } : {}),
      ...(input.sectionId ? { sectionId: input.sectionId as SectionId } : {}),
      amountMinor: BigInt(input.amountMinor),
      ...(input.dueDay !== undefined ? { dueDay: input.dueDay } : {}),
    }),
  { status: 201 },
);
