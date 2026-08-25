/**
 * Money — integer minor units (poisha). Invariant 2.
 *
 * There is no floating point anywhere in this file and no code path that
 * converts a Money to `number`. `bigint` and `number` do not mix in TypeScript,
 * so an accidental `amount / 100` is a compile error rather than a rounding bug.
 *
 * Marks use this type too, with `currency` ignored: 1 mark = 100 minor units.
 * That buys exact 0.5 and 0.25 grading and reuses one rounding implementation.
 */

export type Currency = 'BDT';

export interface Money {
  readonly minor: bigint;
  readonly currency: Currency;
}

export type MoneyError =
  | { code: 'NOT_A_NUMBER'; input: string }
  | { code: 'TOO_MANY_DECIMALS'; input: string }
  | { code: 'CURRENCY_MISMATCH'; a: Currency; b: Currency };

/** Bangla digits ০–৯ map to Latin. A user on a Bangla keypad types these. */
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';

export function toLatinDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const i = BN_DIGITS.indexOf(ch);
    out += i === -1 ? ch : String(i);
  }
  return out;
}

export function toBanglaDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const d = ch.charCodeAt(0) - 48;
    out += d >= 0 && d <= 9 ? BN_DIGITS[d] : ch;
  }
  return out;
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

/** Round-half-to-even on an exact bigint quotient. Ties go to the even result. */
function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('Division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const q = n / d;
  const r = n % d;
  const twice = r * 2n;

  let result: bigint;
  if (twice > d) result = q + 1n;
  else if (twice < d) result = q;
  else result = q % 2n === 0n ? q : q + 1n; // exact tie → nearest even

  return negative ? -result : result;
}

/** Indic grouping: 1,23,456.78 — lakh/crore, NOT thousands. */
function groupIndic(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${grouped},${last3}`;
}

export const Money = {
  zero(currency: Currency = 'BDT'): Money {
    return { minor: 0n, currency };
  },

  fromMinor(minor: bigint | number, currency: Currency = 'BDT'): Money {
    if (typeof minor === 'number' && !Number.isInteger(minor)) {
      throw new Error(`Money.fromMinor requires an integer, got ${minor}`);
    }
    return { minor: BigInt(minor), currency };
  },

  /**
   * Parse a user-typed major-unit string. Accepts Bangla or Latin digits and
   * thousands separators. Rejects more than two decimal places rather than
   * rounding — silently dropping a poisha the user typed is not acceptable.
   */
  parseMajor(input: string, currency: Currency = 'BDT'): MoneyResult {
    const raw = toLatinDigits(input).replace(/[\s,৳]/g, '').trim();
    if (raw === '' || !/^-?\d+(\.\d+)?$/.test(raw)) {
      return { ok: false, error: { code: 'NOT_A_NUMBER', input } };
    }
    const negative = raw.startsWith('-');
    const unsigned = negative ? raw.slice(1) : raw;
    const [whole = '0', frac = ''] = unsigned.split('.');
    if (frac.length > 2) {
      return { ok: false, error: { code: 'TOO_MANY_DECIMALS', input } };
    }
    const minor = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0') || '0');
    return { ok: true, value: { minor: negative ? -minor : minor, currency } };
  },

  add(a: Money, b: Money): Money {
    assertSameCurrency(a, b);
    return { minor: a.minor + b.minor, currency: a.currency };
  },

  sub(a: Money, b: Money): Money {
    assertSameCurrency(a, b);
    return { minor: a.minor - b.minor, currency: a.currency };
  },

  neg(a: Money): Money {
    return { minor: -a.minor, currency: a.currency };
  },

  compare(a: Money, b: Money): -1 | 0 | 1 {
    assertSameCurrency(a, b);
    return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
  },

  isZero(a: Money): boolean {
    return a.minor === 0n;
  },

  isNegative(a: Money): boolean {
    return a.minor < 0n;
  },

  min(a: Money, b: Money): Money {
    return Money.compare(a, b) <= 0 ? a : b;
  },

  max(a: Money, b: Money): Money {
    return Money.compare(a, b) >= 0 ? a : b;
  },

  /** Percentage or ratio, e.g. a 12.5% discount. Banker's rounding. */
  mulRatio(a: Money, numerator: bigint, denominator: bigint): Money {
    return {
      minor: divRoundHalfEven(a.minor * numerator, denominator),
      currency: a.currency,
    };
  },

  /**
   * Split across n equal parts so the parts ALWAYS sum to the whole.
   * Remainder poisha go to the earliest parts.
   *   allocate(৳1000, 3) → 33334, 33333, 33333
   */
  allocate(a: Money, parts: number): Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new Error(`allocate requires a positive integer, got ${parts}`);
    }
    const n = BigInt(parts);
    const sign = a.minor < 0n ? -1n : 1n;
    const total = a.minor * sign;

    const base = total / n;
    let remainder = total - base * n;

    const out: Money[] = [];
    for (let i = 0; i < parts; i++) {
      const extra = remainder > 0n ? 1n : 0n;
      remainder -= extra;
      out.push({ minor: (base + extra) * sign, currency: a.currency });
    }
    return out;
  },

  /**
   * Split proportionally to weights, preserving the total exactly
   * (largest-remainder method). Used by proportional fee allocation.
   */
  allocateByWeights(a: Money, weights: readonly bigint[]): Money[] {
    if (weights.length === 0) throw new Error('allocateByWeights needs weights');
    const totalWeight = weights.reduce((s, w) => s + w, 0n);
    if (totalWeight <= 0n) return weights.map(() => Money.zero(a.currency));

    const sign = a.minor < 0n ? -1n : 1n;
    const total = a.minor * sign;

    const floors: bigint[] = [];
    const remainders: { index: number; rem: bigint }[] = [];
    let allocated = 0n;

    for (let i = 0; i < weights.length; i++) {
      const w = weights[i] ?? 0n;
      const exact = total * w;
      const q = exact / totalWeight;
      floors.push(q);
      remainders.push({ index: i, rem: exact - q * totalWeight });
      allocated += q;
    }

    // Distribute the shortfall to the largest remainders, ties by index.
    let shortfall = total - allocated;
    remainders.sort((x, y) => (y.rem === x.rem ? x.index - y.index : y.rem > x.rem ? 1 : -1));
    for (const r of remainders) {
      if (shortfall <= 0n) break;
      floors[r.index] = (floors[r.index] ?? 0n) + 1n;
      shortfall -= 1n;
    }

    return floors.map((m) => ({ minor: m * sign, currency: a.currency }));
  },

  /** Display only. Never used for arithmetic or transport. */
  format(
    a: Money,
    opts: { locale: 'en' | 'bn'; numerals: 'latin' | 'bn'; showSymbol?: boolean },
  ): string {
    const negative = a.minor < 0n;
    const abs = negative ? -a.minor : a.minor;
    const whole = (abs / 100n).toString();
    const frac = (abs % 100n).toString().padStart(2, '0');

    let text = `${groupIndic(whole)}.${frac}`;
    if (opts.numerals === 'bn') text = toBanglaDigits(text);
    if (opts.showSymbol !== false) text = `৳${text}`;
    return negative ? `-${text}` : text;
  },

  /**
   * Bangla amount-in-words for receipts. Indic system: koti / lakh / hazar.
   * NOT a translation of an English words-generator — the grouping differs.
   */
  toWordsBn(a: Money): string {
    const negative = a.minor < 0n;
    const abs = negative ? -a.minor : a.minor;
    const taka = abs / 100n;
    const poisha = abs % 100n;

    const parts: string[] = [];
    if (taka > 0n) parts.push(`${banglaInt(taka)} টাকা`);
    if (poisha > 0n) parts.push(`${banglaInt(poisha)} পয়সা`);
    if (parts.length === 0) parts.push('শূন্য টাকা');

    const body = parts.join(' ');
    return negative ? `ঋণাত্মক ${body}` : body;
  },

  /** Wire format: a STRING of minor units. A JSON number would lose precision. */
  toJSON(a: Money): string {
    return a.minor.toString();
  },

  fromJSON(s: string, currency: Currency = 'BDT'): Money {
    if (!/^-?\d+$/.test(s)) throw new Error(`Invalid money string: ${s}`);
    return { minor: BigInt(s), currency };
  },
};

/** Result shape used only by parseMajor, to avoid a circular import. */
type MoneyResult = { ok: true; value: Money } | { ok: false; error: MoneyError };

// ── Bangla numerals in words ────────────────────────────────────────────────
// 0–99 are irregular in Bangla and need a table; there is no rule to derive
// them from. Above 99 the Indic grouping (হাজার / লক্ষ / কোটি) applies.

const BN_ONES = [
  'শূন্য', 'এক', 'দুই', 'তিন', 'চার', 'পাঁচ', 'ছয়', 'সাত', 'আট', 'নয়',
  'দশ', 'এগারো', 'বারো', 'তেরো', 'চৌদ্দ', 'পনেরো', 'ষোলো', 'সতেরো', 'আঠারো', 'উনিশ',
  'বিশ', 'একুশ', 'বাইশ', 'তেইশ', 'চব্বিশ', 'পঁচিশ', 'ছাব্বিশ', 'সাতাশ', 'আটাশ', 'ঊনত্রিশ',
  'ত্রিশ', 'একত্রিশ', 'বত্রিশ', 'তেত্রিশ', 'চৌত্রিশ', 'পঁয়ত্রিশ', 'ছত্রিশ', 'সাঁইত্রিশ', 'আটত্রিশ', 'ঊনচল্লিশ',
  'চল্লিশ', 'একচল্লিশ', 'বিয়াল্লিশ', 'তেতাল্লিশ', 'চুয়াল্লিশ', 'পঁয়তাল্লিশ', 'ছেচল্লিশ', 'সাতচল্লিশ', 'আটচল্লিশ', 'ঊনপঞ্চাশ',
  'পঞ্চাশ', 'একান্ন', 'বায়ান্ন', 'তিপ্পান্ন', 'চুয়ান্ন', 'পঞ্চান্ন', 'ছাপ্পান্ন', 'সাতান্ন', 'আটান্ন', 'ঊনষাট',
  'ষাট', 'একষট্টি', 'বাষট্টি', 'তেষট্টি', 'চৌষট্টি', 'পঁয়ষট্টি', 'ছেষট্টি', 'সাতষট্টি', 'আটষট্টি', 'ঊনসত্তর',
  'সত্তর', 'একাত্তর', 'বাহাত্তর', 'তিয়াত্তর', 'চুয়াত্তর', 'পঁচাত্তর', 'ছিয়াত্তর', 'সাতাত্তর', 'আটাত্তর', 'ঊনআশি',
  'আশি', 'একাশি', 'বিরাশি', 'তিরাশি', 'চুরাশি', 'পঁচাশি', 'ছিয়াশি', 'সাতাশি', 'আটাশি', 'ঊননব্বই',
  'নব্বই', 'একানব্বই', 'বিরানব্বই', 'তিরানব্বই', 'চুরানব্বই', 'পঁচানব্বই', 'ছিয়ানব্বই', 'সাতানব্বই', 'আটানব্বই', 'নিরানব্বই',
] as const;

function underHundred(n: bigint): string {
  return BN_ONES[Number(n)] ?? '';
}

function underThousand(n: bigint): string {
  const hundreds = n / 100n;
  const rest = n % 100n;
  const out: string[] = [];
  if (hundreds > 0n) out.push(`${underHundred(hundreds)}শত`);
  if (rest > 0n) out.push(underHundred(rest));
  return out.join(' ');
}

function banglaInt(n: bigint): string {
  if (n === 0n) return 'শূন্য';

  const koti = n / 10_000_000n;
  const lakh = (n / 100_000n) % 100n;
  const hazar = (n / 1_000n) % 100n;
  const rest = n % 1_000n;

  const out: string[] = [];
  if (koti > 0n) out.push(`${banglaInt(koti)} কোটি`);
  if (lakh > 0n) out.push(`${underHundred(lakh)} লক্ষ`);
  if (hazar > 0n) out.push(`${underHundred(hazar)} হাজার`);
  if (rest > 0n) out.push(underThousand(rest));
  return out.join(' ');
}
