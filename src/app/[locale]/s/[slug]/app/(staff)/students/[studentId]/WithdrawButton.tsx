'use client';

/**
 * Withdrawing a student.
 *
 * The one interactive island on this page, because withdrawal is the action
 * offices perform most and get asked about most — and because it needs a
 * REASON. "Why did you mark my child withdrawn?" has to have an answer that is
 * not "the system did it", and the server refuses the call without one.
 *
 * `ConfirmDialog` supplies the two-step shape and the reason field; this
 * component keeps the one thing that cannot be generalised — the fetch call
 * and what each error code means here specifically.
 */

import { useState } from 'react';
import { Button } from '../../../../../../../../components/ui';
import { ConfirmDialog } from '../../../../../../../../components/patterns';

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

  async function submit(): Promise<void> {
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

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
      trigger={
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Withdraw student
        </Button>
      }
      title="Withdraw this student?"
      description="Their record is kept — nothing is deleted — but they leave the class list. Outstanding fees are unaffected and are settled separately."
      reason={{
        value: reason,
        onChange: setReason,
        label: 'Reason',
        placeholder: 'Moved to another district',
        minLength: 3,
      }}
      confirmLabel={busy ? 'Withdrawing…' : 'Confirm withdrawal'}
      destructive
      busy={busy}
      error={error}
      onConfirm={() => void submit()}
    />
  );
}
