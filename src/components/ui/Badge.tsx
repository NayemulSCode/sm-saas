import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--color-surface-sunken)] text-[var(--color-text-muted)]',
  brand: 'bg-[var(--brand-primary)] text-[var(--brand-on-primary)]',
  success: 'bg-[var(--color-success)] text-white',
  warning: 'bg-[var(--color-warning)] text-white',
  danger: 'bg-[var(--color-danger)] text-white',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/** A status pill — role, exam state, evidence tag. Never the only carrier of
 * meaning: colour is decoration for a label that is already legible as text. */
export function Badge({ tone = 'neutral', className, ...props }: BadgeProps): React.JSX.Element {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
