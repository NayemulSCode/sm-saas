/** Staff surface. Budget: 180 KB first-load JS (§4.4). */
export default function StaffDashboard(): React.JSX.Element {
  return (
    <main className="p-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <p className="mt-2 text-[var(--color-text-muted)]">
        Staff surface — collection totals, attendance summary. Phase 3b.
      </p>
    </main>
  );
}
