'use client';

/**
 * The invite token IS the credential — there is nothing else to authenticate
 * with, which is the whole point: staff are never told a password, they choose
 * one. It arrives in the query string because that is the only place a link can
 * carry it, so the first thing this does is take it out of the address bar.
 * That keeps it out of the browser history, out of a shoulder-surfed URL, and
 * out of the `Referer` on the next navigation.
 */

import { useEffect, useState, type FormEvent } from 'react';
import { appPath } from '../../../../../../../../shared/paths';

interface ApiError {
  code: string;
  message: string;
  requestId: string;
}

/**
 * Branch on `code`, never on `message` — the message is localised.
 *
 * `INVITE_INVALID` deliberately covers unknown, expired, revoked AND already
 * used: telling them apart would let somebody holding a dead link probe which
 * tokens ever existed. So the copy has to serve all four, and the help-desk
 * answer is the same in every case.
 */
const MESSAGES: Record<string, string> = {
  INVITE_INVALID: 'This link is no longer valid. Ask the office to send a new one.',
  PASSWORD_ALREADY_SET:
    'This account already has a password — sign in with it instead.',
  VALIDATION_FAILED: 'That password is too short — use at least eight characters.',
  RATE_LIMITED: 'Too many attempts. Wait a few minutes and try again.',
};

export function AcceptInviteForm({ locale }: { locale: string }): React.JSX.Element {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [mismatch, setMismatch] = useState(false);

  useEffect(() => {
    const found = new URLSearchParams(window.location.search).get('token');
    setToken(found);
    setReady(true);
    // Strip it from the URL without a navigation, so a reload does not replay
    // the credential and the history entry does not keep it.
    if (found) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setBusy(true);
    setError(null);

    const res = await fetch('/api/v1/auth/invite/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password }),
      credentials: 'same-origin',
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    setBusy(false);

    if (!res.ok) {
      setError(
        (json['error'] as ApiError | undefined) ?? {
          code: 'UNKNOWN',
          message: 'The server did not respond as expected.',
          requestId: '',
        },
      );
      return;
    }
    // The session cookie is already set by the response.
    window.location.assign(appPath(locale, '/dashboard'));
  }

  // Rendered only after the effect, so the server and the first client render
  // agree — the token is not knowable during SSR.
  if (!ready) return <p className="text-sm text-[var(--color-text-muted)]">Checking the link…</p>;

  if (!token) {
    return (
      <p role="alert" className="rounded border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]">
        This link is missing its invite code. Ask the office to send it again.
      </p>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      {error && (
        <p role="alert" className="rounded border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]">
          {MESSAGES[error.code] ?? error.message}
          {error.requestId && (
            <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
              Reference: {error.requestId}
            </span>
          )}
        </p>
      )}

      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          New password
        </label>
        <p id="password-hint" className="mt-1 text-sm text-[var(--color-text-muted)]">
          At least eight characters.
        </p>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          aria-describedby="password-hint"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
        />
      </div>

      <div>
        <label htmlFor="confirm" className="block text-sm font-medium">
          Repeat it
        </label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
        />
        {mismatch && (
          <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
            The two passwords do not match.
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={busy}
        className="min-h-11 w-full rounded bg-[var(--brand-primary)] px-4 py-2 font-medium text-[var(--brand-on-primary)] disabled:opacity-60"
      >
        {busy ? 'Please wait…' : 'Set password and sign in'}
      </button>
    </form>
  );
}
