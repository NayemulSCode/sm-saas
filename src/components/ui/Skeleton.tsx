import type { HTMLAttributes } from 'react';
import { cx } from './cx';

/** A loading placeholder. Never the only signal that a screen is busy —
 * pair it with an accessible status region for anything not near-instant. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cx('animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-surface-sunken)]', className)}
      {...props}
    />
  );
}
