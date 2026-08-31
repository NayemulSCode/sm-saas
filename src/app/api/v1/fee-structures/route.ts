/**
 * GET/POST /api/v1/fee-structures — price by class, optionally narrowed to a
 * section. §13.1, §13.7.
 */
import type { NextRequest } from 'next/server';
import {
  createFeeStructure,
  listFeeStructures,
  CreateFeeStructureSchema,
} from '../../../../modules/finance/index';
import type {
  AcademicYearId,
  ClassLevelId,
  FeeHeadId,
  SectionId,
} from '../../../../shared/ids';
import { authed, authedRead } from '../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead((ctx, _params, req: NextRequest) => {
  const q = new URL(req.url).searchParams;
  const academicYearId = q.get('academicYearId');
  return listFeeStructures(ctx, {
    ...(academicYearId ? { academicYearId: academicYearId as AcademicYearId } : {}),
  });
});

export const POST = authed(
  CreateFeeStructureSchema,
  (ctx, input) =>
    createFeeStructure(ctx, {
      academicYearId: input.academicYearId as AcademicYearId,
      feeHeadId: input.feeHeadId as FeeHeadId,
      ...(input.classLevelId !== undefined
        ? { classLevelId: input.classLevelId as ClassLevelId }
        : {}),
      ...(input.sectionId !== undefined ? { sectionId: input.sectionId as SectionId } : {}),
      amountMinor: input.amountMinor,
      dueDay: input.dueDay,
    }),
  { status: 201 },
);
