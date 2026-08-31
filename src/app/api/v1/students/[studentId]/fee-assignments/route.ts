/**
 * GET/POST /api/v1/students/:id/fee-assignments
 *
 * A per-student override that beats `fee_structure` — a scholarship, or a
 * corrected amount for one student. Not in §13.7's contract table; built
 * anyway because the table otherwise has no write path except a hand-run
 * `INSERT` (see `modules/finance/application/feeAssignments.ts`).
 */
import type { NextRequest } from 'next/server';
import {
  createFeeAssignment,
  listFeeAssignments,
  CreateFeeAssignmentSchema,
} from '../../../../../../modules/finance/index';
import type { AcademicYearId, FeeHeadId, StudentId } from '../../../../../../shared/ids';
import { authed, authedRead } from '../../../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead<unknown, { studentId: string }>((ctx, params, _req: NextRequest) =>
  listFeeAssignments(ctx, { studentId: params.studentId as StudentId }),
);

export const POST = authed<
  ReturnType<typeof CreateFeeAssignmentSchema.parse>,
  unknown,
  { studentId: string }
>(
  CreateFeeAssignmentSchema,
  (ctx, input, params) =>
    createFeeAssignment(ctx, {
      studentId: params.studentId as StudentId,
      feeHeadId: input.feeHeadId as FeeHeadId,
      academicYearId: input.academicYearId as AcademicYearId,
      amountMinor: input.amountMinor,
      reason: input.reason,
    }),
  { status: 201 },
);
