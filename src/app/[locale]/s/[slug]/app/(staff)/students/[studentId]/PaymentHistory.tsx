'use client';

/**
 * A student's receipts, and the one action left for them: reverse. §13.3.
 *
 * Newest first, matching the repository's own order. A row's own state tells
 * the whole story — `reversesPaymentId` names the receipt it undid,
 * `reversedByPaymentId` names the receipt that undid IT — so both a plain
 * payment and a reversal-of-a-reversal render from the same list with no
 * separate "history" concept. Reversing is allowed on anything not yet
 * reversed, reversal payments included: the backend's own comment for why
 * (`reversePayment.ts`) is that undoing a reversal is a NEW payment, not a
 * different operation.
 */

import { useState, type FormEvent } from 'react';
import { Button, Badge, Textarea } from '../../../../../../../../components/ui';
import { MoneyText, DateInput } from '../../../../../../../../components/patterns';

export interface PaymentRow {
  id: string;
  receiptNo: number;
  amountMinor: string;
  channel: 'cash' | 'bank' | 'cheque' | 'mfs' | 'online';
  channelRef: string | null;
  collectedAt: string;
  reversesPaymentId: string | null;
  reversedByPaymentId: string | null;
}

const CHANNEL_LABEL: Record<PaymentRow['channel'], string> = {
  cash: 'Cash',
  bank: 'Bank transfer',
  cheque: 'Cheque',
  mfs: 'Mobile financial service',
  online: 'Online',
};

/** Branch on `code`, never on `message` (§10.2). */
const ERROR_MESSAGE: Record<string, string> = {
  VALIDATION_FAILED: 'A reason of at least a few words is required.',
  PAYMENT_NOT_FOUND: 'This receipt could not be found.',
  ALREADY_REVERSED: 'Somebody already reversed this receipt.',
  INVALID_COLLECTED_AT: 'Enter a real calendar date.',
  BACKDATE_NOT_PERMITTED: 'Only an accountant or head can reverse an earlier day.',
  TENANT_SUSPENDED: 'This school is read-only right now.',
};

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function PaymentHistory({
  payments,
  canReverse,
  canBackdate,
}: {
  payments: PaymentRow[];
  canReverse: boolean;
  canBackdate: boolean;
}): React.JSX.Element {
  const receiptNoById = new Map(payments.map((p) => [p.id, p.receiptNo]));
  const [reversingId, setReversingId] = useState<string | null>(null);

  if (payments.length === 0) {
    return <p className="py-6 text-sm text-[var(--color-text-muted)]">No payments recorded yet.</p>;
  }

  return (
    <ul className="divide-y divide-[var(--color-border)]">
      {payments.map((p) => (
        <li key={p.id} className="py-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              Receipt #{p.receiptNo}{' '}
              <span className="text-[var(--color-text-muted)]">
                {CHANNEL_LABEL[p.channel]} · {p.collectedAt}
              </span>
              {p.reversesPaymentId !== null && (
                <Badge tone="warning" className="ml-2">
                  Reversal of #{receiptNoById.get(p.reversesPaymentId) ?? '—'}
                </Badge>
              )}
              {p.reversedByPaymentId !== null && (
                <Badge tone="neutral" className="ml-2">
                  Reversed by #{receiptNoById.get(p.reversedByPaymentId) ?? '—'}
                </Badge>
              )}
            </span>
            <span className="flex items-center gap-3">
              <MoneyText minorUnits={p.amountMinor} className="font-medium" />
              {canReverse && p.reversedByPaymentId === null && reversingId !== p.id && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setReversingId(p.id)}
                >
                  Reverse
                </Button>
              )}
            </span>
          </div>

          {reversingId === p.id && (
            <ReverseForm
              paymentId={p.id}
              canBackdate={canBackdate}
              onCancel={() => setReversingId(null)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function ReverseForm({
  paymentId,
  canBackdate,
  onCancel,
}: {
  paymentId: string;
  canBackdate: boolean;
  onCancel: () => void;
}): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [collectedAt, setCollectedAt] = useState(todayIso);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/v1/payments/${paymentId}/reverse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ reason, collectedAt }),
    });

    if (res.ok) {
      // Outstanding and payment history both change together — a reload
      // keeps them honest rather than patching two components' state by hand.
      window.location.reload();
      return;
    }

    const body = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    setBusy(false);
    setError(ERROR_MESSAGE[body.error?.code ?? ''] ?? body.error?.message ?? 'That did not go through.');
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-3 space-y-3 rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3">
      <div>
        <label htmlFor={`reason-${paymentId}`} className="block text-sm font-medium">
          Reason
        </label>
        <div className="mt-1">
          <Textarea
            id={`reason-${paymentId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={10}
            maxLength={280}
            placeholder="Why this receipt is being reversed"
          />
        </div>
      </div>

      <div className="max-w-48">
        <label htmlFor={`collectedAt-${paymentId}`} className="block text-sm font-medium">
          Reversed on
        </label>
        <div className="mt-1">
          <DateInput
            id={`collectedAt-${paymentId}`}
            value={collectedAt}
            onChange={setCollectedAt}
            {...(canBackdate ? {} : { max: todayIso() })}
            required
            disabled={!canBackdate}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <div className="flex gap-3">
        <Button type="submit" disabled={busy || reason.trim().length < 10}>
          {busy ? 'Reversing…' : 'Confirm reversal'}
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
