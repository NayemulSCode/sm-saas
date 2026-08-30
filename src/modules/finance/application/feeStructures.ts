/**
 * Fee structures — price by class, optionally narrowed to a section. §13.1.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { AcademicYearId, ClassLevelId, FeeHeadId, FeeStructureId, SectionId } from '../../../shared/ids';
import { feeStructures, type FeeStructureRow } from '../infrastructure/repositories';

export const FeeStructureErrors = defineErrors({
  SCOPE_ALREADY_DEFINED: {
    code: 'SCOPE_ALREADY_DEFINED',
    messageKey: 'finance.error.feeStructureScopeTaken',
    httpStatus: 409,
  },
});

export interface CreateFeeStructureInput {
  academicYearId: AcademicYearId;
  feeHeadId: FeeHeadId;
  classLevelId?: ClassLevelId;
  sectionId?: SectionId;
  amountMinor: bigint;
  dueDay?: number;
}

export async function createFeeStructure(
  ctx: AuthContext,
  input: CreateFeeStructureInput,
): Promise<Result<{ feeStructureId: FeeStructureId }, DomainError>> {
  authorize(ctx, 'fee.structure.manage');

  return withTenant(ctx, async (tx) => {
    // The database's own unique index is the final word — this is the same
    // early, field-attributable check every create-with-a-scoped-uniqueness
    // use case in this codebase does before letting the constraint answer.
    const existing = await feeStructures.list(tx, input.academicYearId);
    const clashes = existing.some(
      (s) =>
        s.feeHeadId === input.feeHeadId &&
        (input.classLevelId ? s.classLevelId === input.classLevelId : s.sectionId === input.sectionId),
    );
    if (clashes) return err(FeeStructureErrors.SCOPE_ALREADY_DEFINED);

    const feeStructureId = await feeStructures.create(tx, input);

    await audit(tx, ctx, 'fee.structureCreated', feeStructureId, {
      entityType: 'feeStructure',
      after: {
        feeStructureId,
        feeHeadId: input.feeHeadId,
        academicYearId: input.academicYearId,
        amountMinor: fact(input.amountMinor.toString()),
      },
    });

    return ok({ feeStructureId });
  });
}

export async function listFeeStructures(
  ctx: AuthContext,
  academicYearId: AcademicYearId,
): Promise<Result<FeeStructureRow[], DomainError>> {
  authorize(ctx, 'fee.read');
  return withTenant(ctx, async (tx) => ok(await feeStructures.list(tx, academicYearId)));
}
