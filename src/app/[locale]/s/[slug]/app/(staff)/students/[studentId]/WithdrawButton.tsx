'use client';

/**
 * Withdrawing a student.
 *
 * The one interactive island on this page, because withdrawal is the action
 * offices perform most and get asked about most — and because it needs a
 * REASON. "Why did you mark my child withdrawn?" has to have an answer that is
 * not "the system did it", and the server refuses the call without one.
 *
 * A two-step confirm rather than a single button. This is not undoable from the
 * UI, and a mis-click on a student list is easy.
 */

import { useState, type FormEvent } from 'react';

export function WithdrawButton({
  studentId,
  redirectTo,
}: {
  studentId: string;
  redirectTo: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/v1/students/${studentId}/withdraw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
      credentials: 'same-origin',
    });

    if (res.ok) {
      window.location.assign(redirectTo);
      return;
    }

    const body = (await res.json().catch(() => ({}))) as {
      error?: { code: string; message: string };
    };
    setBusy(false);

    // Branch on `code`, never on `message`: the code is stable and never
    // localised, the message is localised and never parsed (§10.2).
    setError(
      body.error?.code === 'VALIDATION_FAILED'
        ? 'A reason of at least three characters is required.'
        : body.error?.code === 'ILLEGAL_TRANSITION'
          ? 'This student cannot be withdrawn from their current state.'
          : (body.error?.message ?? 'The withdrawal did not go through.'),
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-11 rounded border border-[var(--color-danger)] px-4 text-[var(--color-danger)]"
      >
        Withdraw student
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="rounded border border-[var(--color-danger)] p-4"
    >
      <p className="mb-3 font-medium">Withdraw this student?</p>
      <p className="mb-3 text-sm text-[var(--color-text-muted)]">
        Their record is kept — nothing is deleted — but they leave the class list.
        Outstanding fees are unaffected and are settled separately.
      </p>

      <label htmlFor="reason" className="block text-sm font-medium">
        Reason
      </label>
      <input
        id="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        minLength={3}
        placeholder="Moved to another district"
        className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
      />

      {error && (
        <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded bg-[var(--color-danger)] px-4 text-white disabled:opacity-60"
        >
          {busy ? 'Withdrawing…' : 'Confirm withdrawal'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className="min-h-11 rounded border border-[var(--color-border)] px-4"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
