/**
 * Fee heads — what a school charges for. §13.1.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { FeeHeadId } from '../../../shared/ids';
import { feeHeads, type FeeHeadRow } from '../infrastructure/repositories';

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
  isRefundable: boolean;
  sequence: number;
}

export async function createFeeHead(
  ctx: AuthContext,
  input: CreateFeeHeadInput,
): Promise<Result<{ feeHeadId: FeeHeadId }, DomainError>> {
  authorize(ctx, 'fee.structure.manage');

  return withTenant(ctx, async (tx) => {
    if (await feeHeads.byCode(tx, input.code)) return err(FeeHeadErrors.CODE_TAKEN);

    const feeHeadId = await feeHeads.create(tx, input);

    await audit(tx, ctx, 'fee.headCreated', feeHeadId, {
      entityType: 'feeHead',
      after: {
        feeHeadId,
        code: fact(input.code),
        nameEn: fact(input.nameEn),
        frequency: fact(input.frequency),
      },
    });

    return ok({ feeHeadId });
  });
}

export async function listFeeHeads(ctx: AuthContext): Promise<Result<FeeHeadRow[], DomainError>> {
  authorize(ctx, 'fee.read');
  return withTenant(ctx, async (tx) => ok(await feeHeads.list(tx)));
}
