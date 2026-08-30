'use client';

/**
 * Choosing which record survives, and putting a merge back.
 *
 * The one decision this screen must not make for anybody is WHICH SIDE WINS.
 * The queue suggests, because a suggestion saves a reviewer from reading two
 * identical names forty times; but the suggestion is never pre-selected, and
 * the merge button stays disabled until somebody has actually chosen. A
 * pre-ticked default on an operation that fuses two children's records is a
 * mistake waiting for a distracted afternoon.
 */

import { useState, type FormEvent } from 'react';
import { Badge, Button, Card, CardContent, Input } from '../../../../../../../components/ui';
import { ApiErrorAlert, EmptyState, type ApiError } from '../../../../../../../components/patterns';

export type Evidence = 'birth_reg_no' | 'name_and_dob' | 'name_and_phone';

export interface Side {
  personId: string;
  nameBn: string;
  nameEn: string;
  phone: string | null;
  students: number;
  guardianLinks: number;
  staff: number;
  memberships: number;
  attachedTo: string[];
  at: string;
}

export interface Pair {
  evidence: Evidence;
  left: Side;
  right: Side;
  suggestedWinner: 'left' | 'right';
}

export interface Merge {
  id: string;
  winnerPersonId: string;
  loserPersonId: string;
  winnerNameBn: string | null;
  winnerNameEn: string | null;
  loserNameBn: string | null;
  loserNameEn: string | null;
  moved: Record<string, string[]>;
  reason: string;
  reversedAt: string | null;
  reverseReason: string | null;
  at: string;
}

/** Said in full, because the reviewer has to be able to disagree with it. */
const EVIDENCE: Record<Evidence, string> = {
  birth_reg_no: 'Same birth registration number',
  name_and_dob: 'Same name and date of birth',
  name_and_phone: 'Same name and phone number',
};

/** Branch on `code`; the message is localised and never parsed. */
const MESSAGES: Record<string, string> = {
  SAME_PERSON: 'Those are the same record.',
  ALREADY_MERGED: 'One of these has already been merged. Reload the page.',
  CANNOT_MERGE_SELF: 'You cannot merge your own record.',
  PERSON_NOT_FOUND: 'One of these records no longer exists. Reload the page.',
  MERGE_NOT_FOUND: 'That merge is not on file at this school.',
  MERGE_ALREADY_REVERSED: 'That merge has already been put back.',
  VALIDATION_FAILED: 'A reason of at least a few words is required.',
  FORBIDDEN: 'You do not have permission to merge records.',
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
      error: (json['error'] as ApiError | undefined) ?? {
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
    <ApiErrorAlert
      text={MESSAGES[error.code] ?? error.message}
      requestId={error.requestId}
      className="mt-3"
    />
  );
}

function attachments(s: Side): string {
  const parts = [
    s.students === 1 ? '1 student record' : s.students > 1 ? `${s.students} student records` : null,
    s.guardianLinks === 1
      ? '1 child'
      : s.guardianLinks > 1
        ? `${s.guardianLinks} children`
        : null,
    s.staff > 0 ? 'a staff record' : null,
    s.memberships > 0 ? (s.memberships === 1 ? '1 login' : `${s.memberships} logins`) : null,
  ].filter(Boolean);
  // "Nothing attached" is worth saying plainly: it is the side that is usually
  // safe to merge away, and silence would read as missing information.
  return parts.length === 0 ? 'nothing attached' : parts.join(' · ');
}

/**
 * A side, said in a way that tells it apart from the other one.
 *
 * The names match — that is why the pair was proposed — so the children are the
 * only distinguishing detail, and the date is the fallback when even those are
 * the same.
 */
function describe(s: Side): string {
  if (s.attachedTo.length > 0) return `${s.nameBn} — ${s.attachedTo.join(', ')}`;
  return `${s.nameBn} — nothing attached, added ${new Date(s.at).toLocaleDateString()}`;
}

export function DuplicateQueue({ pairs }: { pairs: Pair[] }): React.JSX.Element {
  if (pairs.length === 0) {
    return (
      <section className="mb-10">
        <EmptyState title="No possible duplicates found." description="Records are compared on birth registration number, and on name together with date of birth or phone number." />
      </section>
    );
  }

  return (
    <section className="mb-10 space-y-4">
      {pairs.map((p) => (
        <PairCard key={`${p.left.personId}:${p.right.personId}`} pair={p} />
      ))}
    </section>
  );
}

function PairCard({ pair }: { pair: Pair }): React.JSX.Element {
  const [keep, setKeep] = useState<'left' | 'right' | null>(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);

  const winner = keep === 'left' ? pair.left : keep === 'right' ? pair.right : null;
  const loser = keep === 'left' ? pair.right : keep === 'right' ? pair.left : null;

  async function merge(): Promise<void> {
    if (!winner || !loser) return;
    setBusy(true);
    setError(null);

    const result = await send(`/api/v1/persons/${winner.personId}/merge`, {
      loserPersonId: loser.personId,
      reason,
    });
    setBusy(false);

    if (!result.ok) {
      setConfirming(false);
      return setError(result.error);
    }
    setDone(true);
  }

  if (done) {
    return (
      <Card>
        <CardContent className="pt-5">
          <p className="font-medium text-[var(--color-text)]">Merged</p>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {loser && describe(loser)} was merged into {winner && describe(winner)}.
            It is listed below and can be put back.
          </p>
          <Button variant="secondary" onClick={() => window.location.reload()} className="mt-3">
            Done
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-sm text-[var(--color-text-muted)]">{EVIDENCE[pair.evidence]}</p>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(['left', 'right'] as const).map((which) => {
            const s = pair[which];
            const chosen = keep === which;
            return (
              <label
                key={which}
                className={`block cursor-pointer rounded-[var(--radius-md)] border p-3 ${
                  chosen ? 'border-[var(--brand-primary)]' : 'border-[var(--color-border)]'
                }`}
              >
                <span className="flex items-baseline gap-2">
                  <input
                    type="radio"
                    name={`keep-${pair.left.personId}`}
                    checked={chosen}
                    onChange={() => setKeep(which)}
                    className="mt-1 accent-[var(--brand-primary)]"
                  />
                  <span className="font-medium text-[var(--color-text)]">{s.nameBn}</span>
                  {pair.suggestedWinner === which && <Badge tone="neutral">suggested</Badge>}
                </span>
                <span className="mt-1 block text-sm text-[var(--color-text-muted)]">{s.nameEn}</span>
                {s.phone && (
                  <span className="block text-sm text-[var(--color-text-muted)]">{s.phone}</span>
                )}
                {/* What this record carries, so the cost of choosing wrongly is
                    visible before the choice rather than after it. */}
                <span className="mt-2 block text-sm text-[var(--color-text)]">{attachments(s)}</span>
                {/* And WHO, because both names are identical by construction —
                    the children are the only thing that distinguishes the two. */}
                {s.attachedTo.length > 0 && (
                  <span className="mt-1 block text-sm text-[var(--color-text-muted)]">
                    {s.attachedTo.join(', ')}
                  </span>
                )}
                <span className="mt-1 block text-xs text-[var(--color-text-muted)]">
                  added {new Date(s.at).toLocaleDateString()}
                </span>
              </label>
            );
          })}
        </div>

        {confirming && winner && loser ? (
          <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--color-danger)] p-3">
            {/*
              * Named by what is ATTACHED, not by the person's name. A proposed
              * pair has identical names by construction, so "X moves to X" is the
              * one sentence a confirmation step must never be — it asks the
              * reviewer to check a direction it has not shown them.
              */}
            <p className="text-sm text-[var(--color-text)]">
              Everything attached to the record for{' '}
              <strong>{describe(loser)}</strong> moves to the record for{' '}
              <strong>{describe(winner)}</strong>. The losing record is kept and
              marked as merged — nothing is deleted, and this can be put back.
            </p>
            {error && <Problem error={error} />}
            <div className="mt-3 flex flex-wrap gap-3">
              <Button variant="destructive" disabled={busy} onClick={() => void merge()}>
                {busy ? 'Merging…' : `Merge into ${winner.nameEn}`}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                Back
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setConfirming(true);
            }}
            className="mt-4 flex flex-wrap items-center gap-3"
          >
            <label htmlFor={`reason-${pair.left.personId}`} className="sr-only">
              Why these are the same person
            </label>
            <Input
              id={`reason-${pair.left.personId}`}
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={3}
              placeholder="Why these are the same person"
              className="flex-1"
            />
            <Button
              type="submit"
              // Disabled until somebody has actually chosen a side. There is no
              // pre-selected winner, however confident the suggestion is.
              disabled={keep === null || reason.trim().length < 3}
            >
              Review merge
            </Button>
            {keep === null && (
              <p className="w-full text-sm text-[var(--color-text-muted)]">
                Choose which record to keep.
              </p>
            )}
          </form>
        )}

        {error && !confirming && <Problem error={error} />}
      </CardContent>
    </Card>
  );
}

export function RecentMerges({ merges }: { merges: Merge[] }): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function reverse(m: Merge): Promise<void> {
    const reason = window.prompt(
      `Why is the merge of ${m.loserNameEn ?? 'that record'} being put back?`,
    );
    // Cancel means cancel. An empty reason would be refused by the server
    // anyway, and asking twice is worse than doing nothing.
    if (reason === null || reason.trim().length < 3) return;

    setBusy(m.id);
    setError(null);
    const result = await send(`/api/v1/merges/${m.id}/reverse`, { reason });
    setBusy(null);

    if (!result.ok) return setError(result.error);
    window.location.reload();
  }

  /** Column names are not words. `1 guardianLinks` is not a sentence. */
  const MOVED_LABEL: Record<string, [string, string]> = {
    students: ['student record', 'student records'],
    guardianLinks: ['child', 'children'],
    staff: ['staff record', 'staff records'],
    memberships: ['login', 'logins'],
  };

  const moved = (m: Merge): string => {
    const parts = Object.entries(m.moved)
      .filter(([, ids]) => ids.length > 0)
      .map(([k, ids]) => {
        const label = MOVED_LABEL[k] ?? [k, k];
        return `${ids.length} ${ids.length === 1 ? label[0] : label[1]}`;
      });
    return parts.length === 0 ? 'nothing moved' : `moved ${parts.join(' · ')}`;
  };

  return (
    <section>
      <h2 className="mb-3 font-medium text-[var(--color-text)]">Merges already made</h2>

      {error && <Problem error={error} />}

      {merges.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No records have been merged at this school yet.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-[var(--shadow-sm)]">
          {merges.map((m) => (
            <li key={m.id} className="flex flex-wrap items-baseline justify-between gap-3 p-4">
              <div>
                <p className="font-medium text-[var(--color-text)]">
                  {m.loserNameBn ?? 'a removed record'}
                  <span className="font-normal text-[var(--color-text-muted)]"> → </span>
                  {m.winnerNameBn ?? 'a removed record'}
                </p>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {moved(m)} · {new Date(m.at).toLocaleString()}
                </p>
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">{m.reason}</p>
                {m.reversedAt !== null && (
                  <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                    Put back {new Date(m.reversedAt).toLocaleString()}
                    {m.reverseReason ? ` — ${m.reverseReason}` : ''}
                  </p>
                )}
              </div>

              {m.reversedAt === null ? (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void reverse(m)}
                >
                  {busy === m.id ? 'Putting back…' : 'Put back'}
                </Button>
              ) : (
                <Badge tone="neutral">Reversed</Badge>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-sm text-[var(--color-text-muted)]">
        Putting a merge back restores exactly the rows that merge moved, by id —
        never everything currently pointing at the surviving record.
      </p>
    </section>
  );
}
