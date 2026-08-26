/**
 * The whole shape of a school, in one read.
 *
 * Every screen in the staff app needs some of this — the class list, the
 * section picker, "which year are we in" — and fetching it piecemeal is four
 * round trips on a 3G connection in a district town.
 */

import { withTenant } from '../../../db/rls';
import { type Result, ok, err, type DomainError } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { SchoolId } from '../../../shared/ids';
import { structure } from '../infrastructure/repositories';
import { YearErrors } from './academicYears';
import type { ExistingYear } from '../domain/academicYear';
import type { ExistingLevel } from '../domain/classLevel';

type Unwrap<T> = T extends Promise<infer U> ? U : T;

export interface StructureView {
  school: NonNullable<Unwrap<ReturnType<typeof structure.schoolSummary>>>;
  /** Null is a real state: a school between years has no current one. */
  currentYear: ExistingYear | null;
  years: ExistingYear[];
  campuses: Unwrap<ReturnType<typeof structure.campusesFor>>;
  shifts: Unwrap<ReturnType<typeof structure.shiftsFor>>;
  classLevels: ExistingLevel[];
  sections: Unwrap<ReturnType<typeof structure.sectionsFor>>;
}

export async function getStructure(
  ctx: AuthContext,
  schoolId?: SchoolId,
): Promise<Result<StructureView, DomainError>> {
  authorize(ctx, 'structure.read');

  return withTenant(
    ctx,
    async (tx) => {
      // Most tenants have exactly one school, so the caller usually should not
      // have to know its id to ask what it looks like.
      const id = schoolId ?? (await structure.soleSchool(tx));
      if (!id) return err(YearErrors.SCHOOL_NOT_FOUND);

      const school = await structure.schoolSummary(tx, id);
      if (!school) return err(YearErrors.SCHOOL_NOT_FOUND);

      const [years, levels, campuses, sections] = await Promise.all([
        structure.yearsFor(tx, id),
        structure.levelsFor(tx, id),
        structure.campusesFor(tx, id),
        structure.sectionsFor(tx, id),
      ]);

      const shifts = (
        await Promise.all(campuses.map((c) => structure.shiftsFor(tx, c.id)))
      ).flat();

      return ok({
        school,
        currentYear: years.find((y) => y.isCurrent) ?? null,
        years,
        campuses,
        shifts,
        classLevels: levels,
        sections,
      });
    },
    // A read, on the replica, and RLS still applies (ADR-0021).
    { readOnly: true },
  );
}
