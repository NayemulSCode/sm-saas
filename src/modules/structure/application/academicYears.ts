/**
 * Opening and closing academic years. §14.4.
 *
 * "Exactly one `is_current` per school" is enforced by a partial unique index,
 * and the whole reason these are use cases rather than CRUD is that flipping it
 * has to happen inside the same transaction as the insert — a school with no
 * current year is one every other module reads and finds nothing in.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { AcademicYearId, SchoolId } from '../../../shared/ids';
import { LocalDate } from '../../../shared/date';
import { evaluateOpen, evaluateClose, type CloseBlockers } from '../domain/academicYear';
import { structure } from '../infrastructure/repositories';

export const YearErrors = defineErrors({
  SCHOOL_NOT_FOUND: {
    code: 'SCHOOL_NOT_FOUND',
    messageKey: 'structure.error.schoolNotFound',
    httpStatus: 404,
  },
  YEAR_NOT_FOUND: {
    code: 'YEAR_NOT_FOUND',
    messageKey: 'structure.error.yearNotFound',
    httpStatus: 404,
  },
  INVALID_YEAR_DATES: {
    code: 'INVALID_YEAR_DATES',
    messageKey: 'structure.error.invalidYearDates',
    httpStatus: 400,
  },
  YEAR_NAME_TAKEN: {
    code: 'YEAR_NAME_TAKEN',
    messageKey: 'structure.error.yearNameTaken',
    httpStatus: 409,
  },
  YEAR_OVERLAPS: {
    code: 'YEAR_OVERLAPS',
    messageKey: 'structure.error.yearOverlaps',
    httpStatus: 409,
  },
  YEAR_ALREADY_CLOSED: {
    code: 'YEAR_ALREADY_CLOSED',
    messageKey: 'structure.error.yearAlreadyClosed',
    httpStatus: 409,
  },
  /** Open the successor first; that flips is_current. */
  YEAR_STILL_CURRENT: {
    code: 'YEAR_STILL_CURRENT',
    messageKey: 'structure.error.yearStillCurrent',
    httpStatus: 409,
  },
  YEAR_HAS_OPEN_WORK: {
    code: 'YEAR_HAS_OPEN_WORK',
    messageKey: 'structure.error.yearHasOpenWork',
    httpStatus: 409,
  },
});

export interface OpenAcademicYearInput {
  schoolId: SchoolId;
  /** '2027' — a label, not a date. */
  name: string;
  startDate: string;
  endDate: string;
  /**
   * Whether this becomes the school's current year. Defaults to true: a year
   * opened without being made current is a plan, and planning next year while
   * this one runs is the less common case.
   */
  makeCurrent?: boolean | undefined;
}

export async function openAcademicYear(
  ctx: AuthContext,
  input: OpenAcademicYearInput,
): Promise<Result<{ academicYearId: AcademicYearId; isCurrent: boolean }, DomainError>> {
  authorize(ctx, 'academicYear.manage');

  const start = LocalDate.parse(input.startDate);
  const end = LocalDate.parse(input.endDate);
  if (!start.ok || !end.ok) return err(YearErrors.INVALID_YEAR_DATES);

  const makeCurrent = input.makeCurrent ?? true;

  return withTenant(ctx, async (tx) => {
    if (!(await structure.schoolExists(tx, input.schoolId))) {
      return err(YearErrors.SCHOOL_NOT_FOUND);
    }

    const existing = await structure.yearsFor(tx, input.schoolId);
    const verdict = evaluateOpen(
      { name: input.name.trim(), startDate: start.value, endDate: end.value },
      existing,
    );

    switch (verdict.kind) {
      case 'backwards':
      case 'too_long':
        return err(YearErrors.INVALID_YEAR_DATES);
      case 'duplicate_name':
        return err(YearErrors.YEAR_NAME_TAKEN);
      case 'overlaps':
        return err(YearErrors.YEAR_OVERLAPS);
      case 'ok':
        break;
    }

    /*
     * The old year steps down FIRST. The partial unique index allows one
     * current year per school and is not deferrable, so the insert would fail
     * otherwise — and both statements are in one transaction, so there is never
     * an instant with no current year.
     */
    if (makeCurrent) await structure.clearCurrent(tx, input.schoolId, ctx.personId);

    const academicYearId = await structure.createYear(tx, {
      schoolId: input.schoolId,
      name: input.name.trim(),
      startDate: start.value,
      endDate: end.value,
      isCurrent: makeCurrent,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'academicYear.opened', academicYearId, {
      entityType: 'academicYear',
      after: {
        academicYearId,
        schoolId: input.schoolId,
        name: fact(input.name.trim()),
        startDate: fact(LocalDate.toISO(start.value)),
        endDate: fact(LocalDate.toISO(end.value)),
        isCurrent: makeCurrent,
      },
    });

    return ok({ academicYearId, isCurrent: makeCurrent });
  });
}

export interface CloseAcademicYearInput {
  academicYearId: AcademicYearId;
  /** Required and audited — `academicYear.close` is a dangerous permission. */
  reason: string;
}

/**
 * Closes a year.
 *
 * §14.4 says this refuses "while any exam is `marks_open` or any invoice is
 * `draft`". NEITHER CHECK IS POSSIBLE IN 3a — assessment and finance do not
 * exist. The blockers are collected in one place below so that when those
 * modules ship there is a single obvious spot to fill in, and so that the gap
 * is visible in the code rather than implied by its absence.
 */
export async function closeAcademicYear(
  ctx: AuthContext,
  input: CloseAcademicYearInput,
): Promise<Result<{ closed: boolean }, DomainError>> {
  authorize(ctx, 'academicYear.close');

  return withTenant(ctx, async (tx) => {
    const year = await structure.yearById(tx, input.academicYearId);
    if (!year) return err(YearErrors.YEAR_NOT_FOUND);

    /*
     * Left deliberately empty. `openExams` and `draftInvoices` are `undefined`,
     * which `evaluateClose` treats as "not checkable yet" rather than "checked
     * and fine" — the distinction is the whole reason the type has optional
     * fields. When assessment and finance land, they are counted here.
     */
    const blockers: CloseBlockers = {};

    const verdict = evaluateClose(year, blockers);
    switch (verdict.kind) {
      case 'already_closed':
        return err(YearErrors.YEAR_ALREADY_CLOSED);
      case 'still_current':
        return err(YearErrors.YEAR_STILL_CURRENT);
      case 'blocked':
        return err(YearErrors.YEAR_HAS_OPEN_WORK);
      case 'ok':
        break;
    }

    await structure.closeYear(tx, input.academicYearId, ctx.personId);

    await audit(tx, ctx, 'academicYear.closed', input.academicYearId, {
      entityType: 'academicYear',
      reason: input.reason,
      before: { status: fact(year.status) },
      after: {
        status: fact('closed'),
        // Recorded because it is the honest state of the check, and because an
        // audit row that implies a check happened when it did not is worse
        // than one that says so.
        blockersChecked: fact('none available in 3a'),
      },
    });

    return ok({ closed: true });
  });
}
