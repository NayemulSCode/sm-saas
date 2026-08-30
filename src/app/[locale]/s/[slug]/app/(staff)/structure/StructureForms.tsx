'use client';

/**
 * The forms that change a school's shape.
 *
 * All four share one submit path because they share one failure mode: the
 * server refuses for a reason worth reading, and the reason has to reach the
 * person rather than becoming "something went wrong". Each form maps the codes
 * it can actually provoke; anything else falls through to the server's message.
 */

import { useState, type FormEvent, type ReactNode } from 'react';
import { Button, Card, CardContent, Checkbox, Label, Select as UiSelect } from '../../../../../../../components/ui';
import { FormField, ConfirmDialog } from '../../../../../../../components/patterns';

export interface Option {
  id: string;
  label: string;
}

const MESSAGES: Record<string, string> = {
  VALIDATION_FAILED: 'Check the values and try again.',
  LEVEL_NAME_TAKEN: 'A class with that name — or that position — already exists.',
  YEAR_NAME_TAKEN: 'A year with that name already exists.',
  YEAR_OVERLAPS:
    'That range overlaps an existing year. Two years covering one day makes "which year is this?" ambiguous.',
  INVALID_YEAR_DATES: 'The end must be after the start, and a year cannot span decades.',
  YEAR_STILL_CURRENT:
    'This is the current year. Open its successor first — that moves the flag — then close this one.',
  YEAR_ALREADY_CLOSED: 'That year is already closed.',
  INVALID_SHIFT_TIMES: 'A shift must end after it starts.',
  SHIFT_WRONG_CAMPUS: 'That shift belongs to a different campus.',
  CAMPUS_NOT_FOUND: 'That campus no longer exists.',
  CLASS_LEVEL_NOT_FOUND: 'That class no longer exists.',
  CLASS_TEACHER_NOT_FOUND: 'That teacher is not on file.',
  REORDER_MID_YEAR:
    'Students are already enrolled this year. Promotion is keyed to this order, so it cannot change under a cohort.',
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
      // Reload rather than patch local state: opening a year moves the current
      // flag off another one, and re-deriving that here would be a second copy
      // of a rule that already lives in one place.
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
        {description && (
          <p className="mt-1 mb-3 text-sm text-[var(--color-text-muted)]">{description}</p>
        )}
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

// ── class level ──────────────────────────────────────────────────────────────

export function AddClassLevel({ schoolId }: { schoolId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { busy, error, send, clear } = useSubmit();

  return (
    <Panel
      title="Add a class"
      description="Added at the top of the ladder. A school adding a class is almost always extending upward, and inserting at the bottom would demote every existing class by a rung."
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
          void send('/api/v1/class-levels', {
            schoolId,
            nameBn: str(f, 'nameBn'),
            nameEn: str(f, 'nameEn'),
            loginEnabled: f.get('loginEnabled') === 'on',
          });
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField name="nameBn" label="Name (Bangla)" required placeholder="একাদশ শ্রেণি" />
          <FormField name="nameEn" label="Name (English)" required placeholder="Class 11" />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="loginEnabled" />
          Students in this class can sign in
        </label>
        <p className="text-sm text-[var(--color-text-muted)]">
          Kindergarten classes have no login at all.
        </p>
        <Submit busy={busy} label="Add class" />
      </form>
    </Panel>
  );
}

// ── section ──────────────────────────────────────────────────────────────────

export function AddSection({
  schoolId,
  classLevels,
  campuses,
  shifts,
}: {
  schoolId: string;
  classLevels: Option[];
  campuses: Option[];
  shifts: Array<Option & { campusId: string }>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [campusId, setCampusId] = useState(campuses[0]?.id ?? '');
  const { busy, error, send, clear } = useSubmit();

  // A shift belongs to a campus, and the working-day calendar is keyed by the
  // pair — so the shift list narrows when the campus changes rather than
  // offering one the server would refuse.
  const shiftsHere = shifts.filter((s) => s.campusId === campusId);

  return (
    <Panel
      title="Add a section"
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
          void send('/api/v1/sections', {
            schoolId,
            classLevelId: str(f, 'classLevelId'),
            campusId,
            shiftId: str(f, 'shiftId'),
            nameBn: str(f, 'nameBn'),
            nameEn: str(f, 'nameEn'),
            ...(str(f, 'capacity') ? { capacity: Number(str(f, 'capacity')) } : {}),
          });
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <PlainSelect name="classLevelId" label="Class" options={classLevels} />
          <PlainSelect
            name="campusId"
            label="Campus"
            options={campuses}
            value={campusId}
            onChange={setCampusId}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <PlainSelect
            name="shiftId"
            label="Shift"
            options={shiftsHere}
            hint="Required — a section without a shift cannot be timetabled."
          />
          <FormField name="capacity" label="Capacity" type="number" placeholder="40" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField name="nameBn" label="Name (Bangla)" required placeholder="ক" />
          <FormField name="nameEn" label="Name (English)" required placeholder="A" />
        </div>
        <Submit busy={busy} label="Add section" />
      </form>
    </Panel>
  );
}

// ── shift ────────────────────────────────────────────────────────────────────

export function AddShift({ campuses }: { campuses: Option[] }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { busy, error, send, clear } = useSubmit();

  return (
    <Panel
      title="Add a shift"
      description="A shift has its own timetable and its own working-day calendar, so add one only if the school actually runs it — an unused shift shows an empty calendar that looks like a fault."
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
          void send('/api/v1/shifts', {
            campusId: str(f, 'campusId'),
            nameBn: str(f, 'nameBn'),
            nameEn: str(f, 'nameEn'),
            startTime: str(f, 'startTime'),
            endTime: str(f, 'endTime'),
          });
        }}
        className="space-y-3"
      >
        <PlainSelect name="campusId" label="Campus" options={campuses} />
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField name="nameBn" label="Name (Bangla)" required placeholder="প্রভাতী" />
          <FormField name="nameEn" label="Name (English)" required placeholder="Morning" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField name="startTime" label="Starts" type="time" required defaultValue="07:00" />
          <FormField name="endTime" label="Ends" type="time" required defaultValue="11:30" />
        </div>
        <Submit busy={busy} label="Add shift" />
      </form>
    </Panel>
  );
}

// ── academic year ────────────────────────────────────────────────────────────

export function OpenYear({ schoolId }: { schoolId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { busy, error, send, clear } = useSubmit();
  const nextYear = new Date().getFullYear() + 1;

  return (
    <Panel
      title="Open an academic year"
      description="Making it current moves the flag off the previous year in the same transaction, so the school is never left without one."
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
          void send('/api/v1/academic-years', {
            schoolId,
            name: str(f, 'name'),
            startDate: str(f, 'startDate'),
            endDate: str(f, 'endDate'),
            makeCurrent: f.get('makeCurrent') === 'on',
          });
        }}
        className="space-y-3"
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField name="name" label="Name" required defaultValue={String(nextYear)} />
          <FormField
            name="startDate"
            label="Starts"
            type="date"
            required
            defaultValue={`${nextYear}-01-01`}
          />
          <FormField
            name="endDate"
            label="Ends"
            type="date"
            required
            defaultValue={`${nextYear}-12-31`}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="makeCurrent" defaultChecked />
          Make this the current year
        </label>
        <Submit busy={busy} label="Open year" />
      </form>
    </Panel>
  );
}

export function CloseYear({
  academicYearId,
  name,
}: {
  academicYearId: string;
  name: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, send, clear } = useSubmit();

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) clear();
      }}
      trigger={
        <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
          Close {name}
        </Button>
      }
      title={`Close ${name}`}
      description="Closing is not reversible from here, and it requires a reason. At least ten characters — somebody reads this a year later."
      reason={{
        value: reason,
        onChange: setReason,
        label: 'Reason',
        placeholder: 'The 2027 session has finished',
        minLength: 3,
      }}
      confirmLabel={busy ? 'Saving…' : 'Close year'}
      destructive
      busy={busy}
      error={error}
      onConfirm={() => void send(`/api/v1/academic-years/${academicYearId}/close`, { reason })}
    />
  );
}

// ── shared ───────────────────────────────────────────────────────────────────

function PlainSelect({
  name,
  label,
  options,
  hint,
  value,
  onChange,
}: {
  name: string;
  label: string;
  options: Option[];
  hint?: string;
  value?: string;
  onChange?: (v: string) => void;
}): React.JSX.Element {
  return (
    <div>
      <Label htmlFor={name}>{label}</Label>
      <UiSelect
        id={name}
        name={name}
        required
        {...(onChange ? { value, onChange: (e) => onChange(e.target.value) } : {})}
        className="mt-1"
      >
        {options.length === 0 && <option value="">None available</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </UiSelect>
      {hint && <p className="mt-1 text-sm text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}
