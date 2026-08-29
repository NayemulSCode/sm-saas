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
import { Button, Label, Select } from '../../../../../../../../components/ui';
import { FormField, SectionPicker } from '../../../../../../../../components/patterns';

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
      <p className="rounded-[var(--radius-md)] border border-[var(--color-danger)] p-4 text-sm">
        This school has no current academic year, so nobody can be enrolled.
        Open one first.
      </p>
    );
  }

  if (sections.length === 0) {
    return (
      <p className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 text-sm">
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
          className="rounded-[var(--radius-md)] border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]"
        >
          {error}
        </p>
      )}

      <FormField
        name="nameBn"
        label="Name (Bangla)"
        hint="Printed on the report card. Required."
        error={fields['nameBn']}
        required
      />
      <FormField
        name="nameEn"
        label="Name (English)"
        hint="Used on the board registration list. Required, and not a translation of the above."
        error={fields['nameEn']}
        required
      />

      <div>
        <Label htmlFor="sectionId">Section</Label>
        <SectionPicker sections={sections} required className="mt-2" />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <FormField
          name="rollNo"
          label="Roll number"
          hint="Optional. Reassigned at every promotion."
          type="number"
          error={fields['rollNo']}
        />
        <FormField
          name="dateOfBirth"
          label="Date of birth"
          type="date"
          error={fields['dateOfBirth']}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="gender">Gender</Label>
          <Select id="gender" name="gender" defaultValue="" className="mt-2">
            <option value="">Not recorded</option>
            <option value="female">Female</option>
            <option value="male">Male</option>
            <option value="other">Other</option>
          </Select>
        </div>
        <FormField
          name="phone"
          label="Contact number"
          hint="+8801XXXXXXXXX. A contact detail, not a login."
          type="tel"
          error={fields['phone']}
        />
      </div>

      <Button type="submit" disabled={busy} size="lg" className="w-full sm:w-auto">
        {busy ? 'Admitting…' : 'Admit student'}
      </Button>
    </form>
  );
}
