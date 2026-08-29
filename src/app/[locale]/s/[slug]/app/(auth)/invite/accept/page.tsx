/**
 * Where an invite link lands: set a password, and be signed in.
 *
 * The staff screen hands out this URL, so it has to exist. The endpoint behind
 * it opens a session on success (§8.3) — bouncing somebody to a login form for
 * a password they set two seconds ago is the kind of detail that makes a
 * product feel unfinished.
 */

import { AcceptInviteForm } from './AcceptInviteForm';

export default async function AcceptInvitePage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<React.JSX.Element> {
  const { locale } = await params;

  return (
    <main className="mx-auto max-w-sm p-8">
      <h1 className="text-xl font-semibold">Set your password</h1>
      <p className="mt-2 mb-6 text-[var(--color-text-muted)]">
        Choose a password for your account. You will be signed in straight away.
      </p>
      <AcceptInviteForm locale={locale} />
    </main>
  );
}
