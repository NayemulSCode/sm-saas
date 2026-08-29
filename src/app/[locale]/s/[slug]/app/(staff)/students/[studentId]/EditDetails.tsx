'use client';

/**
 * Editing a student's details.
 *
 * Sends `version` with the change. If somebody else saved first the server
 * answers 409 and this says so plainly rather than silently discarding their
 * correction — two office assistants at one counter, one with the paper form
 * and one with the parent on the phone, is the ordinary case.
 */

import { useState, type FormEvent } from 'react';

export interface EditableStudent {
  version: number;
  nameBn: string;
  nameEn: string;
  dateOfBirth: string | null;
  gender: string | null;
  phone: string | null;
  house: string | null;
  religion: string | null;
  bloodGroup: string | null;
}

export function EditDetails({
  studentId,
  student,
}: {
  studentId: string;
  student: EditableStudent;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const form = new FormData(e.currentTarget);
    const str = (k: string): string | null => {
      const v = form.get(k);
      const t = typeof v === 'string' ? v.trim() : '';
      // Empty means CLEAR, sent as null — distinct from "not changed", which
      // is the field being absent altogether.
      return t === '' ? null : t;
    };

    const res = await fetch(`/api/v1/students/${studentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        version: student.version,
        nameBn: str('nameBn'),
        nameEn: str('nameEn'),
        dateOfBirth: str('dateOfBirth'),
        gender: str('gender'),
        phone: str('phone'),
        house: str('house'),
        religion: str('religion'),
        bloodGroup: str('bloodGroup'),
      }),
    });

    if (res.ok) {
      window.location.reload();
      return;
    }

    const body = (await res.json().catch(() => ({}))) as {
      error?: { code: string; message: string };
    };
    setBusy(false);

    setError(
      body.error?.code === 'CONCURRENT_MODIFICATION'
        ? 'Somebody else saved a change while this form was open. Reload to see theirs, then re-apply yours.'
        : body.error?.code === 'VALIDATION_FAILED'
          ? 'Check the details — a name cannot be blank and a number must be +8801XXXXXXXXX.'
          : (body.error?.message ?? 'The change did not save.'),
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-11 rounded border border-[var(--color-border)] px-4"
      >
        Edit details
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] p-4"
    >
      {error && (
        <p role="alert" className="mb-3 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Input name="nameBn" label="Name (Bangla)" defaultValue={student.nameBn} required />
        <Input name="nameEn" label="Name (English)" defaultValue={student.nameEn} required />
        <Input
          name="dateOfBirth"
          label="Date of birth"
          type="date"
          defaultValue={student.dateOfBirth ?? ''}
        />
        <div>
          <label htmlFor="gender" className="block text-sm font-medium">
            Gender
          </label>
          <select
            id="gender"
            name="gender"
            defaultValue={student.gender ?? ''}
            className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
          >
            <option value="">Not recorded</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
          </select>
        </div>
        <Input name="phone" label="Contact number" type="tel" defaultValue={student.phone ?? ''} />
        <Input name="house" label="House" defaultValue={student.house ?? ''} />
        <Input name="religion" label="Religion" defaultValue={student.religion ?? ''} />
        <Input name="bloodGroup" label="Blood group" defaultValue={student.bloodGroup ?? ''} />
      </div>

      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="min-h-11 rounded bg-[var(--brand-primary)] px-4 text-[var(--brand-on-primary)] disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Save changes'}
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

function Input({
  name,
  label,
  type = 'text',
  defaultValue,
  required,
}: {
  name: string;
  label: string;
  type?: string;
  defaultValue?: string;
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
        defaultValue={defaultValue}
        className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
      />
    </div>
  );
}
