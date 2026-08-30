'use client';

/**
 * Defining what a school charges for, and what it costs by class or section.
 *
 * Same submit shape as StructureForms.tsx: the server refuses for a reason
 * worth reading, and each form maps the codes it can actually provoke.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Card, CardContent, Checkbox, Label, Select as UiSelect } from '../../../../../../../components/ui';
import { FormField, MoneyInput } from '../../../../../../../components/patterns';

export interface Option {
  id: string;
  label: string;
}

const MESSAGES: Record<string, string> = {
  VALIDATION_FAILED: 'Check the values and try again.',
  CODE_TAKEN: 'A fee head with that code already exists at this school.',
  SCOPE_ALREADY_DEFINED: 'That fee head already has a price for this exact class or section.',
  TENANT_SUSPENDED: 'This school is read-only.',
};

function useSubmit(): {
  busy: boolean;
  error: string | null;
  send: (path: string, body: unknown) => Promise<void>;
  clear: () => void;
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
      // Reload rather than patch local state — same reasoning as every other
      // admin form here: the list this page shows is the server's, not a
      // client-side guess at what the server just did.
      window.location.reload();
      return;
    }

    const json = (await res.json().catch(() => ({}))) as {
      error?: { code: string; message: string };
    };
    setBusy(false);
    setError(MESSAGES[json.error?.code ?? ''] ?? json.error?.message ?? 'That did not work.');
  }

  return { busy, error, send, clear: () => setError(null) };
}

function Panel({
  title,
  description,
  open,
  onOpen,
  onClose,
  error,
  children,
}: {
  title: string;
  description?: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  error: string | null;
  children: ReactNode;
}): React.JSX.Element {
  if (!open) {
    return (
      <Button variant="secondary" onClick={onOpen}>
        {title}
      </Button>
    );
  }
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="font-medium text-[var(--color-text)]">{title}</p>
        {description && <p className="mt-1 mb-3 text-sm text-[var(--color-text-muted)]">{description}</p>}
        {error && (
          <p role="alert" className="mb-3 text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
        {children}
        <Button type="button" variant="ghost" size="sm" onClick={onClose} className="mt-3">
          Cancel
        </Button>
      </CardContent>
    </Card>
  );
}

function Submit({ busy, label }: { busy: boolean; label: string }): React.JSX.Element {
  return (
    <Button type="submit" disabled={busy}>
      {busy ? 'Saving…' : label}
    </Button>
  );
}

const str = (f: FormData, k: string): string | undefined => {
  const v = f.get(k);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

// ── fee head ─────────────────────────────────────────────────────────────────

export function AddFeeHead(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { busy, error, send, clear } = useSubmit();

  return (
    <Panel
      title="Define a fee"
      description="A fee head is what a school charges for — tuition, an exam fee, admission. The price by class comes next, separately."
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => {
        setOpen(false);
        clear();
      }}
      error={error}
    >
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
            sequence: Number(str(f, 'sequence') ?? '0'),
          });
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField name="code" label="Code" required placeholder="TUITION" hint="Short, unique at this school. Never shown to a guardian." />
          <div>
            <Label htmlFor="frequency">Frequency</Label>
            <UiSelect id="frequency" name="frequency" required defaultValue="monthly" className="mt-2">
              <option value="one_time">One-time</option>
              <option value="monthly">Monthly</option>
              <option value="term">Per term</option>
              <option value="annual">Annual</option>
            </UiSelect>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField name="nameBn" label="Name (Bangla)" required placeholder="বেতন" />
          <FormField name="nameEn" label="Name (English)" required placeholder="Tuition" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            name="sequence"
            label="Order"
            type="number"
            defaultValue="0"
            hint="Decides collection order when a payment doesn't cover everything owed — lower clears first."
          />
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <Checkbox name="isRefundable" />
            Refundable
          </label>
        </div>
        <Submit busy={busy} label="Add fee" />
      </form>
    </Panel>
  );
}

// ── fee structure ────────────────────────────────────────────────────────────

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
  const [open, setOpen] = useState(false);
  const { busy, error, send, clear } = useSubmit();

  if (feeHeads.length === 0) {
    return (
      <p className="text-sm text-[var(--color-text-muted)]">Define a fee first, then price it here.</p>
    );
  }

  return (
    <Panel
      title="Price a fee"
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => {
        setOpen(false);
        clear();
      }}
      error={error}
    >
      <form
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          // "class:ID" or "section:ID" — one combined field so the form can
          // never submit both or neither, which the database CHECK would
          // otherwise refuse with no field to point at.
          const [scopeKind, scopeId] = (str(f, 'scope') ?? '').split(':');
          void send('/api/v1/fee-structures', {
            academicYearId,
            feeHeadId: str(f, 'feeHeadId'),
            ...(scopeKind === 'class' ? { classLevelId: scopeId } : {}),
            ...(scopeKind === 'section' ? { sectionId: scopeId } : {}),
            amountMinor: str(f, 'amountMinor'),
            ...(str(f, 'dueDay') ? { dueDay: Number(str(f, 'dueDay')) } : {}),
          });
        }}
        className="space-y-3"
      >
        <div>
          <Label htmlFor="feeHeadId">Fee</Label>
          <UiSelect id="feeHeadId" name="feeHeadId" required className="mt-2">
            {feeHeads.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
              </option>
            ))}
          </UiSelect>
        </div>

        <div>
          <Label htmlFor="scope">Applies to</Label>
          <UiSelect id="scope" name="scope" required className="mt-2">
            <optgroup label="Whole class">
              {classLevels.map((c) => (
                <option key={c.id} value={`class:${c.id}`}>
                  {c.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="One section only">
              {sections.map((s) => (
                <option key={s.id} value={`section:${s.id}`}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          </UiSelect>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <MoneyInput name="amountMinor" label="Amount" required />
          <FormField
            name="dueDay"
            label="Due day of month"
            type="number"
            hint="Optional. 1–31."
          />
        </div>
        <Submit busy={busy} label="Add price" />
      </form>
    </Panel>
  );
}
