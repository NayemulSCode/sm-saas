'use client';

/**
 * Guardians on the student screen.
 *
 * `bills` and `contacted` are SEPARATE toggles, shown separately, because
 * separated parents are common enough to design for: one may pay while the
 * other is contacted. A single "primary guardian" control would force a wrong
 * answer for a real family.
 *
 * Claiming either flag silently demotes whoever held it — the server does that
 * in one transaction, so the student is never briefly unbilled — and the
 * response says who was demoted, which is worth showing rather than swallowing.
 */

import { useState, type FormEvent } from 'react';

export interface GuardianRow {
  id: string;
  guardianPersonId: string;
  relationship: string;
  isBillingGuardian: boolean;
  isPrimaryContact: boolean;
  canReceiveResults: boolean;
  canCollectStudent: boolean;
  nameBn: string;
  nameEn: string;
  phone: string | null;
}

const MESSAGES: Record<string, string> = {
  EMERGENCY_CANNOT_BILL:
    'An emergency contact cannot be the billing guardian — an invoice would be addressed to them.',
  ALREADY_LINKED: 'That person is already a guardian for this student.',
  LAST_CONTACT:
    'This is the only guardian. Removing them would leave nobody to contact about absence or results.',
  WOULD_LEAVE_NO_BILLER: 'Nominate another billing guardian first.',
  VALIDATION_FAILED: 'Check the details and try again.',
};

export function Guardians({
  studentId,
  guardians,
  canWrite,
}: {
  studentId: string;
  guardians: GuardianRow[];
  canWrite: boolean;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(path: string, body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (res.ok) {
      // A full reload rather than local state: the server just demoted somebody
      // else's flags, and re-deriving that here would be a second copy of a
      // rule that already exists in one place.
      window.location.reload();
      return true;
    }
    const json = (await res.json().catch(() => ({}))) as {
      error?: { code: string; message: string };
    };
    setBusy(false);
    setError(MESSAGES[json.error?.code ?? ''] ?? json.error?.message ?? 'That did not work.');
    return false;
  }

  async function add(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const get = (k: string): string | undefined => {
      const v = form.get(k);
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    };

    await send(`/api/v1/students/${studentId}/guardians`, {
      person: {
        nameBn: get('nameBn'),
        nameEn: get('nameEn'),
        ...(get('phone') ? { phone: get('phone') } : {}),
      },
      relationship: get('relationship'),
      isBillingGuardian: form.get('isBillingGuardian') === 'on',
      isPrimaryContact: form.get('isPrimaryContact') === 'on',
    });
  }

  async function remove(guardianPersonId: string, name: string): Promise<void> {
    const reason = window.prompt(`Why is ${name} being removed?`);
    // Cancelled, or nothing typed. The server requires a reason and would
    // refuse anyway; asking again here saves the round trip.
    if (!reason || reason.trim().length < 3) return;
    await send(`/api/v1/students/${studentId}/guardians/unlink`, {
      guardianPersonId,
      reason: reason.trim(),
    });
  }

  return (
    <div>
      {error && (
        <p role="alert" className="mb-3 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      {guardians.length === 0 ? (
        <p className="py-6 text-sm text-[var(--color-text-muted)]">
          No guardian is linked. This student cannot be contacted about absence
          or results.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)]">
          {guardians.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
              <div className="min-w-0">
                <p className="font-medium">{g.nameBn}</p>
                <p className="text-sm text-[var(--color-text-muted)]">
                  {g.nameEn} · <span className="capitalize">{g.relationship}</span>
                  {g.phone && ` · ${g.phone}`}
                </p>
              </div>
              <span className="ml-auto flex flex-wrap gap-1">
                {g.isBillingGuardian && <Tag>bills</Tag>}
                {g.isPrimaryContact && <Tag>contacted</Tag>}
                {!g.canReceiveResults && <Tag muted>no results</Tag>}
                {!g.canCollectStudent && <Tag muted>cannot collect</Tag>}
              </span>
              {canWrite && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void remove(g.guardianPersonId, g.nameEn)}
                  className="text-sm text-[var(--color-danger)] underline disabled:opacity-60"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && !adding && (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="my-4 min-h-11 rounded border border-[var(--color-border)] px-4"
        >
          Add a guardian
        </button>
      )}

      {canWrite && adding && (
        <form onSubmit={(e) => void add(e)} className="my-4 space-y-4 border-t border-[var(--color-border)] pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input name="nameBn" label="Name (Bangla)" required />
            <Input name="nameEn" label="Name (English)" required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input name="phone" label="Mobile" type="tel" hint="+8801XXXXXXXXX" />
            <div>
              <label htmlFor="relationship" className="block text-sm font-medium">
                Relationship
              </label>
              <select
                id="relationship"
                name="relationship"
                required
                className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
              >
                <option value="father">Father</option>
                <option value="mother">Mother</option>
                <option value="guardian">Guardian</option>
                <option value="emergency">Emergency contact</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          {/* Two independent checkboxes, never a radio pair. */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Responsibilities</legend>
            <Check name="isBillingGuardian" label="Pays the fees" />
            <Check name="isPrimaryContact" label="Is contacted first" />
            <p className="text-sm text-[var(--color-text-muted)]">
              These are separate on purpose. One parent may pay while the other
              is contacted.
            </p>
          </fieldset>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="min-h-11 rounded bg-[var(--brand-primary)] px-4 text-[var(--brand-on-primary)] disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Add guardian'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
              className="min-h-11 rounded border border-[var(--color-border)] px-4"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Input({
  name,
  label,
  hint,
  type = 'text',
  required,
}: {
  name: string;
  label: string;
  hint?: string;
  type?: string;
  required?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        placeholder={hint}
        className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
      />
    </div>
  );
}

function Check({ name, label }: { name: string; label: string }): React.JSX.Element {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} className="h-4 w-4" />
      {label}
    </label>
  );
}

function Tag({
  children,
  muted,
}: {
  children: React.ReactNode;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs ${
        muted
          ? 'border border-[var(--color-border)] text-[var(--color-text-muted)]'
          : 'bg-[var(--brand-primary)] text-[var(--brand-on-primary)]'
      }`}
    >
      {children}
    </span>
  );
}
