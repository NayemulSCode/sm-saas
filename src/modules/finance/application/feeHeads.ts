/**
 * Fee heads — the priced items a school charges (tuition, exam, transport,
 * a security deposit). §13.1.
 *
 * Deliberately tenant-wide, not per-school: `fee_head` carries no
 * `school_id` in the schema (§13.1), so a multi-school tenant shares one
 * catalogue of fee kinds and prices them differently per school through
 * `fee_structure` instead. That is a schema decision this use case follows,
 * not one it makes.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { FeeHeadId } from '../../../shared/ids';
import { finance, type FeeHeadRecord } from '../infrastructure/repositories';

export const FeeHeadErrors = defineErrors({
  CODE_TAKEN: {
    code: 'CODE_TAKEN',
    messageKey: 'finance.error.feeHeadCodeTaken',
    httpStatus: 409,
  },
});

export interface CreateFeeHeadInput {
  code: string;
  nameBn: string;
  nameEn: string;
  frequency: 'one_time' | 'monthly' | 'term' | 'annual';
  isRefundable?: boolean | undefined;
  glCode?: string | undefined;
  sequence?: number | undefined;
}

export type FeeHeadRow = FeeHeadRecord;

export async function createFeeHead(
  ctx: AuthContext,
  input: CreateFeeHeadInput,
): Promise<Result<{ feeHeadId: FeeHeadId }, DomainError>> {
  authorize(ctx, 'fee.structure.manage');

  return withTenant(ctx, async (tx) => {
    if (await finance.feeHeadCodeTaken(tx, input.code)) {
      return err(FeeHeadErrors.CODE_TAKEN);
    }

    const feeHeadId = await finance.createFeeHead(tx, {
      code: input.code,
      nameBn: input.nameBn,
      nameEn: input.nameEn,
      frequency: input.frequency,
      isRefundable: input.isRefundable ?? false,
      glCode: input.glCode ?? null,
      sequence: input.sequence ?? 0,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'feeHead.created', feeHeadId, {
      entityType: 'feeHead',
      after: {
        feeHeadId,
        code: fact(input.code),
        nameEn: fact(input.nameEn),
        frequency: fact(input.frequency),
        isRefundable: input.isRefundable ?? false,
      },
    });

    return ok({ feeHeadId });
  });
}

export async function listFeeHeads(
  ctx: AuthContext,
): Promise<Result<FeeHeadRow[], DomainError>> {
  authorize(ctx, 'fee.read');

  return withTenant(ctx, async (tx) => ok(await finance.listFeeHeads(tx)), { readOnly: true });
}
