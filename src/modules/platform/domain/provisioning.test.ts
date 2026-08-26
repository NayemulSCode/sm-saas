import { describe, it, expect } from 'vitest';
import { LocalDate } from '../../../shared/date';
import {
  isValidSlug,
  suggestSlug,
  defaultAcademicYear,
  DEFAULT_CLASS_LEVELS,
  DEFAULT_SHIFTS,
} from './provisioning';

describe('isValidSlug', () => {
  it('accepts what the database CHECK accepts', () => {
    expect(isValidSlug('dhaka-model-school')).toBe(true);
    expect(isValidSlug('abc')).toBe(true);
    expect(isValidSlug('a1b')).toBe(true);
  });

  it('rejects a leading or trailing dash — it ends up in every printed URL', () => {
    expect(isValidSlug('-school')).toBe(false);
    expect(isValidSlug('school-')).toBe(false);
  });

  it('rejects uppercase, spaces and anything not a-z0-9-', () => {
    expect(isValidSlug('Dhaka')).toBe(false);
    expect(isValidSlug('dhaka model')).toBe(false);
    expect(isValidSlug('dhaka_model')).toBe(false);
    expect(isValidSlug('ঢাকা')).toBe(false);
  });

  it('rejects too short and too long', () => {
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('a'.repeat(51))).toBe(false);
    expect(isValidSlug('a'.repeat(50))).toBe(true);
  });
});

describe('suggestSlug', () => {
  it('produces something the CHECK accepts', () => {
    for (const name of [
      'Dhaka Model School & College',
      '  Rajshahi   High School  ',
      'St. Joseph’s',
      'A B',
      'ঢাকা আদর্শ বিদ্যালয়',
    ]) {
      const slug = suggestSlug(name);
      expect(isValidSlug(slug), `${name} → ${slug}`).toBe(true);
    }
  });

  it('collapses punctuation and spaces to single dashes', () => {
    expect(suggestSlug('Dhaka Model School & College')).toBe('dhaka-model-school-college');
  });

  // A Bangla-only name transliterates to nothing, and an empty slug would fail
  // the CHECK at insert time rather than here.
  it('still yields a valid slug when nothing survives', () => {
    expect(isValidSlug(suggestSlug('ঢাকা'))).toBe(true);
  });

  it('never exceeds the 50-character limit', () => {
    expect(suggestSlug('A'.repeat(200)).length).toBeLessThanOrEqual(50);
  });
});

describe('defaultAcademicYear', () => {
  // Bangladesh runs the academic year on the calendar year.
  it('is January to December of the current year', () => {
    const y = defaultAcademicYear(LocalDate.of(2027, 3, 14));
    expect(y.name).toBe('2027');
    expect(LocalDate.toISO(y.startDate)).toBe('2027-01-01');
    expect(LocalDate.toISO(y.endDate)).toBe('2027-12-31');
  });

  /*
   * A school signing up in November is setting up for next year. Putting them
   * in the current one would make closing it their first administrative act.
   */
  it('rolls to next year for a school provisioned in November or December', () => {
    expect(defaultAcademicYear(LocalDate.of(2027, 11, 1)).name).toBe('2028');
    expect(defaultAcademicYear(LocalDate.of(2027, 12, 31)).name).toBe('2028');
  });

  it('does not roll in October', () => {
    expect(defaultAcademicYear(LocalDate.of(2027, 10, 31)).name).toBe('2027');
  });
});

describe('the default ladder', () => {
  it('is in strictly increasing promotion order', () => {
    const seqs = DEFAULT_CLASS_LEVELS.map((c) => c.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('leaves room to insert a class without renumbering everything', () => {
    const gaps = DEFAULT_CLASS_LEVELS.slice(1).map(
      (c, i) => c.sequence - DEFAULT_CLASS_LEVELS[i]!.sequence,
    );
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(10);
  });

  // FR-2.6 — kindergarten students have no login at all.
  it('gives the pre-primary rungs no login', () => {
    for (const name of ['Play', 'Nursery', 'KG']) {
      expect(DEFAULT_CLASS_LEVELS.find((c) => c.nameEn === name)?.loginEnabled).toBe(false);
    }
  });

  it('gives every class both names, neither a translation of the other', () => {
    for (const c of DEFAULT_CLASS_LEVELS) {
      expect(c.nameBn.length).toBeGreaterThan(0);
      expect(c.nameEn.length).toBeGreaterThan(0);
      expect(c.nameBn).not.toBe(c.nameEn);
    }
  });

  // Names are compared for equality elsewhere; NFC on write is not optional.
  it('stores Bangla names already in NFC', () => {
    for (const c of DEFAULT_CLASS_LEVELS) {
      expect(c.nameBn).toBe(c.nameBn.normalize('NFC'));
    }
  });
});

describe('the default shift', () => {
  /*
   * Not morning + day. An unused shift has its own working-day calendar, which
   * would sit empty and look like a bug.
   */
  it('is exactly one', () => {
    expect(DEFAULT_SHIFTS).toHaveLength(1);
  });

  it('ends after it starts', () => {
    for (const s of DEFAULT_SHIFTS) {
      expect(s.endTime > s.startTime).toBe(true);
    }
  });
});
