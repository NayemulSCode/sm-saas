/**
 * LocalDate — a calendar day in Asia/Dhaka. Not an instant.
 *
 * `new Date('2027-01-15')` is midnight UTC, which is 06:00 in Dhaka. A
 * working-day lookup done that way is off by one for six hours of every day.
 * That bug is why this type exists and why `Date` never represents a day here.
 *
 * Calendar days  → LocalDate ↔ `date`
 * Instants       → Date      ↔ `timestamptz`
 */

import { type Result, ok, err } from './result';
import { toLatinDigits } from './money';

export const PLATFORM_TIMEZONE = 'Asia/Dhaka' as const;

export interface LocalDate {
  readonly y: number;
  readonly m: number; // 1–12
  readonly d: number; // 1–31
}

export interface DateRange {
  readonly from: LocalDate;
  readonly to: LocalDate; // inclusive
}

export type DateError =
  | { code: 'MALFORMED_DATE'; input: string }
  | { code: 'INVALID_DATE'; input: string }
  | { code: 'RANGE_INVERTED'; from: string; to: string };

/** Injected wherever time is read, so tests are deterministic and
 *  "what happens at 23:59 on 31 December" is testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function isValid(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

/** Days since the Unix epoch, computed in UTC to avoid host-timezone drift. */
function toEpochDay(x: LocalDate): number {
  return Math.floor(Date.UTC(x.y, x.m - 1, x.d) / 86_400_000);
}

function fromEpochDay(n: number): LocalDate {
  const dt = new Date(n * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** Field values of an instant, as seen in Asia/Dhaka. */
function dhakaParts(at: Date): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: PLATFORM_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const [y = '1970', m = '01', d = '01'] = fmt.format(at).split('-');
  return { y: Number(y), m: Number(m), d: Number(d) };
}

export const LocalDate = {
  of(y: number, m: number, d: number): LocalDate {
    if (!isValid(y, m, d)) throw new Error(`Invalid date: ${y}-${m}-${d}`);
    return { y, m, d };
  },

  /** Strict `YYYY-MM-DD`. Accepts Bangla digits, because a Bangla keypad emits
   *  them and rejecting that would be a support call. */
  parse(input: string): Result<LocalDate, DateError> {
    const s = toLatinDigits(input).trim();
    const match = ISO_RE.exec(s);
    if (!match) return err({ code: 'MALFORMED_DATE', input });
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (!isValid(y, m, d)) return err({ code: 'INVALID_DATE', input });
    return ok({ y, m, d });
  },

  toISO(x: LocalDate): string {
    return `${String(x.y).padStart(4, '0')}-${String(x.m).padStart(2, '0')}-${String(x.d).padStart(2, '0')}`;
  },

  /** Today in Asia/Dhaka — NOT the server's local date. */
  today(clock: Clock = systemClock): LocalDate {
    return dhakaParts(clock.now());
  },

  /** The business date of an instant, in Dhaka. Used to derive the attendance
   *  date on sync rather than trusting the device clock. */
  fromInstant(at: Date): LocalDate {
    return dhakaParts(at);
  },

  /**
   * The reverse of `fromInstant`: midnight at the START of this calendar day,
   * in Dhaka. Used where a wire input is a date (§13.7's `payment.collectedAt`
   * — "the office enters Saturday's cash on Monday", so what matters is WHICH
   * business day, not a time of day) but the column it lands in is a
   * `timestamptz` (`payment.collected_at`).
   *
   * The fixed UTC+6 offset is safe here specifically because Bangladesh has
   * observed no DST since 2009 — a general "LocalDate + wall time → instant"
   * conversion would need the full IANA rules `Intl.DateTimeFormat` carries,
   * not a constant. Do not copy this pattern for a timezone that DOES have DST.
   */
  toInstantAtStartOfDay(x: LocalDate): Date {
    return new Date(Date.UTC(x.y, x.m - 1, x.d) - 6 * 3_600_000);
  },

  addDays(x: LocalDate, n: number): LocalDate {
    return fromEpochDay(toEpochDay(x) + n);
  },

  addMonths(x: LocalDate, n: number): LocalDate {
    const total = x.y * 12 + (x.m - 1) + n;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    return { y, m, d: Math.min(x.d, daysInMonth(y, m)) };
  },

  diffDays(a: LocalDate, b: LocalDate): number {
    return toEpochDay(a) - toEpochDay(b);
  },

  compare(a: LocalDate, b: LocalDate): -1 | 0 | 1 {
    const x = toEpochDay(a);
    const y = toEpochDay(b);
    return x < y ? -1 : x > y ? 1 : 0;
  },

  equals(a: LocalDate, b: LocalDate): boolean {
    return a.y === b.y && a.m === b.m && a.d === b.d;
  },

  /** 0 = Sunday. Sunday-first matches the Bangladeshi working week. */
  dayOfWeek(x: LocalDate): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
    return new Date(Date.UTC(x.y, x.m - 1, x.d)).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  },

  startOfMonth(x: LocalDate): LocalDate {
    return { y: x.y, m: x.m, d: 1 };
  },

  endOfMonth(x: LocalDate): LocalDate {
    return { y: x.y, m: x.m, d: daysInMonth(x.y, x.m) };
  },
};

export const DateRange = {
  of(from: LocalDate, to: LocalDate): Result<DateRange, DateError> {
    if (LocalDate.compare(from, to) > 0) {
      return err({
        code: 'RANGE_INVERTED',
        from: LocalDate.toISO(from),
        to: LocalDate.toISO(to),
      });
    }
    return ok({ from, to });
  },

  contains(r: DateRange, x: LocalDate): boolean {
    return LocalDate.compare(x, r.from) >= 0 && LocalDate.compare(x, r.to) <= 0;
  },

  overlaps(a: DateRange, b: DateRange): boolean {
    return LocalDate.compare(a.from, b.to) <= 0 && LocalDate.compare(b.from, a.to) <= 0;
  },

  lengthInDays(r: DateRange): number {
    return LocalDate.diffDays(r.to, r.from) + 1;
  },

  days(r: DateRange): LocalDate[] {
    const out: LocalDate[] = [];
    const n = DateRange.lengthInDays(r);
    for (let i = 0; i < n; i++) out.push(LocalDate.addDays(r.from, i));
    return out;
  },
};
