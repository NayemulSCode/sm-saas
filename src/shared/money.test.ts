import { describe, it, expect } from 'vitest';
import { Money, toBanglaDigits, toLatinDigits } from './money.js';

const bdt = (minor: bigint) => Money.fromMinor(minor);
const sum = (xs: readonly { minor: bigint }[]) => xs.reduce((s, x) => s + x.minor, 0n);

describe('Money.parseMajor', () => {
  it('parses Latin digits', () => {
    const r = Money.parseMajor('1500.50');
    expect(r.ok && r.value.minor).toBe(150050n);
  });

  it('parses Bangla digits', () => {
    const r = Money.parseMajor('১৫০০.৫০');
    expect(r.ok && r.value.minor).toBe(150050n);
  });

  it('tolerates separators and the taka sign', () => {
    const r = Money.parseMajor('৳ 1,23,456.78');
    expect(r.ok && r.value.minor).toBe(12345678n);
  });

  it('treats a missing fraction as zero poisha', () => {
    const r = Money.parseMajor('1500');
    expect(r.ok && r.value.minor).toBe(150000n);
  });

  // Silently dropping a poisha the user typed is not acceptable.
  it('REJECTS more than two decimals rather than rounding', () => {
    const r = Money.parseMajor('10.999');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('TOO_MANY_DECIMALS');
  });

  it('rejects nonsense', () => {
    expect(Money.parseMajor('abc').ok).toBe(false);
    expect(Money.parseMajor('').ok).toBe(false);
  });

  it('round-trips through the wire format', () => {
    const m = bdt(-150050n);
    expect(Money.fromJSON(Money.toJSON(m)).minor).toBe(m.minor);
  });
});

describe('Money.allocate — total preservation', () => {
  it('splits ৳1000 three ways without inventing or losing a poisha', () => {
    const parts = Money.allocate(bdt(100_000n), 3);
    expect(parts.map((p) => p.minor)).toEqual([33334n, 33333n, 33333n]);
    expect(sum(parts)).toBe(100_000n);
  });

  it('preserves the total for every split of an awkward amount', () => {
    const total = bdt(100_001n);
    for (let n = 1; n <= 17; n++) {
      expect(sum(Money.allocate(total, n))).toBe(100_001n);
    }
  });

  it('handles negatives (refunds) without drift', () => {
    const parts = Money.allocate(bdt(-100_000n), 3);
    expect(sum(parts)).toBe(-100_000n);
  });

  it('rejects a non-positive part count', () => {
    expect(() => Money.allocate(bdt(100n), 0)).toThrow();
  });
});

describe('Money.allocateByWeights — total preservation', () => {
  it('splits proportionally and still sums exactly', () => {
    const parts = Money.allocateByWeights(bdt(10_000n), [1n, 1n, 1n]);
    expect(sum(parts)).toBe(10_000n);
  });

  it('preserves the total across uneven weights', () => {
    const parts = Money.allocateByWeights(bdt(99_999n), [3n, 5n, 7n, 11n]);
    expect(sum(parts)).toBe(99_999n);
  });

  it('gives everything to a single weight', () => {
    const parts = Money.allocateByWeights(bdt(777n), [4n]);
    expect(parts[0]?.minor).toBe(777n);
  });

  it('returns zeros when all weights are zero', () => {
    const parts = Money.allocateByWeights(bdt(500n), [0n, 0n]);
    expect(sum(parts)).toBe(0n);
  });
});

describe("Money.mulRatio — banker's rounding", () => {
  it('rounds an exact tie to even', () => {
    // 5 / 2 = 2.5 → 2 (even)
    expect(Money.mulRatio(bdt(5n), 1n, 2n).minor).toBe(2n);
    // 7 / 2 = 3.5 → 4 (even)
    expect(Money.mulRatio(bdt(7n), 1n, 2n).minor).toBe(4n);
  });

  it('computes a percentage discount', () => {
    // 12.5% of ৳1,000.00
    expect(Money.mulRatio(bdt(100_000n), 125n, 1000n).minor).toBe(12_500n);
  });

  it('is symmetric for negatives', () => {
    expect(Money.mulRatio(bdt(-5n), 1n, 2n).minor).toBe(-2n);
  });
});

describe('Money.format — Indic grouping', () => {
  it('groups as lakh, not thousands', () => {
    expect(Money.format(bdt(12_345_678n), { locale: 'en', numerals: 'latin' }))
      .toBe('৳1,23,456.78');
  });

  it('renders Bangla numerals', () => {
    expect(Money.format(bdt(12_345_678n), { locale: 'bn', numerals: 'bn' }))
      .toBe('৳১,২৩,৪৫৬.৭৮');
  });

  it('does not group below one thousand', () => {
    expect(Money.format(bdt(99_900n), { locale: 'en', numerals: 'latin', showSymbol: false }))
      .toBe('999.00');
  });

  it('keeps the sign outside the symbol', () => {
    expect(Money.format(bdt(-50_000n), { locale: 'en', numerals: 'latin' }))
      .toBe('-৳500.00');
  });
});

describe('Money.toWordsBn', () => {
  it('writes whole taka', () => {
    expect(Money.toWordsBn(bdt(150_000n))).toBe('এক হাজার পাঁচশত টাকা');
  });

  it('writes taka and poisha', () => {
    expect(Money.toWordsBn(bdt(150_050n))).toBe('এক হাজার পাঁচশত টাকা পঞ্চাশ পয়সা');
  });

  it('uses the Indic lakh grouping', () => {
    expect(Money.toWordsBn(bdt(12_345_600n))).toContain('লক্ষ');
  });

  it('uses crore above a hundred lakh', () => {
    expect(Money.toWordsBn(bdt(1_000_000_000n))).toContain('কোটি');
  });

  it('handles zero', () => {
    expect(Money.toWordsBn(Money.zero())).toBe('শূন্য টাকা');
  });

  it('covers the irregular teens and twenties', () => {
    expect(Money.toWordsBn(bdt(1_600n))).toBe('ষোলো টাকা');
    expect(Money.toWordsBn(bdt(5_600n))).toBe('ছাপ্পান্ন টাকা');
  });
});

describe('digit conversion', () => {
  it('round-trips', () => {
    expect(toLatinDigits(toBanglaDigits('2027-01-15'))).toBe('2027-01-15');
  });

  it('leaves non-digits alone', () => {
    expect(toBanglaDigits('Class 5')).toBe('Class ৫');
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(Money.add(bdt(10n), bdt(20n)).minor).toBe(30n);
    expect(Money.sub(bdt(10n), bdt(20n)).minor).toBe(-10n);
  });

  it('the classic float failure does not occur', () => {
    // 0.1 + 0.2 === 0.3 in poisha
    const a = Money.parseMajor('0.10');
    const b = Money.parseMajor('0.20');
    const c = Money.parseMajor('0.30');
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(Money.add(a.value, b.value).minor).toBe(c.value.minor);
    }
  });

  it('compares and orders', () => {
    expect(Money.compare(bdt(1n), bdt(2n))).toBe(-1);
    expect(Money.max(bdt(1n), bdt(2n)).minor).toBe(2n);
    expect(Money.min(bdt(1n), bdt(2n)).minor).toBe(1n);
  });
});
