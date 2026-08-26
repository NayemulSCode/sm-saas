import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PATTERN,
  validatePattern,
  renderCode,
  sequenceOf,
} from './studentCode';

describe('validatePattern', () => {
  it('accepts the default', () => {
    expect(validatePattern(DEFAULT_PATTERN)).toBeNull();
  });

  it('accepts a school prefix and a two-digit year', () => {
    expect(validatePattern('DMS/{YY}/{SEQ:3}')).toBeNull();
  });

  /*
   * A pattern with no sequence produces the same code for every student, which
   * the unique constraint refuses on the SECOND admission — at the counter,
   * with a queue behind them.
   */
  it('refuses a pattern with no sequence token', () => {
    expect(validatePattern('DMS-{YYYY}')?.code).toBe('NO_SEQUENCE');
  });

  it('refuses a typo in braces rather than treating it as a literal', () => {
    expect(validatePattern('{YEAR}-{SEQ}')?.code).toBe('UNKNOWN_TOKEN');
  });

  it('refuses something that will not fit on an ID card', () => {
    expect(validatePattern(`${'x'.repeat(45)}{SEQ}`)?.code).toBe('TOO_LONG');
  });
});

describe('renderCode', () => {
  it('renders the default with a padded sequence', () => {
    expect(renderCode(DEFAULT_PATTERN, 2027, 42)).toBe('2027-0042');
  });

  it('renders a two-digit year', () => {
    expect(renderCode('{YY}{SEQ:3}', 2027, 7)).toBe('27007');
  });

  it('renders an unpadded sequence', () => {
    expect(renderCode('S-{SEQ}', 2027, 7)).toBe('S-7');
  });

  // Padding is a minimum, not a maximum: a school that outgrows four digits
  // keeps issuing codes rather than colliding.
  it('does not truncate a sequence longer than its padding', () => {
    expect(renderCode('{SEQ:3}', 2027, 12345)).toBe('12345');
  });

  it('leaves literal text alone', () => {
    expect(renderCode('DMS/{YYYY}/{SEQ:2}', 2027, 3)).toBe('DMS/2027/03');
  });
});

describe('sequenceOf', () => {
  it('reads back what renderCode wrote', () => {
    for (const pattern of ['{YYYY}-{SEQ:4}', '{YY}{SEQ:3}', 'DMS/{YYYY}/{SEQ:2}', 'S-{SEQ}']) {
      for (const n of [1, 42, 999, 10000]) {
        expect(sequenceOf(pattern, 2027, renderCode(pattern, 2027, n)), `${pattern} ${n}`).toBe(n);
      }
    }
  });

  /*
   * A school that changed its pattern mid-year keeps its old codes: they stay
   * valid and simply do not contribute to the next number.
   */
  it('returns nothing for a code from a different pattern', () => {
    expect(sequenceOf('{YYYY}-{SEQ:4}', 2027, 'OLD/17')).toBeUndefined();
  });

  it('returns nothing for a code from a different year', () => {
    expect(sequenceOf('{YYYY}-{SEQ:4}', 2027, '2026-0001')).toBeUndefined();
  });

  // A prefix containing a regex metacharacter must be matched literally.
  it('handles a dot in the prefix', () => {
    const pattern = 'D.M.S-{SEQ:2}';
    expect(sequenceOf(pattern, 2027, 'D.M.S-07')).toBe(7);
    expect(sequenceOf(pattern, 2027, 'DxMxS-07')).toBeUndefined();
  });

  it('handles brackets and a plus in the prefix', () => {
    expect(sequenceOf('A+[B]-{SEQ}', 2027, 'A+[B]-9')).toBe(9);
  });
});
