'use client';

/**
 * The trigger and its result. §13.6/§13.7.
 *
 * No `Idempotency-Key` here — the API route's own header explains why: the
 * unique indexes on `invoice`/`invoice_line` already make a re-run safe
 * (nothing new gets created), which is a weaker but sufficient guarantee for
 * a synchronous request a person is watching, unlike a payment a network
 * retry might silently duplicate without one.
 */

import { useState, type FormEvent } from 'react';
import { Button, Select } from '../../../../../../../components/ui';
import { DateInput } from '../../../../../../../components/patterns';

export interface Option {
  id: string;
  label: string;
}

interface RunResult {
  studentsProcessed: number;
  invoicesCreated: number;
  invoicesReused: number;
  linesCreated: number;
}

/** Branch on `code`, never on `message` (§10.2). */
const ERROR_MESSAGE: Record<string, string> = {
  VALIDATION_FAILED: 'Check the values and try again.',
  YEAR_NOT_FOUND: 'That academic year no longer exists.',
  INVALID_DATES: 'The due date must be on or after the issue date.',
  TENANT_SUSPENDED: 'This school is read-only right now.',
};

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function GenerateInvoicesForm({
  years,
  defaultAcademicYearId,
}: {
  years: Option[];
  defaultAcademicYearId: string;
}): React.JSX.Element {
  const [academicYearId, setAcademicYearId] = useState(defaultAcademicYearId || years[0]!.id);
  const [periodLabel, setPeriodLabel] = useState('');
  const [issuedOn, setIssuedOn] = useState(todayIso);
  const [dueDate, setDueDate] = useState(todayIso);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const res = await fetch('/api/v1/invoices/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ academicYearId, periodLabel, issuedOn, dueDate }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      data?: RunResult;
      error?: { code: string; message: string };
    };

    setBusy(false);

    if (res.ok && body.data) {
      setResult(body.data);
      return;
    }

    setError(ERROR_MESSAGE[body.error?.code ?? ''] ?? body.error?.message ?? 'That did not go through.');
  }

  if (result) {
    return (
      <div className="space-y-4">
        <p className="text-sm font-medium">Done.</p>
        <ul className="space-y-1 text-sm text-[var(--color-text-muted)]">
          <li>{result.studentsProcessed} enrolments checked</li>
          <li>{result.invoicesCreated} invoices created</li>
          <li>{result.invoicesReused} invoices already existed for this period</li>
          <li>{result.linesCreated} lines added</li>
        </ul>
        <Button variant="secondary" onClick={() => setResult(null)}>
          Generate another run
        </Button>
      </div>
    );
  }

  const ready = academicYearId !== '' && periodLabel.trim() !== '' && issuedOn <= dueDate;

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="academicYearId" className="block text-sm font-medium">
            Academic year
          </label>
          <div className="mt-1">
            <Select
              id="academicYearId"
              value={academicYearId}
              onChange={(e) => setAcademicYearId(e.target.value)}
              required
            >
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <label htmlFor="periodLabel" className="block text-sm font-medium">
            Period
          </label>
          <input
            id="periodLabel"
            value={periodLabel}
            onChange={(e) => setPeriodLabel(e.target.value)}
            required
            maxLength={20}
            placeholder="2027-03"
            className="mt-1 w-full min-h-11 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 text-base"
          />
          <span className="mt-1 block text-sm text-[var(--color-text-muted)]">
            A label, not a parsed date — a month, a term, or "ADM".
          </span>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="issuedOn" className="block text-sm font-medium">
            Issued on
          </label>
          <div className="mt-1">
            <DateInput id="issuedOn" value={issuedOn} onChange={setIssuedOn} required />
          </div>
        </div>
        <div>
          <label htmlFor="dueDate" className="block text-sm font-medium">
            Due date
          </label>
          <div className="mt-1">
            <DateInput
              id="dueDate"
              value={dueDate}
              onChange={setDueDate}
              min={issuedOn}
              required
            />
          </div>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <Button type="submit" disabled={busy || !ready}>
        {busy ? 'Generating…' : 'Generate invoices'}
      </Button>
    </form>
  );
}
