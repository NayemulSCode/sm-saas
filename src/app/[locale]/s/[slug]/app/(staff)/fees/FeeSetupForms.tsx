'use client';

/**
 * The two forms that define what a school charges. §13.1.
 *
 * Both share one submit path: the server refuses for a reason worth reading,
 * and `ERROR_MESSAGE` maps the codes each form can actually provoke — the
 * same shape `CollectPayment.tsx` and `WithdrawButton.tsx` already use.
 */

import { useState, type FormEvent } from 'react';
import { Button, Select } from '../../../../../../../components/ui';
import { MoneyInput } from '../../../../../../../components/patterns';

export interface Option {
  id: string;
  label: string;
}

const ERROR_MESSAGE: Record<string, string> = {
  VALIDATION_FAILED: 'Check the values and try again.',
  CODE_TAKEN: 'That code is already in use.',
  YEAR_NOT_FOUND: 'No academic year is open.',
  HEAD_NOT_FOUND: 'That fee head no longer exists.',
  SCOPE_NOT_FOUND: 'That class or section no longer exists.',
  SCOPE_SCHOOL_MISMATCH: 'That class or section belongs to a different school.',
  DUPLICATE_SCOPE: 'This head already has a price for that class or section, this year.',
  TENANT_SUSPENDED: 'This school is read-only.',
};

function useSubmit(): {
  busy: boolean;
  error: string | null;
  send: (path: string, body: unknown) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(path: string, body: unknown): Promise<void> {
    setBusy(true);
    setError(null);

    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });

    if (res.ok) {
      // Reload rather than patch local state — the same reasoning
      // `StructureForms.tsx` already gives: re-deriving the list here would
      // be a second copy of a rule (sorting, dedup) that lives server-side.
      window.location.reload();
      return;
    }

    const json = (await res.json().catch(() => ({}))) as {
      error?: { code: string; message: string };
    };
    setBusy(false);
    setError(ERROR_MESSAGE[json.error?.code ?? ''] ?? json.error?.message ?? 'That did not work.');
  }

  return { busy, error, send };
}

const str = (f: FormData, k: string): string | undefined => {
  const v = f.get(k);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

export function AddFeeHead(): React.JSX.Element {
  const { busy, error, send } = useSubmit();

  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void send('/api/v1/fee-heads', {
          code: str(f, 'code'),
          nameBn: str(f, 'nameBn'),
          nameEn: str(f, 'nameEn'),
          frequency: str(f, 'frequency'),
          isRefundable: f.get('isRefundable') === 'on',
        });
      }}
      className="space-y-3"
    >
      <p className="text-sm font-medium">Add a fee head</p>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field name="code" label="Code" required placeholder="TUITION" />
        <Field name="nameBn" label="Name (Bangla)" required placeholder="বেতন" />
        <Field name="nameEn" label="Name (English)" required placeholder="Tuition" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="frequency" className="block text-sm font-medium">
            Frequency
          </label>
          <div className="mt-1">
            <Select id="frequency" name="frequency" defaultValue="monthly">
              <option value="one_time">One-time</option>
              <option value="monthly">Monthly</option>
              <option value="term">Per term</option>
              <option value="annual">Annual</option>
            </Select>
          </div>
        </div>
        <label className="flex items-center gap-2 self-end pb-3 text-sm">
          <input type="checkbox" name="isRefundable" className="h-4 w-4" />
          Refunded on withdrawal (e.g. a security deposit)
        </label>
      </div>
      <Button type="submit" disabled={busy}>
        {busy ? 'Adding…' : 'Add fee head'}
      </Button>
    </form>
  );
}

export function AddFeeStructure({
  academicYearId,
  feeHeads,
  classLevels,
  sections,
}: {
  academicYearId: string;
  feeHeads: Option[];
  classLevels: Option[];
  sections: Option[];
}): React.JSX.Element {
  const { busy, error, send } = useSubmit();
  const [scope, setScope] = useState<'class' | 'section'>('class');
  const [amountMinor, setAmountMinor] = useState('0');

  return (
    <form
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void send('/api/v1/fee-structures', {
          academicYearId,
          feeHeadId: str(f, 'feeHeadId'),
          ...(scope === 'class'
            ? { classLevelId: str(f, 'classLevelId') }
            : { sectionId: str(f, 'sectionId') }),
          amountMinor,
          ...(str(f, 'dueDay') ? { dueDay: Number(str(f, 'dueDay')) } : {}),
        });
      }}
      className="space-y-3"
    >
      <p className="text-sm font-medium">Price a class or a section</p>
      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <div>
        <label htmlFor="feeHeadId" className="block text-sm font-medium">
          Fee head
        </label>
        <div className="mt-1">
          <Select id="feeHeadId" name="feeHeadId" required>
            {feeHeads.length === 0 && <option value="">Add a fee head first</option>}
            {feeHeads.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <fieldset className="flex gap-4 text-sm">
        <legend className="mb-1 block text-sm font-medium">Applies to</legend>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="scope"
            checked={scope === 'class'}
            onChange={() => setScope('class')}
          />
          A whole class
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="scope"
            checked={scope === 'section'}
            onChange={() => setScope('section')}
          />
          One section
        </label>
      </fieldset>

      {scope === 'class' ? (
        <Select name="classLevelId" required>
          {classLevels.length === 0 && <option value="">No classes yet</option>}
          {classLevels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      ) : (
        <Select name="sectionId" required>
          {sections.length === 0 && <option value="">No sections yet</option>}
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="amountMinor" className="block text-sm font-medium">
            Amount
          </label>
          <div className="mt-1">
            <MoneyInput id="amountMinor" value={amountMinor} onChange={setAmountMinor} required />
          </div>
        </div>
        <Field name="dueDay" label="Due day (optional)" type="number" placeholder="10" />
      </div>

      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Set price'}
      </Button>
    </form>
  );
}

function Field({
  name,
  label,
  type = 'text',
  required,
  placeholder,
}: {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
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
        placeholder={placeholder}
        className="mt-1 w-full min-h-11 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base"
      />
    </div>
  );
}
