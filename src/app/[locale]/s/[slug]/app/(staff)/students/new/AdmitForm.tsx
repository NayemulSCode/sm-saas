'use client';

/**
 * Admitting a student.
 *
 * One transaction behind this button creates a person, a student, their first
 * enrolment and the opening status event. The form has to feel like one action
 * because it is one.
 *
 * BOTH NAMES ARE REQUIRED. Neither is a translation of the other (ADR-0019):
 * the report card prints one and the board registration list needs the other,
 * and a school that fills in only English discovers this in December.
 */

import { useState, type FormEvent } from 'react';

export interface SectionOption {
  id: string;
  label: string;
}

interface Props {
  schoolId: string;
  academicYearId: string | null;
  sections: SectionOption[];
  redirectBase: string;
}

const MESSAGES: Record<string, string> = {
  VALIDATION_FAILED: 'Some details need correcting.',
  SECTION_NOT_FOUND: 'That section is no longer available.',
  INVALID_ADMISSION_DATE: 'Check the dates.',
  TENANT_SUSPENDED: 'This school is read-only.',
};

export function AdmitForm({
  schoolId,
  academicYearId,
  sections,
  redirectBase,
}: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  if (!academicYearId) {
    return (
      <p className="rounded border border-[var(--color-danger)] p-4 text-sm">
        This school has no current academic year, so nobody can be enrolled.
        Open one first.
      </p>
    );
  }

  if (sections.length === 0) {
    return (
      <p className="rounded border border-[var(--color-border)] p-4 text-sm">
        There are no sections yet. A student has to be enrolled into one, so
        create a section before admitting anybody.
      </p>
    );
  }

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});

    const form = new FormData(e.currentTarget);
    const value = (k: string): string | undefined => {
      const v = form.get(k);
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    };

    const res = await fetch('/api/v1/students', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        schoolId,
        academicYearId,
        sectionId: value('sectionId'),
        nameBn: value('nameBn'),
        nameEn: value('nameEn'),
        ...(value('dateOfBirth') ? { dateOfBirth: value('dateOfBirth') } : {}),
        ...(value('gender') ? { gender: value('gender') } : {}),
        ...(value('phone') ? { phone: value('phone') } : {}),
        ...(value('rollNo') ? { rollNo: Number(value('rollNo')) } : {}),
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: { studentId: string };
      error?: { code: string; message: string; details?: Array<{ field: string; message: string }> };
    };

    if (res.ok && body.data) {
      window.location.assign(`${redirectBase}/students/${body.data.studentId}`);
      return;
    }

    setBusy(false);
    // Per-field messages, so the form can mark the field rather than making
    // somebody re-read the whole thing looking for what is wrong.
    if (body.error?.details) {
      setFields(Object.fromEntries(body.error.details.map((d) => [d.field, d.message])));
    }
    setError(MESSAGES[body.error?.code ?? ''] ?? body.error?.message ?? 'Admission failed.');
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-5">
      {error && (
        <p
          role="alert"
          className="rounded border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]"
        >
          {error}
        </p>
      )}

      <Field
        name="nameBn"
        label="Name (Bangla)"
        hint="Printed on the report card. Required."
        error={fields['nameBn']}
        required
      />
      <Field
        name="nameEn"
        label="Name (English)"
        hint="Used on the board registration list. Required, and not a translation of the above."
        error={fields['nameEn']}
        required
      />

      <div>
        <label htmlFor="sectionId" className="block text-sm font-medium">
          Section
        </label>
        <select
          id="sectionId"
          name="sectionId"
          required
          className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
        >
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          name="rollNo"
          label="Roll number"
          hint="Optional. Reassigned at every promotion."
          type="number"
          error={fields['rollNo']}
        />
        <Field
          name="dateOfBirth"
          label="Date of birth"
          type="date"
          error={fields['dateOfBirth']}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="gender" className="block text-sm font-medium">
            Gender
          </label>
          <select
            id="gender"
            name="gender"
            defaultValue=""
            className="mt-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-base"
          >
            <option value="">Not recorded</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
          </select>
        </div>
        <Field
          name="phone"
          label="Contact number"
          hint="+8801XXXXXXXXX. A contact detail, not a login."
          type="tel"
          error={fields['phone']}
        />
      </div>

      <button
        type="submit"
        disabled={busy}
        className="min-h-11 w-full rounded bg-[var(--brand-primary)] px-4 font-medium text-[var(--brand-on-primary)] disabled:opacity-60 sm:w-auto"
      >
        {busy ? 'Admitting…' : 'Admit student'}
      </button>
    </form>
  );
}

function Field({
  name,
  label,
  hint,
  error,
  type = 'text',
  required,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  type?: string;
  required?: boolean;
}): React.JSX.Element {
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium">
        {label}
      </label>
      {hint && (
        <p id={`${name}-hint`} className="mt-1 text-sm text-[var(--color-text-muted)]">
          {hint}
        </p>
      )}
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        aria-describedby={hint ? `${name}-hint` : undefined}
        aria-invalid={error ? true : undefined}
        className={`mt-2 w-full rounded border bg-[var(--color-surface-raised)] px-3 py-2 text-base ${
          error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border)]'
        }`}
      />
      {error && <p className="mt-1 text-sm text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}
