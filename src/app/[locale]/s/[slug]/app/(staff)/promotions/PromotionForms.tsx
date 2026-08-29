'use client';

/**
 * The interactive half of promotion: outcomes, confirmation, and undo.
 *
 * The default outcome applies to everyone; exceptions are named individually.
 * That is the shape of the real task — a head teacher promotes a section of
 * forty and names the three who are repeating — and it is why the roster is
 * listed rather than summarised.
 */

import { useState, type FormEvent } from 'react';

export interface Option {
  id: string;
  label: string;
}

export interface Candidate {
  id: string;
  nameBn: string;
  nameEn: string;
  studentCode: string;
  rollNo: number | null;
}

export interface Batch {
  id: string;
  sectionNameEn: string | null;
  className: string | null;
  fromYearName: string | null;
  toYearName: string | null;
  promoted: number;
  retained: number;
  transferred: number;
  withdrawn: number;
  undoneAt: string | null;
  undoReason: string | null;
  at: string;
}

type Outcome = 'promoted' | 'retained' | 'transferred' | 'withdrawn';

const OUTCOME_LABEL: Record<Outcome, string> = {
  promoted: 'Promoted',
  retained: 'Repeating',
  transferred: 'Transferred out',
  withdrawn: 'Withdrawn',
};

interface ApiError {
  code: string;
  message: string;
  requestId: string;
}

/** Branch on `code`; the message is localised and never parsed. */
const MESSAGES: Record<string, string> = {
  SECTION_EMPTY: 'Nobody in that section and year is waiting for an outcome.',
  UNKNOWN_EXCEPTION:
    'One of the named students is not in this section. That usually means the wrong section was chosen.',
  SAME_YEAR: 'The year being promoted into must be different from the year being promoted from.',
  BATCH_NOT_FOUND: 'That promotion is not on file at this school.',
  BATCH_ALREADY_UNDONE: 'That promotion has already been taken back.',
  VALIDATION_FAILED: 'Check the fields — a reason of at least a few words is required.',
  FORBIDDEN: 'You do not have permission to promote students.',
};

async function send(
  path: string,
  body: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: ApiError }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      error:
        (json['error'] as ApiError | undefined) ?? {
          code: 'UNKNOWN',
          message: 'The server did not respond as expected.',
          requestId: '',
        },
    };
  }
  return { ok: true, data: (json['data'] ?? {}) as Record<string, unknown> };
}

function Problem({ error }: { error: ApiError }): React.JSX.Element {
  return (
    <p
      role="alert"
      className="rounded border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]"
    >
      {MESSAGES[error.code] ?? error.message}
      {error.requestId && (
        <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
          Reference: {error.requestId}
        </span>
      )}
    </p>
  );
}

export function PromotionRun({
  sourceSectionId,
  fromYearId,
  sourceLabel,
  fromYearLabel,
  roster,
  sections,
  years,
}: {
  sourceSectionId: string;
  fromYearId: string;
  sourceLabel: string;
  fromYearLabel: string;
  roster: Candidate[];
  sections: Option[];
  years: Option[];
}): React.JSX.Element {
  const [toYearId, setToYearId] = useState('');
  const [targetSectionId, setTargetSectionId] = useState('');
  const [retainSectionId, setRetainSectionId] = useState(sourceSectionId);
  const [defaultOutcome, setDefaultOutcome] = useState<'promoted' | 'retained'>('promoted');
  const [exceptions, setExceptions] = useState<Record<string, Outcome>>({});
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{ batchId: string; enrolled: number } | null>(null);

  const outcomeFor = (id: string): Outcome => exceptions[id] ?? defaultOutcome;

  const counts = roster.reduce<Record<Outcome, number>>(
    (acc, c) => {
      acc[outcomeFor(c.id)] += 1;
      return acc;
    },
    { promoted: 0, retained: 0, transferred: 0, withdrawn: 0 },
  );

  function setOutcome(studentId: string, outcome: Outcome): void {
    setExceptions((prev) => {
      const next = { ...prev };
      // Matching the default is not an exception — sending it would make the
      // request describe settings rather than departures from them.
      if (outcome === defaultOutcome) delete next[studentId];
      else next[studentId] = outcome;
      return next;
    });
  }

  async function run(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const result = await send(`/api/v1/sections/${sourceSectionId}/promote`, {
      fromYearId,
      toYearId,
      targetSectionId,
      retainSectionId,
      defaultOutcome,
      exceptions,
      reason,
    });
    setBusy(false);

    if (!result.ok) {
      setConfirming(false);
      return setError(result.error);
    }
    setDone({
      batchId: String(result.data['batchId']),
      enrolled: Number(result.data['enrolled'] ?? 0),
    });
  }

  if (done) {
    return (
      <section className="mb-8 rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4">
        <h2 className="font-medium">Promotion done</h2>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          {done.enrolled} {done.enrolled === 1 ? 'student' : 'students'} enrolled in the
          new year.
        </p>
        {/* The id is shown because it is what undo is keyed on, and because a
            person reporting a problem needs something to name. */}
        <p className="mt-2 text-sm">
          Batch <code className="text-xs">{done.batchId}</code>
        </p>
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">
          It is listed under recent promotions below, and can be taken back from
          there — including later, and by somebody else.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-3 min-h-11 rounded border border-[var(--color-border)] px-4"
        >
          Done
        </button>
      </section>
    );
  }

  if (confirming) {
    const targetLabel = sections.find((o) => o.id === targetSectionId)?.label ?? '';
    const toYearLabel = years.find((o) => o.id === toYearId)?.label ?? '';

    return (
      <section className="mb-8 rounded border border-[var(--color-danger)] p-4">
        <h2 className="font-medium">Confirm the promotion</h2>
        <p className="mt-2 text-sm">
          <strong>{sourceLabel}</strong> in <strong>{fromYearLabel}</strong> →{' '}
          <strong>{targetLabel}</strong> in <strong>{toYearLabel}</strong>
        </p>
        <ul className="mt-3 text-sm">
          {(Object.keys(OUTCOME_LABEL) as Outcome[])
            .filter((o) => counts[o] > 0)
            .map((o) => (
              <li key={o}>
                {OUTCOME_LABEL[o]}: <strong>{counts[o]}</strong>
              </li>
            ))}
        </ul>
        <p className="mt-3 text-sm text-[var(--color-text-muted)]">
          Transferred and withdrawn students get no new enrolment and a change of
          status. Dues are not touched.
        </p>

        {error && (
          <div className="mt-3">
            <Problem error={error} />
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={(e) => void run(e)}
            className="min-h-11 rounded bg-[var(--color-danger)] px-4 font-medium text-[var(--brand-on-primary)] disabled:opacity-60"
          >
            {busy ? 'Promoting…' : `Promote ${roster.length}`}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={busy}
            className="min-h-11 rounded border border-[var(--color-border)] px-4"
          >
            Back
          </button>
        </div>
      </section>
    );
  }

  const ready = toYearId !== '' && targetSectionId !== '' && reason.trim().length >= 3;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setConfirming(true);
      }}
      className="mb-8"
    >
      <h2 className="mb-3 font-medium">
        {sourceLabel} · {roster.length} {roster.length === 1 ? 'student' : 'students'}
      </h2>

      {error && (
        <div className="mb-4">
          <Problem error={error} />
        </div>
      )}

      <div className="grid gap-4 rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Into year</span>
          <select
            value={toYearId}
            onChange={(e) => setToYearId(e.target.value)}
            required
            className="mt-2 min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          >
            <option value="">Choose…</option>
            {years
              // Promoting into the year being promoted from is refused by the
              // server; not offering it is better than explaining it.
              .filter((y) => y.id !== fromYearId)
              .map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}
                </option>
              ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium">Into section</span>
          <select
            value={targetSectionId}
            onChange={(e) => setTargetSectionId(e.target.value)}
            required
            className="mt-2 min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          >
            <option value="">Choose…</option>
            {sections.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium">Everyone is</span>
          <select
            value={defaultOutcome}
            onChange={(e) => {
              const next = e.target.value as 'promoted' | 'retained';
              setDefaultOutcome(next);
              // Exceptions are relative to the default, so a changed default
              // makes the old ones mean something different. Clearing is the
              // honest choice; silently keeping them is not.
              setExceptions({});
            }}
            className="mt-2 min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          >
            <option value="promoted">Promoted</option>
            <option value="retained">Repeating</option>
          </select>
        </label>

        <label className="block text-sm">
          <span className="font-medium">Repeaters stay in</span>
          <select
            value={retainSectionId}
            onChange={(e) => setRetainSectionId(e.target.value)}
            className="mt-2 min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3"
          >
            {sections.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-sm sm:col-span-2">
          <span className="font-medium">Reason</span>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={3}
            placeholder="End of academic year 2026"
            className="mt-2 min-h-11 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-base"
          />
          <span className="mt-1 block text-sm text-[var(--color-text-muted)]">
            Recorded against every enrolment this creates.
          </span>
        </label>
      </div>

      <div className="mt-4 overflow-x-auto rounded border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              <th className="p-3 font-medium">Roll</th>
              <th className="p-3 font-medium">Student</th>
              <th className="p-3 font-medium">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((c) => {
              const outcome = outcomeFor(c.id);
              return (
                <tr key={c.id} className="border-b border-[var(--color-border)] last:border-0">
                  <td className="p-3 tabular-nums text-[var(--color-text-muted)]">
                    {c.rollNo ?? '—'}
                  </td>
                  <td className="p-3">
                    {c.nameBn}
                    <span className="block text-xs text-[var(--color-text-muted)]">
                      {c.nameEn} · {c.studentCode}
                    </span>
                  </td>
                  <td className="p-3">
                    <select
                      aria-label={`Outcome for ${c.nameEn}`}
                      value={outcome}
                      onChange={(e) => setOutcome(c.id, e.target.value as Outcome)}
                      className={`min-h-11 w-full rounded border bg-[var(--color-surface)] px-2 ${
                        outcome === defaultOutcome
                          ? 'border-[var(--color-border)]'
                          : 'border-[var(--color-danger)]'
                      }`}
                    >
                      {(Object.keys(OUTCOME_LABEL) as Outcome[]).map((o) => (
                        <option key={o} value={o}>
                          {OUTCOME_LABEL[o]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={!ready}
          className="min-h-11 rounded bg-[var(--brand-primary)] px-4 font-medium text-[var(--brand-on-primary)] disabled:opacity-60"
        >
          Review
        </button>
        <p className="text-sm text-[var(--color-text-muted)]">
          {counts.promoted} promoted · {counts.retained} repeating ·{' '}
          {counts.transferred + counts.withdrawn} leaving
        </p>
      </div>
    </form>
  );
}

export function RecentRuns({ batches }: { batches: Batch[] }): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function undo(batch: Batch): Promise<void> {
    const label = [batch.className, batch.sectionNameEn].filter(Boolean).join(' ') || 'this run';
    const reason = window.prompt(`Why is the promotion of ${label} being taken back?`);
    // Cancel means cancel. An empty reason would be refused by the server
    // anyway, and asking twice is worse than doing nothing.
    if (reason === null || reason.trim().length < 3) return;

    setBusy(batch.id);
    setError(null);
    const result = await send(`/api/v1/promotions/${batch.id}/undo`, { reason });
    setBusy(null);

    if (!result.ok) return setError(result.error);
    window.location.reload();
  }

  return (
    <section>
      <h2 className="mb-3 font-medium">Recent promotions</h2>

      {error && (
        <div className="mb-4">
          <Problem error={error} />
        </div>
      )}

      {batches.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No promotions have been run at this school yet.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)]">
          {batches.map((b) => (
            <li key={b.id} className="flex flex-wrap items-baseline justify-between gap-3 p-4">
              <div>
                <p className="font-medium">
                  {[b.className, b.sectionNameEn].filter(Boolean).join(' ') || 'Removed section'}
                  <span className="font-normal text-[var(--color-text-muted)]">
                    {' '}
                    · {b.fromYearName ?? '—'} → {b.toYearName ?? '—'}
                  </span>
                </p>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {b.promoted} promoted · {b.retained} repeating · {b.transferred} transferred ·{' '}
                  {b.withdrawn} withdrawn · {new Date(b.at).toLocaleString()}
                </p>
                {b.undoneAt !== null && (
                  <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                    Taken back {new Date(b.undoneAt).toLocaleString()}
                    {b.undoReason ? ` — ${b.undoReason}` : ''}
                  </p>
                )}
              </div>

              {b.undoneAt === null ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void undo(b)}
                  className="min-h-11 rounded border border-[var(--color-danger)] px-4 text-[var(--color-danger)] disabled:opacity-60"
                >
                  {busy === b.id ? 'Undoing…' : 'Undo'}
                </button>
              ) : (
                <span className="text-sm text-[var(--color-text-muted)]">Undone</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-sm text-[var(--color-text-muted)]">
        Undo removes exactly the enrolments a run created — never rows added by
        hand afterwards. A leaver’s status is not restored: reversing that is a
        separate decision with its own reason.
      </p>
    </section>
  );
}
