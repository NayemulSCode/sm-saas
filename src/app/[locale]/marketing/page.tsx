/**
 * Product marketing — sm.example.com. Sells the platform to schools.
 * Unauthenticated, cacheable, no tenant context.
 */
export default function MarketingPage(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">School Management SaaS</h1>
      <p className="mt-2 text-[var(--color-text-muted)]">
        Marketing surface. Phase 3e.
      </p>
    </main>
  );
}
