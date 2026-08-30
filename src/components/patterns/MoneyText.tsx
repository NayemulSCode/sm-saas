/**
 * The only place `/100` happens on the way out. §12.1.
 *
 * Display only — never used for arithmetic or transport (`Money.format`'s
 * own contract). Takes minor units directly so a call site never needs its
 * own `Money.fromMinor` just to print an amount.
 */

import { Money } from '../../shared/money';

export interface MoneyTextProps {
  minor: bigint;
  locale?: 'en' | 'bn';
  numerals?: 'latin' | 'bn';
  showSymbol?: boolean;
  className?: string;
}

export function MoneyText({
  minor,
  locale = 'en',
  numerals = locale === 'bn' ? 'bn' : 'latin',
  showSymbol = true,
  className,
}: MoneyTextProps): React.JSX.Element {
  return <span className={className}>{Money.format(Money.fromMinor(minor), { locale, numerals, showSymbol })}</span>;
}
