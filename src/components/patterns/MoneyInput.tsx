'use client';

/**
 * The only place a money string is parsed on the way in. §12.1.
 *
 * Displays and accepts a MAJOR-unit decimal the way a person types it
 * ("500", "৫০০.৫০"), via `Money.parseMajor` — Bangla or Latin digits, at most
 * two decimal places. What actually submits with the form is a hidden input
 * carrying MINOR units as a string, matching `zMoney` on the wire
 * (`src/shared/api/primitives.ts`) exactly, so the parsing this component
 * exists to centralise never has to be redone at the API boundary.
 */

import { useState } from 'react';
import { Money } from '../../shared/money';
import { Label } from '../ui/Label';
import { Input } from '../ui/Input';
import { FieldError, FieldHint } from '../ui/FieldError';

export interface MoneyInputProps {
  /** The field name the MINOR-unit value submits under. */
  name: string;
  id?: string;
  label: string;
  hint?: string;
  /** A server-side error, shown alongside any live parse error. */
  error?: string;
  required?: boolean;
  defaultValueMinor?: bigint;
  className?: string;
}

export function MoneyInput({
  name,
  id,
  label,
  hint,
  error,
  required,
  defaultValueMinor,
  className,
}: MoneyInputProps): React.JSX.Element {
  const fieldId = id ?? name;
  const hintId = hint ? `${fieldId}-hint` : undefined;

  const [display, setDisplay] = useState(() =>
    defaultValueMinor !== undefined
      ? Money.format(Money.fromMinor(defaultValueMinor), { locale: 'en', numerals: 'latin', showSymbol: false })
      : '',
  );
  const [minor, setMinor] = useState<bigint | null>(defaultValueMinor ?? null);
  const [parseError, setParseError] = useState<string | null>(null);

  function handleChange(raw: string): void {
    setDisplay(raw);
    if (raw.trim() === '') {
      setMinor(null);
      setParseError(null);
      return;
    }
    const parsed = Money.parseMajor(raw);
    if (!parsed.ok) {
      setMinor(null);
      setParseError(
        parsed.error.code === 'TOO_MANY_DECIMALS'
          ? 'At most two decimal places.'
          : 'Enter an amount, e.g. 500 or 500.50.',
      );
      return;
    }
    setMinor(parsed.value.minor);
    setParseError(null);
  }

  return (
    <div className={className}>
      <Label htmlFor={fieldId}>{label}</Label>
      <FieldHint id={hintId}>{hint}</FieldHint>
      <Input
        id={fieldId}
        type="text"
        inputMode="decimal"
        value={display}
        onChange={(e) => handleChange(e.target.value)}
        required={required}
        invalid={Boolean(error) || Boolean(parseError)}
        aria-describedby={hintId}
        aria-invalid={error || parseError ? true : undefined}
        placeholder="৫০০.০০"
        className="mt-2"
      />
      {/* The wire value: minor units, matching zMoney. Never the display
          string above — that would resubmit "500.50" where the server
          expects "50050". */}
      <input type="hidden" name={name} value={minor !== null ? minor.toString() : ''} />
      <FieldError>{error ?? parseError ?? undefined}</FieldError>
    </div>
  );
}
