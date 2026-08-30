/**
 * Digit rendering per tenant preference, with Indic grouping. §12.1.
 *
 * ১,২৩,৪৫৬ — lakh/crore grouping, not ১২৩,৪৫৬ thousands grouping. For a plain
 * count or a roll number, not money — `MoneyText` is the money equivalent
 * and shares the same `groupIndic` (`shared/money.ts`) rather than a second
 * copy of the algorithm.
 *
 * `numerals` is a prop, not read from `tenant.numerals` here: nothing in
 * this slice threads that column through AuthContext yet (it exists in the
 * schema, unused — a real, separate gap, not silently worked around by
 * guessing at a wiring path). A call site passes the locale it already has.
 */

import { toBanglaDigits, groupIndic } from '../../shared/money';

export interface BanglaNumberProps {
  value: number | bigint;
  numerals?: 'latin' | 'bn';
  grouped?: boolean;
  className?: string;
}

export function BanglaNumber({
  value,
  numerals = 'bn',
  grouped = true,
  className,
}: BanglaNumberProps): React.JSX.Element {
  const negative = typeof value === 'bigint' ? value < 0n : value < 0;
  const abs = typeof value === 'bigint' ? (negative ? -value : value) : negative ? -value : value;
  let text = abs.toString();
  if (grouped) text = groupIndic(text);
  if (numerals === 'bn') text = toBanglaDigits(text);
  return (
    <span className={className}>
      {negative ? '-' : ''}
      {text}
    </span>
  );
}
