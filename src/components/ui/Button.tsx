import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] font-medium ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-60';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--brand-primary)] text-[var(--brand-on-primary)] ' +
    'hover:bg-[var(--brand-primary-hover)] active:bg-[var(--brand-primary-active)]',
  secondary:
    'border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-text)] ' +
    'hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-active)]',
  ghost:
    'text-[var(--color-text)] hover:bg-[var(--color-surface-hover)] active:bg-[var(--color-surface-active)]',
  destructive:
    'bg-[var(--color-danger)] text-white hover:opacity-90 active:opacity-80',
};

/**
 * ≥44px is the touch-target minimum on a touch-primary screen (WCAG 2.2
 * §2.5.8, §28). `sm` is deliberately BELOW that line — it exists for icon
 * buttons inside a row that already carries its own 44px hit area (a table
 * action), never as a lone tap target on its own.
 */
const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-9 px-3 text-sm',
  md: 'min-h-11 px-4 text-base',
  lg: 'min-h-12 px-6 text-base',
};

/** Returns the class string alone — for an anchor/`next/link` styled as a button. */
export function buttonVariants(opts: {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  className?: string | undefined;
} = {}): string {
  const { variant = 'primary', size = 'md', className } = opts;
  return cx(BASE, VARIANTS[variant], SIZES[size], className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
}

/**
 * `type="button"` by default. A form's one submit button opts in explicitly —
 * this is what stops a second, decorative button in the same form from
 * submitting it.
 */
export function Button({
  variant,
  size,
  className,
  type = 'button',
  ...props
}: ButtonProps): React.JSX.Element {
  return <button type={type} className={buttonVariants({ variant, size, className })} {...props} />;
}
