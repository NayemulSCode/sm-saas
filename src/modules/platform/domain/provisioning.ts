/**
 * What a new school starts life with.
 *
 * Pure: no database, no clock of its own, no ids. Everything here is a decision
 * about Bangladeshi schools that should be arguable in a unit test rather than
 * discovered in production.
 */

import { LocalDate } from '../../../shared/date';

/** `^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$`, matching the CHECK on tenant.slug. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}

/**
 * A slug from a school's English name, for suggesting one — never for silently
 * accepting one. The slug is in every URL the school will ever print, so it is
 * confirmed by a human.
 */
export function suggestSlug(nameEn: string): string {
  const base = nameEn
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  // The CHECK needs at least three characters and no leading/trailing dash.
  return base.length >= 3 ? base : `school-${base}`.slice(0, 50).replace(/-+$/g, '');
}

export interface ClassLevelSeed {
  nameBn: string;
  nameEn: string;
  sequence: number;
  /** Kindergarten students have no login at all (FR-2.6). */
  loginEnabled: boolean;
}

/**
 * The default ladder for a Bangladeshi school: Play through Class 10.
 *
 * `sequence` is promotion order and is what every other module reads, so the
 * gaps between the pre-primary rungs and Class 1 are deliberate — a school that
 * adds 'Pre-Nursery' renumbers rows rather than changing code.
 *
 * A school picks its own subset at provisioning; this is the starting point,
 * not a constraint.
 */
export const DEFAULT_CLASS_LEVELS: readonly ClassLevelSeed[] = [
  { nameBn: 'প্লে', nameEn: 'Play', sequence: 10, loginEnabled: false },
  { nameBn: 'নার্সারি', nameEn: 'Nursery', sequence: 20, loginEnabled: false },
  { nameBn: 'কেজি', nameEn: 'KG', sequence: 30, loginEnabled: false },
  { nameBn: 'প্রথম শ্রেণি', nameEn: 'Class 1', sequence: 100, loginEnabled: false },
  { nameBn: 'দ্বিতীয় শ্রেণি', nameEn: 'Class 2', sequence: 200, loginEnabled: false },
  { nameBn: 'তৃতীয় শ্রেণি', nameEn: 'Class 3', sequence: 300, loginEnabled: false },
  { nameBn: 'চতুর্থ শ্রেণি', nameEn: 'Class 4', sequence: 400, loginEnabled: false },
  { nameBn: 'পঞ্চম শ্রেণি', nameEn: 'Class 5', sequence: 500, loginEnabled: true },
  { nameBn: 'ষষ্ঠ শ্রেণি', nameEn: 'Class 6', sequence: 600, loginEnabled: true },
  { nameBn: 'সপ্তম শ্রেণি', nameEn: 'Class 7', sequence: 700, loginEnabled: true },
  { nameBn: 'অষ্টম শ্রেণি', nameEn: 'Class 8', sequence: 800, loginEnabled: true },
  { nameBn: 'নবম শ্রেণি', nameEn: 'Class 9', sequence: 900, loginEnabled: true },
  { nameBn: 'দশম শ্রেণি', nameEn: 'Class 10', sequence: 1000, loginEnabled: true },
];

export interface ShiftSeed {
  nameBn: string;
  nameEn: string;
  startTime: string;
  endTime: string;
  sequence: number;
}

/**
 * One day shift by default.
 *
 * NOT morning + day. A shift is a first-class entity with its own timetable and
 * working-day calendar, so creating a second one a school does not run leaves
 * an empty calendar that looks like a bug. Schools that run two shifts add the
 * morning one deliberately.
 */
export const DEFAULT_SHIFTS: readonly ShiftSeed[] = [
  { nameBn: 'দিবা শাখা', nameEn: 'Day', startTime: '08:00', endTime: '14:00', sequence: 1 },
];

/**
 * The academic year for a school starting on `today`.
 *
 * Bangladesh runs the academic year on the CALENDAR year — January to December
 * — unlike the fiscal year, which the government runs July to June. The two are
 * separate on purpose: `school.fiscal_year_start_month` carries the second, and
 * receipt numbering keys off it.
 *
 * A school provisioned in November belongs to NEXT year: nobody sets up a
 * system to run the six weeks that are left, and putting them in the current
 * year would make their first act closing it.
 */
export function defaultAcademicYear(today: LocalDate): {
  name: string;
  startDate: LocalDate;
  endDate: LocalDate;
} {
  const target = today.m >= 11 ? today.y + 1 : today.y;
  return {
    name: String(target),
    startDate: LocalDate.of(target, 1, 1),
    endDate: LocalDate.of(target, 12, 31),
  };
}
