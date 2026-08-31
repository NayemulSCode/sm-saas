import { describe, it, expect } from 'vitest';
import { Money } from '../../../../shared/money';
import { priceStudentFees, type ApplicableDiscount, type StructureLine } from './price';

const bdt = (minor: bigint) => Money.fromMinor(minor);
const classLine = (feeHeadId: string, minor: bigint): StructureLine => ({
  feeHeadId,
  amountMinor: bdt(minor),
  scope: 'class',
});
const sectionLine = (feeHeadId: string, minor: bigint): StructureLine => ({
  feeHeadId,
  amountMinor: bdt(minor),
  scope: 'section',
});
const valueDiscount = (feeHeadId: string | null, minor: bigint): ApplicableDiscount => ({
  feeHeadId,
  valueMinor: bdt(minor),
  percent: null,
});
const percentDiscount = (feeHeadId: string | null, percent: string): ApplicableDiscount => ({
  feeHeadId,
  valueMinor: null,
  percent,
});

describe('priceStudentFees', () => {
  it('prices from the class-wide structure row when nothing overrides it', () => {
    const priced = priceStudentFees([classLine('tuition', 150000n)], [], []);
    expect(priced).toEqual([{ feeHeadId: 'tuition', amountMinor: bdt(150000n), discountMinor: bdt(0n) }]);
  });

  it('a section-specific row beats the class-wide row for the same head', () => {
    const priced = priceStudentFees(
      [classLine('tuition', 150000n), sectionLine('tuition', 200000n)],
      [],
      [],
    );
    expect(priced).toEqual([{ feeHeadId: 'tuition', amountMinor: bdt(200000n), discountMinor: bdt(0n) }]);
  });

  it('an assignment override beats structure entirely, class or section', () => {
    const priced = priceStudentFees(
      [classLine('tuition', 150000n), sectionLine('tuition', 200000n)],
      [{ feeHeadId: 'tuition', amountMinor: bdt(50000n) }], // scholarship
      [],
    );
    expect(priced).toEqual([{ feeHeadId: 'tuition', amountMinor: bdt(50000n), discountMinor: bdt(0n) }]);
  });

  it('an assignment can introduce a head the structure never priced', () => {
    const priced = priceStudentFees(
      [],
      [{ feeHeadId: 'transport', amountMinor: bdt(80000n) }],
      [],
    );
    expect(priced).toEqual([{ feeHeadId: 'transport', amountMinor: bdt(80000n), discountMinor: bdt(0n) }]);
  });

  it('a percent discount computes off the gross amount, rounded to the nearest poisha', () => {
    const priced = priceStudentFees(
      [classLine('tuition', 150000n)],
      [],
      [percentDiscount('tuition', '10.00')],
    );
    expect(priced[0]?.discountMinor).toEqual(bdt(15000n)); // 10% of 150000
  });

  it('a value discount larger than the line is capped at the line, never negative', () => {
    const priced = priceStudentFees(
      [classLine('tuition', 50000n)],
      [],
      [valueDiscount('tuition', 999999n)],
    );
    expect(priced[0]?.discountMinor).toEqual(bdt(50000n)); // capped, not 999999
  });

  it('a discount with no feeHeadId applies to every head', () => {
    const priced = priceStudentFees(
      [classLine('tuition', 100000n), classLine('exam', 30000n)],
      [],
      [percentDiscount(null, '50.00')], // sibling discount, half off everything
    );
    const byHead = Object.fromEntries(priced.map((p) => [p.feeHeadId, p.discountMinor.minor]));
    expect(byHead['tuition']).toBe(50000n);
    expect(byHead['exam']).toBe(15000n);
  });

  it('several discounts on the same head stack, but still cap at the line', () => {
    const priced = priceStudentFees(
      [classLine('tuition', 100000n)],
      [],
      [percentDiscount('tuition', '60.00'), percentDiscount('tuition', '60.00')], // 120% before capping
    );
    expect(priced[0]?.discountMinor).toEqual(bdt(100000n)); // capped, not 120000
  });

  it('a discount for a different head does not apply', () => {
    const priced = priceStudentFees(
      [classLine('tuition', 100000n)],
      [],
      [valueDiscount('exam', 10000n)],
    );
    expect(priced[0]?.discountMinor).toEqual(bdt(0n));
  });

  it('nothing priced, nothing owed', () => {
    expect(priceStudentFees([], [], [])).toEqual([]);
  });

  it('is deterministic and sorted by fee head id, regardless of input order', () => {
    const priced = priceStudentFees(
      [classLine('zzz', 1000n), classLine('aaa', 2000n)],
      [],
      [],
    );
    expect(priced.map((p) => p.feeHeadId)).toEqual(['aaa', 'zzz']);
  });
});
