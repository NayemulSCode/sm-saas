import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cx } from './cx';

/**
 * A static, styled table shell — thead/tbody/rows, nothing virtualised.
 *
 * This is deliberately NOT the `DataTable` pattern from §12.1. `DataTable` is
 * TanStack Table + Virtual over a keyset cursor, spec'd to be built alongside
 * fee collection (§12.6, Phase 3b) where a real 400-row consumer exists to
 * drive its contract. Every list screen shipped before then — the ones in
 * this file's callers today — is well under a page of rows and gains nothing
 * from virtualisation, so it gets the plain version instead of a speculative
 * one built ahead of a real requirement.
 *
 * The scrolling container is baked in here rather than left to each caller:
 * a table that scrolls the whole page sideways on a phone is a recurring
 * mistake this component makes structurally impossible.
 */
export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>): React.JSX.Element {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
      <table className={cx('w-full text-left text-sm', className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <thead className={cx('bg-[var(--color-surface-sunken)]', className)} {...props} />;
}

export function TableBody(props: HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element {
  return <tbody {...props} />;
}

export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>): React.JSX.Element {
  return (
    <tr
      className={cx('border-t border-[var(--color-border)] first:border-t-0', className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return <th scope="col" className={cx('px-3 py-2 font-medium text-[var(--color-text)]', className)} {...props} />;
}

export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  return <td className={cx('px-3 py-2', className)} {...props} />;
}
