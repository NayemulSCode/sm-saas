/**
 * `Money` → display. §12.1: "The only place `/100` happens." This component
 * owns no formatting logic of its own — it wraps `Money.format`, so the
 * rounding and grouping rules stay in exactly one place (invariant 2).
 */

import { Money, type Currency } from '../../shared/money';

export interface MoneyTextProps {
  /** Minor units, as a wire string. */
  minorUnits: string;
  currency?: Currency;
  locale?: 'en' | 'bn';
  numerals?: 'latin' | 'bn';
  showSymbol?: boolean;
  className?: string;
}

export function MoneyText({
  minorUnits,
  currency = 'BDT',
  locale = 'en',
  numerals = 'latin',
  showSymbol = true,
  className,
}: MoneyTextProps): React.JSX.Element {
  const amount = Money.fromJSON(minorUnits, currency);
  return <span className={className}>{Money.format(amount, { locale, numerals, showSymbol })}</span>;
}
