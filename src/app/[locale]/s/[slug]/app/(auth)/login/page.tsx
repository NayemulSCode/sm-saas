/**
 * Phone-OTP for guardians, password for staff (§8.2, §8.3).
 * Guardians have NO password — which is also how credential distribution to
 * thousands of guardians is solved: there is nothing to distribute.
 */
export default function LoginPage(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-2 text-[var(--color-text-muted)]">
        Phone OTP for guardians, password for staff. Phase 3a — identity module.
      </p>
    </main>
  );
}
