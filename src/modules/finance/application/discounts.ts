/**
 * Discounts and their approval. §13.1.
 *
 * `POST /discounts` needs only `fee.read` (§13.7) — deliberately permissive,
 * because it only ever creates a `pending` row; nothing it does is real until
 * `approveDiscount` runs, which needs `fee.waive` — Principal alone, per the
 * permission matrix. The separation IS the point: an accountant can propose a
 * discount, only the principal can make it real.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { LocalDate, systemClock, type Clock } from '../../../shared/date';
import { Money } from '../../../shared/money';
import type { DiscountId, FeeHeadId, StudentId } from '../../../shared/ids';
import { finance, type DiscountRecord } from '../infrastructure/repositories';

export const DiscountErrors = defineErrors({
  STUDENT_NOT_FOUND: {
    code: 'STUDENT_NOT_FOUND',
    messageKey: 'finance.error.studentNotFound',
    httpStatus: 404,
  },
  HEAD_NOT_FOUND: {
    code: 'HEAD_NOT_FOUND',
    messageKey: 'finance.error.headNotFound',
    httpStatus: 404,
  },
  INVALID_DATE_RANGE: {
    code: 'INVALID_DATE_RANGE',
    messageKey: 'finance.error.invalidDateRange',
    httpStatus: 400,
  },
  NOT_FOUND: {
    code: 'NOT_FOUND',
    messageKey: 'finance.error.discountNotFound',
    httpStatus: 404,
  },
  /** Already approved, rejected or revoked — approval is a one-way door. */
  ALREADY_DECIDED: {
    code: 'ALREADY_DECIDED',
    messageKey: 'finance.error.discountAlreadyDecided',
    httpStatus: 409,
  },
});

export interface CreateDiscountInput {
  studentId: StudentId;
  /** Omitted = every head. */
  feeHeadId?: FeeHeadId | undefined;
  kind: 'sibling' | 'staff_child' | 'merit' | 'need' | 'other';
  /** Exactly one of these — the DTO's `.refine` is the primary guard; the SQL
   *  `CHECK` behind it is the one that cannot be bypassed. */
  valueMinor?: string | undefined;
  percent?: number | undefined;
  validFrom: string;
  validTo?: string | undefined;
  reason: string;
}

export interface DiscountRow {
  id: DiscountId;
  studentId: StudentId;
  feeHeadId: FeeHeadId | null;
  kind: 'sibling' | 'staff_child' | 'merit' | 'need' | 'other';
  valueMinor: string | null;
  percent: string | null;
  validFrom: string;
  validTo: string | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  approvedAt: string | null;
}

function toRow(r: DiscountRecord): DiscountRow {
  return {
    id: r.id,
    studentId: r.studentId,
    feeHeadId: r.feeHeadId,
    kind: r.kind,
    valueMinor: r.valueMinor === null ? null : r.valueMinor.toString(),
    percent: r.percent,
    validFrom: LocalDate.toISO(r.validFrom),
    validTo: r.validTo === null ? null : LocalDate.toISO(r.validTo),
    reason: r.reason,
    status: r.status,
    approvedAt: r.approvedAt === null ? null : r.approvedAt.toISOString(),
  };
}

export async function createDiscount(
  ctx: AuthContext,
  input: CreateDiscountInput,
): Promise<Result<{ discountId: DiscountId }, DomainError>> {
  authorize(ctx, 'fee.read');

  const validFrom = LocalDate.parse(input.validFrom);
  if (!validFrom.ok) return err(DiscountErrors.INVALID_DATE_RANGE);
  const validTo = input.validTo === undefined ? undefined : LocalDate.parse(input.validTo);
  if (validTo !== undefined && !validTo.ok) return err(DiscountErrors.INVALID_DATE_RANGE);
  if (validTo?.ok && LocalDate.compare(validFrom.value, validTo.value) > 0) {
    return err(DiscountErrors.INVALID_DATE_RANGE);
  }

  return withTenant(ctx, async (tx) => {
    if (!(await finance.studentExists(tx, input.studentId))) {
      return err(DiscountErrors.STUDENT_NOT_FOUND);
    }
    if (input.feeHeadId && !(await finance.feeHeadExists(tx, input.feeHeadId))) {
      return err(DiscountErrors.HEAD_NOT_FOUND);
    }

    const discountId = await finance.createDiscount(tx, {
      studentId: input.studentId,
      feeHeadId: input.feeHeadId ?? null,
      kind: input.kind,
      valueMinor: input.valueMinor === undefined ? null : Money.fromJSON(input.valueMinor).minor,
      // Rounded to match the numeric(5,2) column — the DB would otherwise
      // silently round it anyway, and that should never be a surprise.
      percent: input.percent === undefined ? null : input.percent.toFixed(2),
      validFrom: validFrom.value,
      validTo: validTo?.ok ? validTo.value : null,
      reason: input.reason,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'discount.created', discountId, {
      entityType: 'discount',
      reason: input.reason,
      after: {
        discountId,
        studentId: input.studentId,
        feeHeadId: input.feeHeadId ?? null,
        kind: fact(input.kind),
        status: fact('pending'),
      },
    });

    return ok({ discountId });
  });
}

export interface ApproveDiscountInput {
  discountId: DiscountId;
  reason: string;
}

export async function approveDiscount(
  ctx: AuthContext,
  input: ApproveDiscountInput,
  deps: { clock?: Clock } = {},
): Promise<Result<{ approved: true }, DomainError>> {
  authorize(ctx, 'fee.waive');

  return withTenant(ctx, async (tx) => {
    const existing = await finance.discountById(tx, input.discountId);
    if (!existing) return err(DiscountErrors.NOT_FOUND);
    if (existing.status !== 'pending') return err(DiscountErrors.ALREADY_DECIDED);

    const approvedAt = (deps.clock ?? systemClock).now();
    await finance.approveDiscount(tx, input.discountId, {
      approvedBy: ctx.personId,
      approvedAt,
    });

    await audit(tx, ctx, 'discount.approved', input.discountId, {
      entityType: 'discount',
      reason: input.reason,
      before: { status: fact(existing.status) },
      after: { status: fact('approved'), approvedBy: fact(ctx.personId) },
    });

    return ok({ approved: true });
  });
}

export async function listDiscounts(
  ctx: AuthContext,
  filter: { studentId?: StudentId | undefined } = {},
): Promise<Result<DiscountRow[], DomainError>> {
  authorize(ctx, 'fee.read');

  return withTenant(
    ctx,
    async (tx) => ok((await finance.listDiscounts(tx, filter)).map(toRow)),
    { readOnly: true },
  );
}
