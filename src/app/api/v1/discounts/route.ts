/**
 * GET/POST /api/v1/discounts — §13.7. Creating one only needs `fee.read`: it
 * always lands `pending`, and nothing it does is real until it is approved.
 */
import type { NextRequest } from 'next/server';
import { createDiscount, listDiscounts, CreateDiscountSchema } from '../../../../modules/finance/index';
import type { FeeHeadId, StudentId } from '../../../../shared/ids';
import { authed, authedRead } from '../../_lib/handler';

export const runtime = 'nodejs';

export const GET = authedRead((ctx, _params, req: NextRequest) => {
  const q = new URL(req.url).searchParams;
  const studentId = q.get('studentId');
  return listDiscounts(ctx, { ...(studentId ? { studentId: studentId as StudentId } : {}) });
});

export const POST = authed(
  CreateDiscountSchema,
  (ctx, input) =>
    createDiscount(ctx, {
      studentId: input.studentId as StudentId,
      ...(input.feeHeadId !== undefined ? { feeHeadId: input.feeHeadId as FeeHeadId } : {}),
      kind: input.kind,
      ...(input.valueMinor !== undefined ? { valueMinor: input.valueMinor } : {}),
      ...(input.percent !== undefined ? { percent: input.percent } : {}),
      validFrom: input.validFrom,
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      reason: input.reason,
    }),
  { status: 201 },
);
