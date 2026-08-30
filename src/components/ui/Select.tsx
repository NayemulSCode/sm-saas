import type { SelectHTMLAttributes } from 'react';
import { cx } from './cx';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
}

/**
 * A native `<select>` — not a Radix/Combobox rebuild. Keyboard, screen reader
 * and mobile picker behaviour all come free from the platform; the only thing
 * missing visually is the arrow, added back here as an inert SVG so
 * `appearance-none` does not leave the control looking unfinished.
 *
 * Reach for a purpose-built combobox only where a native select cannot do the
 * job — typeahead over a large list is `PersonSearch` (§12.1), not this.
 */
export function Select({ invalid, className, children, ...props }: SelectProps): React.JSX.Element {
  return (
    <div className="relative">
      <select
        className={cx(
          'w-full min-h-11 appearance-none rounded-[var(--radius-sm)] border bg-[var(--color-surface-raised)]',
          'px-3 py-2 pr-9 text-base text-[var(--color-text)] disabled:opacity-60',
          invalid ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)]',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 20 20"
        fill="none"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-text-muted)]"
      >
        <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
