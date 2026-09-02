'use client';

/**
 * §12.4 — fee collection, the screen a school's trust is won or lost at.
 *
 * The full interaction contract (search → outstanding → amount → live
 * preview → confirm → receipt → print) minus the search step: this panel is
 * reached from a student's own record, which the office already navigated
 * to through the existing student list. A dedicated fast-entry search
 * (`PersonSearch`, §12.1) is a natural fast-follow, not a blocker to
 * shipping real collection today.
 *
 * ON THE PREVIEW IMPLEMENTATION. The obvious choice was importing
 * `allocatePayment` from `modules/finance/index` — it is genuinely
 * framework-free domain code (ADR-0001) and would make the preview and the
 * server's real allocation identical by construction. It does not work in
 * practice: `modules/finance/index.ts` is ONE barrel that also re-exports
 * `recordPayment` and friends, which import `db/rls` → `pg` →
 * Node's `net`/`tls`/`util` — and Next's client bundler cannot tree-shake
 * past that even though this file only ever touches `allocatePayment`. The
 * build fails outright rather than silently shipping a Postgres driver to
 * the browser, which is the correct failure mode; the fix has to be here,
 * not by fighting the bundler.
 *
 * `previewOldestFirst` below is therefore a DELIBERATE, MINIMAL duplicate of
 * `greedyFill` in `modules/finance/domain/rules/allocate.ts` — not a
 * reimplementation of the whole allocation domain, just the one loop
 * `oldest_first` reduces to (this screen never offers `manual` or
 * `proportional`, so nothing else needs porting). It runs against the SAME
 * `outstanding` data the server already returns pre-sorted `oldest_first`,
 * so the preview and the real allocation still agree in practice — this
 * function must be kept behaviourally identical to `greedyFill` if that one
 * ever changes.
 */

import { useMemo, useState } from 'react';
import { Money } from '../../../../../../../../shared/money';
import { Button, Select, Badge } from '../../../../../../../../components/ui';
import { MoneyInput, MoneyText, DateInput, EmptyState } from '../../../../../../../../components/patterns';

export interface OutstandingRow {
  invoiceLineId: string;
  feeHeadName: string;
  outstandingMinor: string;
  dueDate: string;
}

interface PreviewAllocation {
  invoiceLineId: string;
  amountMinor: Money;
}

/** Port of `greedyFill` (`modules/finance/domain/rules/allocate.ts`) — see
 *  the file header for why this exists as a duplicate rather than an import. */
function previewOldestFirst(
  amount: Money,
  outstanding: readonly { invoiceLineId: string; outstandingMinor: Money }[],
): PreviewAllocation[] {
  const allocations: PreviewAllocation[] = [];
  let remaining = amount;

  for (const line of outstanding) {
    if (Money.isZero(remaining)) break;
    if (Money.isZero(line.outstandingMinor) || Money.isNegative(line.outstandingMinor)) continue;

    const take = Money.min(remaining, line.outstandingMinor);
    allocations.push({ invoiceLineId: line.invoiceLineId, amountMinor: take });
    remaining = Money.sub(remaining, take);
  }

  return allocations;
}

const CHANNELS = [
  { value: 'cash', label: 'Cash' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'mfs', label: 'Mobile financial service' },
  { value: 'online', label: 'Online' },
] as const;
type Channel = (typeof CHANNELS)[number]['value'];

/** Branch on `code`, never on `message` (§10.2) — the code is stable and
 *  never localised, the message is localised and never parsed. */
const ERROR_MESSAGE: Record<string, string> = {
  VALIDATION_FAILED: 'Check the values and try again.',
  STUDENT_NOT_FOUND: 'This student could not be found.',
  INVALID_COLLECTED_AT: 'Enter a real calendar date.',
  ALLOCATION_EXCEEDS_OUTSTANDING: 'That is more than this student currently owes.',
  UNKNOWN_INVOICE_LINE: 'One of the outstanding lines changed — reload the page and try again.',
  MANUAL_ALLOCATION_INCOMPLETE: 'The amounts entered do not add up to the total.',
  BACKDATE_NOT_PERMITTED: 'Only an accountant or head can enter a payment for an earlier day.',
  CHANNEL_REFERENCE_REQUIRED: 'A reference is required for every channel except cash.',
  SESSION_CLOSED: "Today's cash session is closed — open a new one to keep collecting cash.",
  IDEMPOTENCY_KEY_REUSED: 'This submission conflicted with an earlier one. Reload and try again.',
  TENANT_SUSPENDED: 'This school is read-only right now.',
};

interface ReceiptView {
  id: string;
  receiptNo: number;
  amountMinor: string;
  collectedAt: string;
  recordedAt: string;
  allocations: Array<{ invoiceLineId: string; feeHeadName: string; amountMinor: string }>;
  remainingDueMinor: string;
}

function todayIso(): string {
  // Only ever the DEFAULT the collector sees on load — the server enforces
  // "before today" against its own Asia/Dhaka clock (BACKDATE_NOT_PERMITTED),
  // so a wrong device clock here cannot let a backdated entry through unnoticed.
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function CollectPayment({
  studentId,
  outstanding,
  canBackdate,
}: {
  studentId: string;
  outstanding: OutstandingRow[];
  canBackdate: boolean;
}): React.JSX.Element {
  const [amountMinor, setAmountMinor] = useState('0');
  const [channel, setChannel] = useState<Channel>('cash');
  const [channelRef, setChannelRef] = useState('');
  const [collectedAt, setCollectedAt] = useState(todayIso);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ReceiptView | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const amount = Money.fromJSON(amountMinor);

  const outstandingLines = useMemo(
    () =>
      outstanding.map((o) => ({
        invoiceLineId: o.invoiceLineId,
        outstandingMinor: Money.fromJSON(o.outstandingMinor),
      })),
    [outstanding],
  );

  const totalOutstanding = useMemo(
    () => outstandingLines.reduce((sum, l) => Money.add(sum, l.outstandingMinor), Money.zero()),
    [outstandingLines],
  );

  const exceedsOutstanding = !Money.isZero(amount) && Money.compare(amount, totalOutstanding) > 0;
  const preview =
    Money.isZero(amount) || exceedsOutstanding ? [] : previewOldestFirst(amount, outstandingLines);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);

    const res = await fetch('/api/v1/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': idempotencyKey },
      credentials: 'same-origin',
      body: JSON.stringify({
        studentId,
        amountMinor,
        channel,
        ...(channel !== 'cash' ? { channelRef } : {}),
        collectedAt,
        allocation: { mode: 'auto' },
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: ReceiptView;
      error?: { code: string; message: string };
    };

    setBusy(false);

    if (res.ok && body.data) {
      setReceipt(body.data);
      return;
    }

    setError(ERROR_MESSAGE[body.error?.code ?? ''] ?? body.error?.message ?? 'That did not go through.');
  }

  if (receipt) return <Receipt receipt={receipt} />;

  if (outstanding.length === 0) {
    return (
      <EmptyState
        title="Nothing outstanding"
        description="This student has no unpaid fees right now."
      />
    );
  }

  return (
    <div className="space-y-4 py-4">
      <ul className="divide-y divide-[var(--color-border)]">
        {outstanding.map((o) => {
          const applied = preview.find((a) => a.invoiceLineId === o.invoiceLineId);
          return (
            <li
              key={o.invoiceLineId}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <span>
                {o.feeHeadName}{' '}
                <span className="text-[var(--color-text-muted)]">due {o.dueDate}</span>
              </span>
              <span className="flex items-center gap-2">
                {applied && (
                  <Badge tone="success">
                    clears <MoneyText minorUnits={applied.amountMinor.minor.toString()} />
                  </Badge>
                )}
                <MoneyText minorUnits={o.outstandingMinor} />
              </span>
            </li>
          );
        })}
      </ul>

      {exceedsOutstanding && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          That is{' '}
          <MoneyText minorUnits={Money.sub(amount, totalOutstanding).minor.toString()} /> more
          than this student owes in total.
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="amountMinor" className="block text-sm font-medium">
              Amount
            </label>
            <div className="mt-1">
              <MoneyInput
                id="amountMinor"
                value={amountMinor}
                onChange={setAmountMinor}
                required
                autoFocus
              />
            </div>
          </div>
          <div>
            <label htmlFor="channel" className="block text-sm font-medium">
              Channel
            </label>
            <div className="mt-1">
              <Select
                id="channel"
                value={channel}
                onChange={(e) => setChannel(e.target.value as Channel)}
              >
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>

        {channel !== 'cash' && (
          <div>
            <label htmlFor="channelRef" className="block text-sm font-medium">
              Reference
            </label>
            <input
              id="channelRef"
              value={channelRef}
              onChange={(e) => setChannelRef(e.target.value)}
              required
              placeholder="Deposit slip, cheque no., transaction id"
              className="mt-1 w-full min-h-11 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base"
            />
          </div>
        )}

        <div>
          <label htmlFor="collectedAt" className="block text-sm font-medium">
            Collected on
          </label>
          <div className="mt-1 max-w-48">
            <DateInput
              id="collectedAt"
              value={collectedAt}
              onChange={setCollectedAt}
              {...(canBackdate ? {} : { max: todayIso() })}
              required
              disabled={!canBackdate}
            />
          </div>
          {!canBackdate && (
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
              Only today — an accountant or head can backdate an entry.
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy || Money.isZero(amount) || exceedsOutstanding}>
          {busy ? 'Recording…' : 'Record payment'}
        </Button>
      </form>
    </div>
  );
}

function Receipt({ receipt }: { receipt: ReceiptView }): React.JSX.Element {
  return (
    <div className="space-y-4 py-4">
      <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4">
        <div className="flex items-baseline justify-between">
          <p className="font-medium">Receipt #{receipt.receiptNo}</p>
          <MoneyText minorUnits={receipt.amountMinor} className="text-lg font-semibold" />
        </div>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Collected {receipt.collectedAt}
        </p>

        <ul className="mt-3 divide-y divide-[var(--color-border)] text-sm">
          {receipt.allocations.map((a) => (
            <li key={a.invoiceLineId} className="flex justify-between py-1.5">
              <span>{a.feeHeadName}</span>
              <MoneyText minorUnits={a.amountMinor} />
            </li>
          ))}
        </ul>

        <p className="mt-3 border-t border-[var(--color-border)] pt-3 text-sm">
          Still owed: <MoneyText minorUnits={receipt.remainingDueMinor} />
        </p>
      </div>

      <div className="flex gap-3">
        <Button onClick={() => window.print()}>Print receipt</Button>
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Collect another payment
        </Button>
      </div>
    </div>
  );
}
