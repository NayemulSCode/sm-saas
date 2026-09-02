'use client';

/**
 * A calendar day, never an instant. §12.1: "`LocalDate` in Asia/Dhaka; never
 * a JS `Date`." A native `<input type="date">` already speaks ISO
 * `YYYY-MM-DD` on the wire regardless of the browser's own display locale —
 * this component's job is making sure that string never gets routed through
 * `new Date(iso)` anywhere upstream or downstream, which is exactly the
 * midnight-UTC-is-06:00-in-Dhaka bug `shared/date.ts` exists to prevent.
 */

import { Input } from '../ui/Input';

export interface DateInputProps {
  id?: string;
  name?: string;
  /** `YYYY-MM-DD`. */
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  required?: boolean;
  disabled?: boolean;
  invalid?: boolean;
}

export function DateInput({
  id,
  name,
  value,
  onChange,
  min,
  max,
  required,
  disabled,
  invalid,
}: DateInputProps): React.JSX.Element {
  return (
    <Input
      type="date"
      id={id}
      name={name}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      min={min}
      max={max}
      required={required}
      disabled={disabled}
      invalid={invalid ?? false}
    />
  );
}
