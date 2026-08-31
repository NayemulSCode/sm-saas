/**
 * Which fiscal year a date falls in. §13.3, §13.4.
 *
 * Deliberately NOT the academic year — Bangladesh runs the academic year on
 * the calendar year but the government fiscal year July–June, and
 * `school.fiscal_year_start_month` carries the second. Receipt numbering
 * keys off THIS, because `receipt_sequence`'s primary key is
 * `(tenant_id, school_id, fiscal_year)`.
 *
 * PURE — no IO, same discipline as `allocate.ts` and `price.ts`.
 */

import type { LocalDate } from '../../../../shared/date';

/**
 * Labelled by the calendar year the fiscal year STARTS in. A school with
 * `fiscalYearStartMonth = 7`: a payment collected in August 2027 is FY2027
 * (started July 2027); one collected in March 2027 is FY2026 (that fiscal
 * year started July 2026 and has not ended yet). `fiscalYearStartMonth = 1`
 * — the default — collapses to the calendar year, exactly.
 */
export function fiscalYearOf(date: LocalDate, fiscalYearStartMonth: number): number {
  return date.m >= fiscalYearStartMonth ? date.y : date.y - 1;
}
