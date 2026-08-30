import type { LabelHTMLAttributes } from 'react';
import { cx } from './cx';

export function Label({
  className,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>): React.JSX.Element {
  return <label className={cx('block text-sm font-medium text-[var(--color-text)]', className)} {...props} />;
}
