'use client';

/**
 * The only place a money STRING gets parsed from user input. §12.1:
 * "Accepts/emits minor units; parses Bangla or Latin digits; rejects >2
 * decimals." Parsing goes through `Money.parseMajor` exclusively — this
 * component owns no arithmetic of its own, the same discipline invariant 2
 * applies everywhere else money is touched.
 *
 * Works in MAJOR units for display — a person types "১,৫০০.৫০", not
 * "150050" — and emits MINOR units via `onChange`, the same shape the wire
 * contract (`zMoney`) expects. `value` seeds the field once, at mount; this
 * component is the source of truth for what is typed after that, the same
 * simplification every formatted-number input makes rather than fighting a
 * fully round-tripped controlled value while a person is mid-keystroke. A
 * caller that needs to reset the field remounts it with a new `key`.
 */

import { useState } from 'react';
import { Money } from '../../shared/money';
import { Input } from '../ui/Input';
import { FieldError } from '../ui/FieldError';

export interface MoneyInputProps {
  id?: string;
  name?: string;
  /** Minor units, as a wire string — the initial value only (see file header). */
  value: string;
  onChange: (minorUnits: string) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

export function MoneyInput({
  id,
  name,
  value,
  onChange,
  placeholder,
  required,
  disabled,
  autoFocus,
  ...aria
}: MoneyInputProps): React.JSX.Element {
  const [text, setText] = useState(() =>
    value === '0' || value === ''
      ? ''
      : Money.format(Money.fromJSON(value), { locale: 'en', numerals: 'latin', showSymbol: false }),
  );
  const [error, setError] = useState<string | null>(null);

  function handleChange(raw: string): void {
    setText(raw);

    if (raw.trim() === '') {
      setError(null);
      onChange('0');
      return;
    }

    const parsed = Money.parseMajor(raw);
    if (!parsed.ok) {
      setError(
        parsed.error.code === 'TOO_MANY_DECIMALS'
          ? 'At most two decimal places.'
          : 'Enter a valid amount.',
      );
      // The last successfully parsed value is left in place upstream — an
      // unparsable string is never propagated as if it meant zero.
      return;
    }

    setError(null);
    onChange(parsed.value.minor.toString());
  }

  return (
    <div>
      <Input
        id={id}
        name={name}
        inputMode="decimal"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder ?? '0.00'}
        required={required}
        disabled={disabled}
        autoFocus={autoFocus}
        invalid={Boolean(error)}
        {...aria}
      />
      <FieldError>{error ?? undefined}</FieldError>
    </div>
  );
}
