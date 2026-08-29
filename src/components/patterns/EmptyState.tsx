import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string | undefined;
  action?: ReactNode;
}

/**
 * "No students yet. Import or add one." — never a bare "No results". Empty
 * is a state the product should explain, not one it apologises for (§12.1).
 */
export function EmptyState({ title, description, action }: EmptyStateProps): React.JSX.Element {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border)] p-8 text-center">
      <p className="font-medium text-[var(--color-text)]">{title}</p>
      {description && <p className="mt-1 text-sm text-[var(--color-text-muted)]">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
