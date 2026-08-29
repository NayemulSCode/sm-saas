/**
 * Phone-OTP for guardians, password for staff (§8.2, §8.3).
 *
 * A server component wrapping one client island. The page itself — heading,
 * chrome, layout — ships as HTML; only the form needs to be interactive, and
 * the guardian surface has the tightest bundle budget in the product at 150 KB.
 */

import { LoginForm } from './LoginForm';

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <p className="mt-2 mb-6 text-[var(--color-text-muted)]">
        Guardians sign in with a code sent to their phone. Staff use a password.
      </p>
      <LoginForm locale={locale} />
    </main>
  );
}
