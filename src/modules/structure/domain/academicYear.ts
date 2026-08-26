/**
 * Academic year rules. §14.4.
 *
 * Pure. The database enforces "exactly one current year per school" and "no two
 * years overlap"; this is where the reasons live, and where they can be argued
 * with in a unit test rather than through a constraint violation.
 */

import { LocalDate, DateRange } from '../../../shared/date';

/** A year already on file, as much of it as these rules need. */
export interface ExistingYear {
  id: string;
  name: string;
  startDate: LocalDate;
  endDate: LocalDate;
  isCurrent: boolean;
  status: 'planning' | 'active' | 'closed';
}

export interface ProposedYear {
  name: string;
  startDate: LocalDate;
  endDate: LocalDate;
}

export type OpenVerdict =
  | { kind: 'ok' }
  | { kind: 'backwards' }
  | { kind: 'too_long'; days: number }
  | { kind: 'duplicate_name' }
  | { kind: 'overlaps'; withYear: string };

/**
 * The longest an academic year may be.
 *
 * Bangladesh runs the calendar year, so 366 days covers a leap year exactly. A
 * little slack is allowed for a school whose year runs to the first week of the
 * next January, but not enough to let a typo create a decade-long year that
 * then blocks every future year through the overlap rule.
 */
export const MAX_YEAR_DAYS = 400;

export function evaluateOpen(
  proposed: ProposedYear,
  existing: readonly ExistingYear[],
): OpenVerdict {
  if (LocalDate.compare(proposed.endDate, proposed.startDate) <= 0) {
    return { kind: 'backwards' };
  }

  const days = LocalDate.diffDays(proposed.endDate, proposed.startDate);
  if (days > MAX_YEAR_DAYS) return { kind: 'too_long', days };

  const name = proposed.name.trim();
  if (existing.some((y) => y.name === name)) return { kind: 'duplicate_name' };

  /*
   * Two years covering one day makes "which year is 2027-03-14 in?" ambiguous,
   * and attendance, results and fee collection all ask it. A closed year still
   * counts: its dates are still the answer for the days it covered.
   */
  const clash = existing.find((y) =>
    DateRange.overlaps(
      { from: proposed.startDate, to: proposed.endDate },
      { from: y.startDate, to: y.endDate },
    ),
  );
  if (clash) return { kind: 'overlaps', withYear: clash.name };

  return { kind: 'ok' };
}

export type CloseVerdict =
  | { kind: 'ok' }
  | { kind: 'already_closed' }
  /** Closing the current year would leave the school with no year at all. */
  | { kind: 'still_current' }
  | { kind: 'blocked'; by: readonly string[] };

/**
 * What must be settled before a year can be closed.
 *
 * §14.4 says closing refuses "while any exam is `marks_open` or any invoice is
 * `draft`". Neither module exists in 3a, so neither can be checked — and this
 * type exists so that absence is VISIBLE rather than implied by silence. The
 * caller passes what it was able to check; a field left undefined means "not
 * checkable yet", which is a different thing from "checked and fine".
 */
export interface CloseBlockers {
  openExams?: number | undefined;
  draftInvoices?: number | undefined;
}

export function evaluateClose(year: ExistingYear, blockers: CloseBlockers = {}): CloseVerdict {
  if (year.status === 'closed') return { kind: 'already_closed' };

  /*
   * The current year cannot be closed directly. Open its successor first —
   * that flips `is_current` — and then close this one. It reads like an extra
   * step and it is the reason a school can never end up with no current year,
   * which every other module reads on every request.
   */
  if (year.isCurrent) return { kind: 'still_current' };

  const by: string[] = [];
  if ((blockers.openExams ?? 0) > 0) by.push(`${blockers.openExams} exam(s) still open`);
  if ((blockers.draftInvoices ?? 0) > 0) by.push(`${blockers.draftInvoices} draft invoice(s)`);
  if (by.length > 0) return { kind: 'blocked', by };

  return { kind: 'ok' };
}

/** Which year a date falls in. Undefined is a real answer: holidays, gaps. */
export function yearForDate(
  date: LocalDate,
  years: readonly ExistingYear[],
): ExistingYear | undefined {
  return years.find(
    (y) =>
      LocalDate.compare(date, y.startDate) >= 0 && LocalDate.compare(date, y.endDate) <= 0,
  );
}
