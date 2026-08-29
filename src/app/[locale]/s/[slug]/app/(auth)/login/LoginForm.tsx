'use client';

/**
 * Sign in. §8.2, §8.3.
 *
 * TWO FLOWS ON ONE SCREEN, and the phone number decides which. Guardians have
 * no password at all — which is also how credential distribution to thousands
 * of them is solved: there is nothing to distribute. Staff have one, but reach
 * it through an invite link rather than being told it.
 *
 * The OTP path is the default because guardians outnumber staff by roughly
 * fifty to one, and it is the path that has to work on a cheap Android handset
 * on 3G.
 */

import { useState, type FormEvent } from 'react';
import { appPath } from '../../../../../../../shared/paths';

type Step = 'identify' | 'code';
type Mode = 'otp' | 'password';

interface Context {
  membershipId: string;
  tenantId: string;
}

interface ApiError {
  code: string;
  message: string;
  requestId: string;
  details?: Array<{ field: string; code: string; message: string }>;
}

/**
 * Error text, by stable `code`.
 *
 * The server sends both a `code` and a `message`; the code is stable and never
 * localised, the message is localised and never parsed. Branching on the code
 * is the contract. Anything unrecognised falls back to the server's message
 * rather than to "something went wrong", which tells nobody anything.
 */
const MESSAGES: Record<string, string> = {
  VALIDATION_FAILED: 'Check the number and try again.',
  INVALID_CODE: 'That code is not right, or it has expired.',
  ACCOUNT_LOCKED: 'Too many attempts. Try again in fifteen minutes.',
  INVALID_CREDENTIALS: 'Those details do not match an account.',
  NO_MEMBERSHIP: 'This account is not attached to a school yet.',
  RATE_LIMITED: 'Too many requests. Wait a minute and try again.',
  NO_ACTIVE_CONTEXT: 'Choose a school to continue.',
};

function messageFor(error: ApiError): string {
  return MESSAGES[error.code] ?? error.message;
}

async function call(
  path: string,
  body: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: ApiError }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    // The session arrives as an HttpOnly cookie; nothing here ever sees it.
    credentials: 'same-origin',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  if (!res.ok) {
    const error = (json['error'] as ApiError | undefined) ?? {
      code: 'UNKNOWN',
      message: 'The server did not respond as expected.',
      requestId: '',
    };
    return { ok: false, error };
  }
  return { ok: true, data: (json['data'] ?? {}) as Record<string, unknown> };
}

export function LoginForm({ locale }: { locale: string }): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('otp');
  const [step, setStep] = useState<Step>('identify');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [contexts, setContexts] = useState<Context[] | null>(null);

  const home = appPath(locale, '/dashboard');

  async function requestCode(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const result = await call('/api/v1/auth/otp/request', { identifier });
    setBusy(false);

    /*
     * The endpoint answers identically for a number nobody has registered, so
     * this always advances. An error here would be a way to discover which
     * numbers are enrolled at a school (§8.2).
     */
    if (!result.ok) return setError(result.error);
    setStep('code');
  }

  async function verifyCode(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const result = await call('/api/v1/auth/otp/verify', { identifier, code });
    setBusy(false);

    if (!result.ok) return setError(result.error);
    landAfterLogin(result.data);
  }

  async function signInWithPassword(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const result = await call('/api/v1/auth/password', { identifier, password });
    setBusy(false);

    if (!result.ok) return setError(result.error);
    landAfterLogin(result.data);
  }

  function landAfterLogin(data: Record<string, unknown>): void {
    const list = (data['contexts'] ?? []) as Context[];
    // One school activates server-side at verification; several need a choice,
    // and the choice is made by membership id because the client is never
    // trusted to name a tenant (§8.4).
    if (list.length > 1) return setContexts(list);
    window.location.assign(home);
  }

  async function activate(membershipId: string): Promise<void> {
    setBusy(true);
    const result = await call(`/api/v1/auth/contexts/${membershipId}/activate`, {});
    setBusy(false);
    if (!result.ok) return setError(result.error);
    window.location.assign(home);
  }

  if (contexts) {
    return (
      <section aria-labelledby="pick-school">
        <h2 id="pick-school" className="text-lg font-semibold">
          Choose a school
        </h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          This login reaches more than one school.
        </p>
        <ul className="mt-4 space-y-2">
          {contexts.map((c) => (
            <li key={c.membershipId}>
              <button
                type="button"
                onClick={() => void activate(c.membershipId)}
                disabled={busy}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-3 text-left disabled:opacity-60"
              >
                {c.tenantId}
              </button>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <div>
      <div role="tablist" aria-label="Sign-in method" className="mb-6 flex gap-2 text-sm">
        {(['otp', 'password'] as const).map((m) => (
          <button
            key={m}
            role="tab"
            type="button"
            aria-selected={mode === m}
            onClick={() => {
              setMode(m);
              setStep('identify');
              setError(null);
            }}
            className={`rounded px-3 py-2 ${
              mode === m
                ? 'bg-[var(--brand-primary)] text-[var(--brand-on-primary)]'
                : 'border border-[var(--color-border)]'
            }`}
          >
            {m === 'otp' ? 'Phone code' : 'Password'}
          </button>
        ))}
      </div>

      {error && (
        <p
          // Announced on change, not on mount, so a screen reader reads the
          // failure when it happens rather than on every render.
          role="alert"
          className="mb-4 rounded border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]"
        >
          {messageFor(error)}
          {error.requestId && (
            <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
              Reference: {error.requestId}
            </span>
          )}
        </p>
      )}

      {mode === 'otp' && step === 'identify' && (
        <form onSubmit={(e) => void requestCode(e)} className="space-y-4">
          <Field
            id="phone"
            label="Mobile number"
            hint="The number the school has for you."
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+8801XXXXXXXXX"
            value={identifier}
            onChange={setIdentifier}
          />
          <Submit busy={busy} label="Send code" />
        </form>
      )}

      {mode === 'otp' && step === 'code' && (
        <form onSubmit={(e) => void verifyCode(e)} className="space-y-4">
          <Field
            id="code"
            label="Six-digit code"
            hint={`Sent to ${identifier}.`}
            type="text"
            /* `one-time-code` is what makes a phone offer the SMS from the
               keyboard, which removes the copy-paste step entirely. */
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={setCode}
          />
          <Submit busy={busy} label="Sign in" />
          <button
            type="button"
            onClick={() => {
              setStep('identify');
              setCode('');
              setError(null);
            }}
            className="text-sm underline"
          >
            Use a different number
          </button>
        </form>
      )}

      {mode === 'password' && (
        <form onSubmit={(e) => void signInWithPassword(e)} className="space-y-4">
          <Field
            id="identifier"
            label="Mobile number or email"
            type="text"
            autoComplete="username"
            value={identifier}
            onChange={setIdentifier}
          />
          <Field
            id="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
          />
          <Submit busy={busy} label="Sign in" />
          <p className="text-sm text-[var(--color-text-muted)]">
            Staff receive a link to set their password. Nobody is ever sent one.
          </p>
        </form>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  ...input
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  // `onChange` and `value` are omitted from the passthrough: the DOM versions
  // take an event and a ReactNode, and letting both signatures through means
  // the caller can silently satisfy the wrong one.
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'>): React.JSX.Element {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-sm text-[var(--color-text-muted)]">
          {hint}
        </p>
      )}
      <input
        id={id}
        {...input}
        {...(hint ? { 'aria-describedby': `${id}-hint` } : {})}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        /* 16px minimum: anything smaller makes iOS Safari zoom on focus, which
           on a form is disorienting rather than helpful. */
        className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
      />
    </div>
  );
}

function Submit({ busy, label }: { busy: boolean; label: string }): React.JSX.Element {
  return (
    <button
      type="submit"
      disabled={busy}
      /* min-h-11 ≈ 44px, the smallest reliable touch target. The people using
         this are standing at a school gate, not sitting at a desk. */
      className="min-h-11 w-full rounded bg-[var(--brand-primary)] px-4 py-2 font-medium text-[var(--brand-on-primary)] disabled:opacity-60"
    >
      {busy ? 'Please wait…' : label}
    </button>
  );
}
