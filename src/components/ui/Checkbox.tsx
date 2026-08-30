import type { InputHTMLAttributes } from 'react';
import { cx } from './cx';

/**
 * A native checkbox, sized to the 44px touch target via its hit area (the
 * box itself stays visually smaller — a 44px square checkbox reads as a
 * design defect, so the padding does the work instead of the input itself).
 */
export function Checkbox({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <span className="inline-flex min-h-11 min-w-11 items-center justify-center">
      <input
        type="checkbox"
        className={cx('size-5 accent-[var(--brand-primary)]', className)}
        {...props}
      />
    </span>
  );
}
