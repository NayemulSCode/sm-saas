import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from './cx';

const FIELD_BASE =
  'w-full rounded-[var(--radius-sm)] border bg-[var(--color-surface-raised)] px-3 text-base ' +
  'text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] disabled:opacity-60';

/** ≥44px tall — the touch-target minimum this product is measured against (§28). */
const FIELD_HEIGHT = 'min-h-11 py-2';

function borderFor(invalid?: boolean): string {
  return invalid ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)]';
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Sets the danger border and should mirror `aria-invalid` at the call site. */
  invalid?: boolean;
}

export function Input({ invalid, className, ...props }: InputProps): React.JSX.Element {
  return <input className={cx(FIELD_BASE, FIELD_HEIGHT, borderFor(invalid), className)} {...props} />;
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, ...props }: TextareaProps): React.JSX.Element {
  return (
    <textarea
      className={cx(FIELD_BASE, 'min-h-24 py-2', borderFor(invalid), className)}
      {...props}
    />
  );
}
