/**
 * Guardian surface. Budget: 150 KB — the TIGHTEST in the product.
 * Separate route group from (staff) precisely so it cannot import the admin
 * table stack by accident (§20.1).
 */
export default function GuardianChildren(): React.JSX.Element {
  return (
    <main className="p-6">
      <h1 className="text-xl font-semibold">My children</h1>
      <p className="mt-2 text-[var(--color-text-muted)]">
        Guardian surface — results, dues, attendance. Phase 3b.
      </p>
    </main>
  );
}
