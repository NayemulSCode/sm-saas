/**
 * Class levels and their order. §14.4.
 *
 * `sequence` drives promotion, so reordering is a structural change to what
 * "the next class up" means — not a display preference.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { ClassLevelId, SchoolId } from '../../../shared/ids';
import { evaluateReorder, nextSequence } from '../domain/classLevel';
import { structure } from '../infrastructure/repositories';
import { YearErrors } from './academicYears';

export const ClassLevelErrors = defineErrors({
  LEVEL_ORDER_INCOMPLETE: {
    code: 'LEVEL_ORDER_INCOMPLETE',
    messageKey: 'structure.error.levelOrderIncomplete',
    httpStatus: 400,
  },
  LEVEL_NOT_FOUND: {
    code: 'LEVEL_NOT_FOUND',
    messageKey: 'structure.error.levelNotFound',
    httpStatus: 404,
  },
  /** Reordering while a cohort is enrolled changes promotion under their feet. */
  REORDER_MID_YEAR: {
    code: 'REORDER_MID_YEAR',
    messageKey: 'structure.error.reorderMidYear',
    httpStatus: 409,
  },
  LEVEL_NAME_TAKEN: {
    code: 'LEVEL_NAME_TAKEN',
    messageKey: 'structure.error.levelNameTaken',
    httpStatus: 409,
  },
});

export interface CreateClassLevelInput {
  schoolId: SchoolId;
  nameBn: string;
  nameEn: string;
  medium?: 'bangla' | 'english' | 'other' | undefined;
  /** Kindergarten students have no login at all (FR-2.6). */
  loginEnabled?: boolean | undefined;
  /** Where in the ladder. Omitted means the top — see `nextSequence`. */
  sequence?: number | undefined;
}

export async function createClassLevel(
  ctx: AuthContext,
  input: CreateClassLevelInput,
): Promise<Result<{ classLevelId: ClassLevelId; sequence: number }, DomainError>> {
  authorize(ctx, 'structure.manage');

  return withTenant(ctx, async (tx) => {
    if (!(await structure.schoolExists(tx, input.schoolId))) {
      return err(YearErrors.SCHOOL_NOT_FOUND);
    }

    const existing = await structure.levelsFor(tx, input.schoolId);
    if (existing.some((l) => l.nameEn === input.nameEn.trim())) {
      return err(ClassLevelErrors.LEVEL_NAME_TAKEN);
    }

    const sequence = input.sequence ?? nextSequence(existing);
    if (existing.some((l) => l.sequence === sequence)) {
      // Reorder instead: an explicit sequence that collides is a mistake, and
      // silently nudging it would put the class in a position nobody chose.
      return err(ClassLevelErrors.LEVEL_NAME_TAKEN);
    }

    const classLevelId = await structure.createLevel(tx, {
      schoolId: input.schoolId,
      nameBn: input.nameBn,
      nameEn: input.nameEn.trim(),
      sequence,
      medium: input.medium,
      loginEnabled: input.loginEnabled ?? false,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'classLevel.created', classLevelId, {
      entityType: 'classLevel',
      after: {
        classLevelId,
        schoolId: input.schoolId,
        nameEn: fact(input.nameEn.trim()),
        sequence: fact(sequence),
        loginEnabled: input.loginEnabled ?? false,
      },
    });

    return ok({ classLevelId, sequence });
  });
}

export interface ReorderClassLevelsInput {
  schoolId: SchoolId;
  /** The COMPLETE order, lowest class first. Not a diff. */
  orderedIds: readonly ClassLevelId[];
  reason: string;
}

export async function reorderClassLevels(
  ctx: AuthContext,
  input: ReorderClassLevelsInput,
): Promise<Result<{ moved: number }, DomainError>> {
  authorize(ctx, 'structure.manage');

  return withTenant(ctx, async (tx) => {
    if (!(await structure.schoolExists(tx, input.schoolId))) {
      return err(YearErrors.SCHOOL_NOT_FOUND);
    }

    /*
     * Mid-year is defined by ENROLMENTS, not by dates. A school that has opened
     * a year but admitted nobody is still setting up, and stopping them from
     * fixing the ladder would be pedantry. Once a cohort is in place, promotion
     * is keyed to this order and changing it moves children.
     */
    const years = await structure.yearsFor(tx, input.schoolId);
    const current = years.find((y) => y.isCurrent);
    if (current) {
      const enrolled = await structure.enrolmentCountIn(tx, current.id as never);
      if (enrolled > 0) return err(ClassLevelErrors.REORDER_MID_YEAR);
    }

    const existing = await structure.levelsFor(tx, input.schoolId);
    const verdict = evaluateReorder(existing, input.orderedIds);

    switch (verdict.kind) {
      case 'unknown':
        return err(ClassLevelErrors.LEVEL_NOT_FOUND);
      case 'duplicate_id':
      case 'incomplete':
        return err(ClassLevelErrors.LEVEL_ORDER_INCOMPLETE);
      case 'no_change':
        return ok({ moved: 0 });
      case 'ok':
        break;
    }

    await structure.applyReorder(tx, verdict.changes, ctx.personId);

    await audit(tx, ctx, 'classLevel.reordered', input.schoolId, {
      entityType: 'school',
      reason: input.reason,
      before: { order: fact(existing.map((l) => l.nameEn).join(' < ')) },
      after: {
        moved: fact(verdict.changes.length),
        order: fact(
          input.orderedIds
            .map((id) => existing.find((l) => l.id === id)?.nameEn ?? '?')
            .join(' < '),
        ),
      },
    });

    return ok({ moved: verdict.changes.length });
  });
}
