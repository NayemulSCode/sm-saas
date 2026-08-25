import type { ReactNode } from 'react';

/**
 * Operator console — its own HOSTNAME (admin.*), not a path.
 *
 * Reached only through PLATFORM_HOST. It uses the operator session and the
 * sm_platform pool, which is the one role permitted past RLS — so it must not
 * be reachable from a tenant subdomain by any routing mistake (§5.1, ADR-0029).
 */
export default function PlatformLayout({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-[var(--color-border)] px-6 py-3 text-sm font-medium">
        Platform console
      </header>
      {children}
    </div>
  );
}
