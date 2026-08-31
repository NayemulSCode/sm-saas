import { describe, it, expect } from 'vitest';
import { LocalDate } from '../../../../shared/date';
import { fiscalYearOf } from './fiscalYear';

const d = (iso: string): LocalDate => {
  const r = LocalDate.parse(iso);
  if (!r.ok) throw new Error(`bad test date: ${iso}`);
  return r.value;
};

describe('fiscalYearOf', () => {
  it('collapses to the calendar year when the fiscal year starts in January', () => {
    expect(fiscalYearOf(d('2027-01-01'), 1)).toBe(2027);
    expect(fiscalYearOf(d('2027-12-31'), 1)).toBe(2027);
  });

  it('a July-starting fiscal year: August lands in the year it started', () => {
    expect(fiscalYearOf(d('2027-08-15'), 7)).toBe(2027);
  });

  it('a July-starting fiscal year: March lands in the PREVIOUS calendar year — that fiscal year has not ended yet', () => {
    expect(fiscalYearOf(d('2027-03-15'), 7)).toBe(2026);
  });

  it('the boundary month itself belongs to the new fiscal year', () => {
    expect(fiscalYearOf(d('2027-07-01'), 7)).toBe(2027);
    expect(fiscalYearOf(d('2027-06-30'), 7)).toBe(2026);
  });
});
