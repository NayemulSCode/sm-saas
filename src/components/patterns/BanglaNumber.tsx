/**
 * A plain integer — a roll number, a receipt count — rendered with Indic
 * grouping and digit rendering per tenant preference. §12.1: "১,২৩,৪৫৬ —
 * not ১২৩,৪৫৬." NOT for money: that needs currency and decimal handling
 * this deliberately does not carry — use `MoneyText` there instead.
 *
 * Reuses `shared/money.ts`'s own `groupIndic`/`toBanglaDigits` rather than a
 * second implementation of the same grouping rule.
 */

import { groupIndic, toBanglaDigits } from '../../shared/money';

export interface BanglaNumberProps {
  value: number | string;
  numerals?: 'latin' | 'bn';
  className?: string;
}

export function BanglaNumber({
  value,
  numerals = 'latin',
  className,
}: BanglaNumberProps): React.JSX.Element {
  const grouped = groupIndic(String(value));
  const text = numerals === 'bn' ? toBanglaDigits(grouped) : grouped;
  return <span className={className}>{text}</span>;
}
