import { describe, it, expect } from 'vitest';
import { LocalDate } from '../../../shared/date';
import {
  evaluateOpen,
  evaluateClose,
  yearForDate,
  MAX_YEAR_DAYS,
  type ExistingYear,
} from './academicYear';

const d = (iso: string) => {
  const parsed = LocalDate.parse(iso);
  if (!parsed.ok) throw new Error(`bad test date ${iso}`);
  return parsed.value;
};

const year = (over: Partial<ExistingYear> = {}): ExistingYear => ({
  id: 'y-2027',
  name: '2027',
  startDate: d('2027-01-01'),
  endDate: d('2027-12-31'),
  isCurrent: false,
  status: 'planning',
  ...over,
});

describe('opening an academic year', () => {
  it('accepts a clean calendar year alongside the previous one', () => {
    const v = evaluateOpen(
      { name: '2028', startDate: d('2028-01-01'), endDate: d('2028-12-31') },
      [year()],
    );
    expect(v.kind).toBe('ok');
  });

  it('accepts the very first year of a new school', () => {
    expect(
      evaluateOpen({ name: '2027', startDate: d('2027-01-01'), endDate: d('2027-12-31') }, [])
        .kind,
    ).toBe('ok');
  });

  it('refuses a year that ends before it starts', () => {
    expect(
      evaluateOpen({ name: 'x', startDate: d('2027-12-31'), endDate: d('2027-01-01') }, []).kind,
    ).toBe('backwards');
  });

  it('refuses a single-day year', () => {
    expect(
      evaluateOpen({ name: 'x', startDate: d('2027-01-01'), endDate: d('2027-01-01') }, []).kind,
    ).toBe('backwards');
  });

  /*
   * A typo like 2207 instead of 2027 would otherwise create a 180-year range
   * that overlaps — and therefore blocks — every real year after it.
   */
  it('refuses an absurdly long year', () => {
    const v = evaluateOpen(
      { name: 'typo', startDate: d('2027-01-01'), endDate: d('2207-01-01') },
      [],
    );
    expect(v.kind).toBe('too_long');
    if (v.kind === 'too_long') expect(v.days).toBeGreaterThan(MAX_YEAR_DAYS);
  });

  it('allows a leap year and a little slack past it', () => {
    expect(
      evaluateOpen({ name: '2028', startDate: d('2028-01-01'), endDate: d('2028-12-31') }, [])
        .kind,
    ).toBe('ok');
    expect(
      evaluateOpen({ name: 'long', startDate: d('2027-01-01'), endDate: d('2028-01-07') }, [])
        .kind,
    ).toBe('ok');
  });

  it('refuses a duplicate name, ignoring surrounding whitespace', () => {
    expect(
      evaluateOpen({ name: '  2027  ', startDate: d('2028-01-01'), endDate: d('2028-12-31') }, [
        year(),
      ]).kind,
    ).toBe('duplicate_name');
  });

  describe('no two years may cover the same day', () => {
    it('refuses an exact repeat', () => {
      const v = evaluateOpen(
        { name: '2027 again', startDate: d('2027-01-01'), endDate: d('2027-12-31') },
        [year()],
      );
      expect(v.kind).toBe('overlaps');
      if (v.kind === 'overlaps') expect(v.withYear).toBe('2027');
    });

    it('refuses a one-day overlap at either end', () => {
      expect(
        evaluateOpen({ name: 'a', startDate: d('2026-06-01'), endDate: d('2027-01-01') }, [
          year(),
        ]).kind,
      ).toBe('overlaps');
      expect(
        evaluateOpen({ name: 'b', startDate: d('2027-12-31'), endDate: d('2028-06-01') }, [
          year(),
        ]).kind,
      ).toBe('overlaps');
    });

    it('accepts years that touch without overlapping', () => {
      expect(
        evaluateOpen({ name: '2028', startDate: d('2028-01-01'), endDate: d('2028-12-31') }, [
          year(),
        ]).kind,
      ).toBe('ok');
    });

    // The dates of a closed year are still the answer for the days it covered.
    it('counts a closed year as occupying its dates', () => {
      expect(
        evaluateOpen({ name: 'redo', startDate: d('2027-03-01'), endDate: d('2027-09-01') }, [
          year({ status: 'closed' }),
        ]).kind,
      ).toBe('overlaps');
    });
  });
});

describe('closing an academic year', () => {
  it('closes a finished, non-current year', () => {
    expect(evaluateClose(year({ status: 'active' })).kind).toBe('ok');
  });

  it('refuses a year that is already closed', () => {
    expect(evaluateClose(year({ status: 'closed' })).kind).toBe('already_closed');
  });

  /*
   * The sequencing rule. Open the successor first — which flips is_current —
   * then close this one. It is why a school can never end up with no current
   * year, which every other module reads on every request.
   */
  it('refuses to close the current year', () => {
    expect(evaluateClose(year({ isCurrent: true, status: 'active' })).kind).toBe('still_current');
  });

  it('refuses while exams are open or invoices are draft', () => {
    const a = evaluateClose(year({ status: 'active' }), { openExams: 2 });
    expect(a.kind).toBe('blocked');
    if (a.kind === 'blocked') expect(a.by[0]).toContain('2 exam');

    const b = evaluateClose(year({ status: 'active' }), { draftInvoices: 5 });
    expect(b.kind).toBe('blocked');
    if (b.kind === 'blocked') expect(b.by[0]).toContain('5 draft');
  });

  it('reports every blocker at once rather than one at a time', () => {
    const v = evaluateClose(year({ status: 'active' }), { openExams: 1, draftInvoices: 1 });
    expect(v.kind).toBe('blocked');
    if (v.kind === 'blocked') expect(v.by).toHaveLength(2);
  });

  /*
   * Undefined means "not checkable yet" — assessment and finance do not exist
   * in 3a — and zero means "checked and there are none". The distinction is
   * the point of the type; both permit closing, but only one is a claim.
   */
  it('treats a blocker that could not be checked the same as none, and says so', () => {
    expect(evaluateClose(year({ status: 'active' }), {}).kind).toBe('ok');
    expect(evaluateClose(year({ status: 'active' }), { openExams: 0 }).kind).toBe('ok');
  });
});

describe('yearForDate', () => {
  const years = [
    year({ id: 'a', name: '2027' }),
    year({ id: 'b', name: '2028', startDate: d('2028-01-01'), endDate: d('2028-12-31') }),
  ];

  it('finds the year containing a date, inclusive at both ends', () => {
    expect(yearForDate(d('2027-01-01'), years)?.name).toBe('2027');
    expect(yearForDate(d('2027-12-31'), years)?.name).toBe('2027');
    expect(yearForDate(d('2028-06-15'), years)?.name).toBe('2028');
  });

  it('returns nothing for a date in no year, which is a real answer', () => {
    expect(yearForDate(d('2026-06-15'), years)).toBeUndefined();
  });
});
