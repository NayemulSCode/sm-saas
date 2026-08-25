import { describe, it, expect } from 'vitest';
import { LocalDate, DateRange, type Clock } from './date';

const d = (s: string) => {
  const r = LocalDate.parse(s);
  if (!r.ok) throw new Error(`fixture is not a date: ${s}`);
  return r.value;
};

describe('LocalDate.parse', () => {
  it('parses ISO', () => {
    expect(d('2027-01-15')).toEqual({ y: 2027, m: 1, d: 15 });
  });

  it('parses Bangla digits', () => {
    expect(d('২০২৭-০১-১৫')).toEqual({ y: 2027, m: 1, d: 15 });
  });

  it('rejects a malformed string', () => {
    expect(LocalDate.parse('15/01/2027').ok).toBe(false);
  });

  it('rejects an impossible date', () => {
    const r = LocalDate.parse('2027-02-31');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('INVALID_DATE');
  });

  it('accepts a real leap day and rejects a fake one', () => {
    expect(LocalDate.parse('2028-02-29').ok).toBe(true);
    expect(LocalDate.parse('2027-02-29').ok).toBe(false);
  });

  it('round-trips through ISO', () => {
    expect(LocalDate.toISO(d('2027-03-09'))).toBe('2027-03-09');
  });
});

describe('LocalDate is a calendar day, not an instant', () => {
  // The bug this type exists to prevent: new Date('2027-01-15') is midnight
  // UTC, which is already 06:00 on the 15th in Dhaka. An instant just before
  // midnight UTC is therefore ALREADY the next day in Dhaka.
  it('resolves the Dhaka business date, not the UTC date', () => {
    const lateUtc = new Date('2027-01-15T20:00:00Z'); // 02:00 on the 16th in Dhaka
    expect(LocalDate.toISO(LocalDate.fromInstant(lateUtc))).toBe('2027-01-16');
  });

  it('uses Dhaka for today()', () => {
    const clock: Clock = { now: () => new Date('2027-06-30T19:30:00Z') };
    expect(LocalDate.toISO(LocalDate.today(clock))).toBe('2027-07-01');
  });
});

describe('LocalDate arithmetic', () => {
  it('adds days across a month boundary', () => {
    expect(LocalDate.toISO(LocalDate.addDays(d('2027-01-31'), 1))).toBe('2027-02-01');
  });

  it('adds days across a year boundary', () => {
    expect(LocalDate.toISO(LocalDate.addDays(d('2027-12-31'), 1))).toBe('2028-01-01');
  });

  it('subtracts days', () => {
    expect(LocalDate.toISO(LocalDate.addDays(d('2027-03-01'), -1))).toBe('2027-02-28');
  });

  it('clamps when adding months to a long month', () => {
    expect(LocalDate.toISO(LocalDate.addMonths(d('2027-01-31'), 1))).toBe('2027-02-28');
  });

  it('diffs days', () => {
    expect(LocalDate.diffDays(d('2027-01-31'), d('2027-01-01'))).toBe(30);
  });

  it('reports the weekday with Sunday as 0', () => {
    // 2027-01-15 is a Friday.
    expect(LocalDate.dayOfWeek(d('2027-01-15'))).toBe(5);
  });

  it('finds month bounds', () => {
    expect(LocalDate.toISO(LocalDate.endOfMonth(d('2028-02-10')))).toBe('2028-02-29');
  });
});

describe('DateRange', () => {
  const r = () => {
    const x = DateRange.of(d('2027-01-01'), d('2027-01-10'));
    if (!x.ok) throw new Error('fixture');
    return x.value;
  };

  it('rejects an inverted range', () => {
    const x = DateRange.of(d('2027-01-10'), d('2027-01-01'));
    expect(x.ok).toBe(false);
    expect(!x.ok && x.error.code).toBe('RANGE_INVERTED');
  });

  it('is inclusive at both ends', () => {
    expect(DateRange.contains(r(), d('2027-01-01'))).toBe(true);
    expect(DateRange.contains(r(), d('2027-01-10'))).toBe(true);
    expect(DateRange.contains(r(), d('2027-01-11'))).toBe(false);
  });

  it('counts inclusive length', () => {
    expect(DateRange.lengthInDays(r())).toBe(10);
    expect(DateRange.days(r())).toHaveLength(10);
  });

  it('detects overlap at the boundary', () => {
    const b = DateRange.of(d('2027-01-10'), d('2027-01-20'));
    expect(b.ok && DateRange.overlaps(r(), b.value)).toBe(true);
  });

  it('detects non-overlap', () => {
    const b = DateRange.of(d('2027-01-11'), d('2027-01-20'));
    expect(b.ok && DateRange.overlaps(r(), b.value)).toBe(false);
  });
});
