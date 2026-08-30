/**
 * Fee structures — price by class, optionally narrowed to a section. §13.1.
 *
 * The row invoice generation (a later increment) will read to decide what a
 * given student owes for a given head: `fee_structure` scoped to their class
 * or section, with `fee_assignment` (a per-student override, not built yet)
 * beating it when one exists.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { Money } from '../../../shared/money';
import type {
  AcademicYearId,
  ClassLevelId,
  FeeHeadId,
  FeeStructureId,
  SectionId,
} from '../../../shared/ids';
import { finance } from '../infrastructure/repositories';

export const FeeStructureErrors = defineErrors({
  YEAR_NOT_FOUND: {
    code: 'YEAR_NOT_FOUND',
    messageKey: 'finance.error.yearNotFound',
    httpStatus: 404,
  },
  HEAD_NOT_FOUND: {
    code: 'HEAD_NOT_FOUND',
    messageKey: 'finance.error.headNotFound',
    httpStatus: 404,
  },
  SCOPE_NOT_FOUND: {
    code: 'SCOPE_NOT_FOUND',
    messageKey: 'finance.error.scopeNotFound',
    httpStatus: 404,
  },
  /** A class level or section from a different school than the academic year
   *  — the single-column FK would allow it; nothing downstream could price a
   *  student against a class that isn't in their school's calendar. */
  SCOPE_SCHOOL_MISMATCH: {
    code: 'SCOPE_SCHOOL_MISMATCH',
    messageKey: 'finance.error.scopeSchoolMismatch',
    httpStatus: 400,
  },
  DUPLICATE_SCOPE: {
    code: 'DUPLICATE_SCOPE',
    messageKey: 'finance.error.duplicateScope',
    httpStatus: 409,
  },
});

export interface CreateFeeStructureInput {
  academicYearId: AcademicYearId;
  feeHeadId: FeeHeadId;
  classLevelId?: ClassLevelId | undefined;
  sectionId?: SectionId | undefined;
  /** Minor units, as a wire string — parsed here, not at the transport edge. */
  amountMinor: string;
  dueDay?: number | undefined;
}

export interface FeeStructureRow {
  id: FeeStructureId;
  academicYearId: AcademicYearId;
  feeHeadId: FeeHeadId;
  classLevelId: ClassLevelId | null;
  sectionId: SectionId | null;
  amountMinor: string;
  dueDay: number | null;
}

export async function createFeeStructure(
  ctx: AuthContext,
  input: CreateFeeStructureInput,
): Promise<Result<{ feeStructureId: FeeStructureId }, DomainError>> {
  authorize(ctx, 'fee.structure.manage');

  return withTenant(ctx, async (tx) => {
    const year = await finance.academicYearSchool(tx, input.academicYearId);
    if (!year) return err(FeeStructureErrors.YEAR_NOT_FOUND);

    if (!(await finance.feeHeadExists(tx, input.feeHeadId))) {
      return err(FeeStructureErrors.HEAD_NOT_FOUND);
    }

    // The schema's own DTO already enforces exactly one of these; this is the
    // same check for any caller that reaches the use case directly (a worker,
    // a future import job) without going through the Zod schema.
    let scopeId: string;
    if (input.classLevelId) {
      const scope = await finance.classLevelSchool(tx, input.classLevelId);
      if (!scope) return err(FeeStructureErrors.SCOPE_NOT_FOUND);
      if (scope.schoolId !== year.schoolId) return err(FeeStructureErrors.SCOPE_SCHOOL_MISMATCH);
      scopeId = input.classLevelId;
    } else if (input.sectionId) {
      const scope = await finance.sectionSchool(tx, input.sectionId);
      if (!scope) return err(FeeStructureErrors.SCOPE_NOT_FOUND);
      if (scope.schoolId !== year.schoolId) return err(FeeStructureErrors.SCOPE_SCHOOL_MISMATCH);
      scopeId = input.sectionId;
    } else {
      return err(FeeStructureErrors.SCOPE_NOT_FOUND);
    }

    if (
      await finance.feeStructureConflict(tx, {
        academicYearId: input.academicYearId,
        feeHeadId: input.feeHeadId,
        scopeId,
      })
    ) {
      return err(FeeStructureErrors.DUPLICATE_SCOPE);
    }

    const amount = Money.fromJSON(input.amountMinor);

    const feeStructureId = await finance.createFeeStructure(tx, {
      academicYearId: input.academicYearId,
      feeHeadId: input.feeHeadId,
      classLevelId: input.classLevelId ?? null,
      sectionId: input.sectionId ?? null,
      amountMinor: amount.minor,
      dueDay: input.dueDay ?? null,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'feeStructure.created', feeStructureId, {
      entityType: 'feeStructure',
      after: {
        feeStructureId,
        academicYearId: input.academicYearId,
        feeHeadId: input.feeHeadId,
        scope: fact(input.classLevelId ? `classLevel:${input.classLevelId}` : `section:${input.sectionId}`),
        amountMinor: fact(amount.minor.toString()),
      },
    });

    return ok({ feeStructureId });
  });
}

export async function listFeeStructures(
  ctx: AuthContext,
  filter: { academicYearId?: AcademicYearId | undefined } = {},
): Promise<Result<FeeStructureRow[], DomainError>> {
  authorize(ctx, 'fee.read');

  return withTenant(
    ctx,
    async (tx) => {
      const rows = await finance.listFeeStructures(tx, filter);
      return ok(rows.map((r) => ({ ...r, amountMinor: r.amountMinor.toString() })));
    },
    { readOnly: true },
  );
}
