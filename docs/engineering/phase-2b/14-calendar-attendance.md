# 14. Calendar, academics and attendance — schema and contracts (Phase 3c)

Calendar first, because attendance depends on working days
([roadmap §45.3](../../architecture/phase-1c/45-roadmap.md)). The calendar is
**infrastructure**: five modules ask it the same question and must get the same
answer ([ADR-0013](../../architecture/adr/0013-calendar-as-infrastructure.md)).

## 14.1 Calendar schema

```sql
-- [P] Platform-provided categories; tenants may add their own.
CREATE TABLE holiday_category (
  id         uuid PRIMARY KEY,
  tenant_id  uuid REFERENCES tenant(id),        -- NULL = platform category
  code       text NOT NULL,
  name_bn    text NOT NULL,
  name_en    text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX ON holiday_category (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

-- [P] The importable government calendar, versioned per year.
CREATE TABLE government_holiday (
  id             uuid PRIMARY KEY,
  year           integer NOT NULL,
  version        integer NOT NULL,
  category_code  text NOT NULL,
  title_bn       text NOT NULL,
  title_en       text NOT NULL,
  start_date     date NOT NULL,
  end_date       date NOT NULL CHECK (end_date >= start_date),
  is_provisional boolean NOT NULL DEFAULT false,
  published_at   timestamptz,
  UNIQUE (year, version, category_code, start_date, title_en)
);

-- [T] A holiday at any level of the hierarchy.
CREATE TABLE holiday (
  -- + std
  level          text NOT NULL
                   CHECK (level IN ('organization','school','campus','class','section')),
  level_ref_id   uuid NOT NULL,
  category_id    uuid NOT NULL REFERENCES holiday_category(id),
  title_bn       text NOT NULL,
  title_en       text NOT NULL,
  description    text,
  start_date     date NOT NULL,
  end_date       date NOT NULL CHECK (end_date >= start_date),
  start_time     time,
  end_time       time,
  is_full_day    boolean NOT NULL DEFAULT true,
  -- Eid shifts on moon sighting. TWICE A YEAR, EVERY YEAR, every tenant —
  -- this is the normal path, not an edge case.
  state          text NOT NULL DEFAULT 'confirmed'
                   CHECK (state IN ('provisional','confirmed','cancelled')),
  source_government_holiday_id uuid REFERENCES government_holiday(id),
  -- Suppression, not just addition: a school must be able to CANCEL an
  -- inherited government holiday, not merely add to it (FR-5.4).
  suppresses_holiday_id uuid REFERENCES holiday(id),
  -- Effective dating: editing the calendar in July must not rewrite January's
  -- attendance denominators.
  effective_from date NOT NULL DEFAULT '0001-01-01',
  effective_to   date NOT NULL DEFAULT '9999-12-31',
  approved_by    uuid REFERENCES person(id),
  approved_at    timestamptz,
  CHECK (is_full_day OR (start_time IS NOT NULL AND end_time IS NOT NULL))
);
CREATE INDEX ON holiday (tenant_id, start_date, end_date);
CREATE INDEX ON holiday (tenant_id, level, level_ref_id);
CREATE INDEX ON holiday (tenant_id, state) WHERE state = 'provisional';

-- The weekend is CONFIGURATION, effective-dated. National conventions have
-- changed within living memory (FR-5.6).
CREATE TABLE weekly_off_pattern (
  -- + std
  campus_id      uuid REFERENCES campus(id),
  shift_id       uuid REFERENCES shift(id),
  days_of_week   smallint[] NOT NULL,           -- {5,6} = Fri, Sat (0 = Sunday)
  effective_from date NOT NULL,
  effective_to   date,
  CHECK (array_length(days_of_week, 1) BETWEEN 0 AND 7)
);
CREATE INDEX ON weekly_off_pattern (tenant_id, campus_id, shift_id, effective_from);

-- THE materialised answer. Every module reads this; none recomputes it.
-- Invariant 8. ~146k rows/year at 100 schools — trivial to store, and it turns
-- the hottest question in the system into one indexed lookup.
CREATE TABLE working_day (
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  campus_id        uuid NOT NULL REFERENCES campus(id),
  shift_id         uuid NOT NULL REFERENCES shift(id),
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  date             date NOT NULL,
  status           text NOT NULL
                     CHECK (status IN ('working','weekly_off','holiday',
                                       'exam_only','partial')),
  source_holiday_id uuid REFERENCES holiday(id),
  source_level     text,
  -- So the UI can explain itself: "Friday — weekly off", never "unavailable".
  reason_bn        text NOT NULL,
  reason_en        text NOT NULL,
  is_provisional   boolean NOT NULL DEFAULT false,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  computation_version integer NOT NULL,
  PRIMARY KEY (tenant_id, campus_id, shift_id, date)
);
CREATE INDEX ON working_day (tenant_id, academic_year_id, date);

-- Section-level rows exist ONLY where a section override exists. Materialising
-- every section unconditionally would multiply the table by the section count
-- for no benefit.
CREATE TABLE working_day_section_override (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  section_id uuid NOT NULL REFERENCES section(id),
  date       date NOT NULL,
  status     text NOT NULL,
  source_holiday_id uuid REFERENCES holiday(id),
  reason_bn  text NOT NULL,
  reason_en  text NOT NULL,
  PRIMARY KEY (tenant_id, section_id, date)
);

-- The audit trail for a retroactive holiday, and what makes it REVERSIBLE.
CREATE TABLE calendar_recompute (
  -- + std
  trigger        text NOT NULL,
  affected_from  date NOT NULL,
  affected_to    date NOT NULL,
  campus_id      uuid REFERENCES campus(id),
  shift_id       uuid REFERENCES shift(id),
  status         text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','running','done','failed','reversed')),
  started_at     timestamptz,
  finished_at    timestamptz,
  changes        jsonb,                         -- the full change set
  error          text
);

CREATE TABLE academic_event (
  -- + std
  level        text NOT NULL,
  level_ref_id uuid NOT NULL,
  type         text NOT NULL,
  title_bn     text NOT NULL,
  title_en     text NOT NULL,
  start_date   date NOT NULL,
  end_date     date NOT NULL CHECK (end_date >= start_date),
  start_time   time,
  end_time     time,
  visibility   text NOT NULL DEFAULT 'all'
                 CHECK (visibility IN ('all','staff','guardians'))
);
```

## 14.2 Academics (minimal, needed by attendance and timetable)

```sql
CREATE TABLE curriculum (
  -- + std
  name_bn text NOT NULL, name_en text NOT NULL,
  authority text                                 -- 'NCTB' | 'Cambridge' | own
);
ALTER TABLE class_level ADD CONSTRAINT class_level_curriculum_fk
  FOREIGN KEY (curriculum_id) REFERENCES curriculum(id);   -- the 3a stub, resolved

CREATE TABLE subject (
  -- + std
  curriculum_id uuid REFERENCES curriculum(id),
  code        text NOT NULL,
  name_bn     text NOT NULL, name_en text NOT NULL,
  is_optional boolean NOT NULL DEFAULT false,
  sequence    integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, code)
);
ALTER TABLE staff_subject_assignment ADD CONSTRAINT ssa_subject_fk
  FOREIGN KEY (subject_id) REFERENCES subject(id);          -- the 3a stub, resolved

CREATE TABLE class_subject (
  -- + std
  class_level_id   uuid NOT NULL REFERENCES class_level(id),
  subject_id       uuid NOT NULL REFERENCES subject(id),
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  is_mandatory       boolean NOT NULL DEFAULT true,
  is_fourth_subject  boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, class_level_id, subject_id, academic_year_id),
  -- A subject cannot be both mandatory and the fourth subject (§14.7).
  CHECK (NOT (is_mandatory AND is_fourth_subject))
);

CREATE TABLE period (
  -- + std
  shift_id   uuid NOT NULL REFERENCES shift(id),
  sequence   integer NOT NULL,
  start_time time NOT NULL,
  end_time   time NOT NULL CHECK (end_time > start_time),
  is_break   boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, shift_id, sequence)
);

CREATE TABLE timetable_entry (
  -- + std
  section_id       uuid NOT NULL REFERENCES section(id),
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  day_of_week      smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  period_id        uuid NOT NULL REFERENCES period(id),
  subject_id       uuid NOT NULL REFERENCES subject(id),
  staff_id         uuid REFERENCES staff(id),
  room             text,
  effective_from   date NOT NULL,
  effective_to     date,
  UNIQUE (tenant_id, section_id, academic_year_id, day_of_week, period_id,
          effective_from)
);
CREATE INDEX ON timetable_entry (tenant_id, staff_id, day_of_week, period_id);

CREATE TABLE timetable_substitution (
  -- + std
  timetable_entry_id  uuid NOT NULL REFERENCES timetable_entry(id),
  date                date NOT NULL,
  substitute_staff_id uuid NOT NULL REFERENCES staff(id),
  reason              text,
  UNIQUE (tenant_id, timetable_entry_id, date)   -- date-scoped; never edits the base
);
```

## 14.3 Attendance schema

```sql
-- Tenant-extensible vocabulary, not a CHECK constraint.
CREATE TABLE attendance_status (
  -- + std
  code             text NOT NULL,
  name_bn          text NOT NULL, name_en text NOT NULL,
  counts_as_present boolean NOT NULL,
  sequence         integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, code)
);

CREATE TABLE attendance (
  -- + std
  student_id       uuid NOT NULL REFERENCES student(id),
  section_id       uuid NOT NULL REFERENCES section(id),
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  date             date NOT NULL,
  period_no        smallint,                    -- NULL = day-wise (FR-6.1)
  status_id        uuid NOT NULL REFERENCES attendance_status(id),
  remark           text,
  recorded_by      uuid NOT NULL REFERENCES person(id),
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual','offline_sync','device','import')),
  -- Device-generated ULID. THE idempotency key that makes replaying an offline
  -- queue safe (ADR-0018).
  client_ref       text,
  captured_at      timestamptz,                 -- device clock, untrusted
  clock_skew_ms    bigint,                      -- received_at − captured_at
  -- Corrections are NEW ROWS pointing back at the old one. Nothing is
  -- overwritten, so a retroactive holiday recompute is reversible (FR-6.5).
  supersedes_id    uuid REFERENCES attendance(id),
  superseded_by_id uuid REFERENCES attendance(id),
  amend_reason     text
);
-- One live record per student per date per period.
CREATE UNIQUE INDEX ON attendance (tenant_id, student_id, date, COALESCE(period_no, -1))
  WHERE superseded_by_id IS NULL AND deleted_at IS NULL;
-- Replay safety for the offline outbox.
CREATE UNIQUE INDEX ON attendance (tenant_id, client_ref)
  WHERE client_ref IS NOT NULL;
CREATE INDEX ON attendance (tenant_id, section_id, date);
CREATE INDEX ON attendance (tenant_id, student_id, date);
```

Partition by `date` monthly when the table passes 50 M rows
([§46.5](../../architecture/phase-1c/46-decision-summary.md)). At 100 schools ×
400 students × 220 days ≈ **8.8 M rows/year**, so that is years away — but no
unique constraint above omits a column that would block partitioning later.

## 14.4 The calendar contract

```ts
export interface CalendarService {
  isWorkingDay(sectionId: SectionId, date: LocalDate): Promise<boolean>;
  workingDays(sectionId: SectionId, range: DateRange): Promise<LocalDate[]>;
  workingDayCount(sectionId: SectionId, range: DateRange): Promise<number>;
  resolve(sectionId: SectionId, date: LocalDate): Promise<DayResolution>;
  nextWorkingDay(sectionId: SectionId, after: LocalDate): Promise<LocalDate>;
}
```

Resolution runs **suppression before precedence**
([§16.2](../../architecture/phase-1b/16-calendar-engine.md)); if precedence ran
first, a school row that merely exists would win and "this government holiday
does not apply to us" would be inexpressible.

`workingDayCount` is the **denominator** for every attendance percentage. "85%
attendance" is meaningless unless every module agrees how many working days there
were — which is the whole reason `working_day` is materialised once.

## 14.5 Retroactive holiday recompute

The case this design exists for: a closure announced at 09:00 for a day when
attendance was taken at 08:30.

```
recompute(range, campus, shift):            # one auditable job
  1. re-resolve working_day for the range
  2. RECLASSIFY attendance: write NEW superseding rows,
     amend_reason = 'retroactive holiday'          ← originals remain
  3. REVERSE late_fee_accrual dated in the range   ← reversal, not delete
  4. FLAG exam_schedule / timetable_entry now on a non-working day  (block)
  5. NOTIFY affected staff
  6. WRITE calendar_recompute.changes               ← makes 1–3 undoable
```

A day can move **into** the working set as well as out of it. A newly-working day
has no attendance recorded — which is correct, and the summary must treat it as
*unrecorded*, not as everyone absent.

## 14.6 API contracts

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/v1/calendar/resolve?sectionId=&date=` | `calendar.read` |
| `GET` | `/api/v1/calendar/working-days?sectionId=&from=&to=` | `calendar.read` |
| `GET`/`POST` | `/api/v1/holidays` | `calendar.read` / `calendar.manage` |
| `POST` | `/api/v1/holidays/:id:confirm` | `holiday.approve` |
| `POST` | `/api/v1/holidays/:id:suppress` | `calendar.manage` |
| `POST` | `/api/v1/government-calendar:import` | `calendar.manage` |
| `GET`/`POST` | `/api/v1/weekly-off-patterns` | `calendar.manage` |
| `GET` | `/api/v1/attendance?sectionId=&date=` | `attendance.read` |
| `POST` | `/api/v1/attendance:submit` | `attendance.write` |
| `POST` | `/api/v1/attendance:sync` | `attendance.write` |
| `POST` | `/api/v1/attendance/:id:amend` | `attendance.amend` |
| `GET` | `/api/v1/reports/attendance-summary` | `attendance.read` |

```ts
export const SubmitAttendanceSchema = z.object({
  sectionId: zUlid<'section'>(),
  date: zLocalDate,
  periodNo: z.number().int().min(1).max(20).optional(),
  records: z.array(z.object({
    studentId: zUlid<'student'>(),
    statusId:  zUlid<'attendanceStatus'>(),
    remark:    z.string().max(200).optional(),
    clientRef: z.string().length(26),           // device ULID — idempotency key
    capturedAt: z.string().datetime(),          // device clock, untrusted
  })).min(1).max(200),
}).strict();

export const SyncAttendanceSchema = z.object({
  batch: z.array(SubmitAttendanceSchema).max(20),
});

// Per-record acknowledgement: one bad record must not block the batch.
export const SyncResult = z.object({
  results: z.array(z.object({
    clientRef: z.string(),
    outcome: z.enum(['applied','duplicate','conflict','rejected']),
    reasonCode: z.string().optional(),          // MARKS_LOCKED, STUDENT_LEFT…
    serverRecordId: z.string().optional(),
  })),
});
```

**Nothing is resolved by silently discarding data.** A `rejected` record stays in
the client outbox, visible to the teacher with a reason and an action
([ADR-0018](../../architecture/adr/0018-offline-sync-model.md)).

## 14.7 Conflict rules

Named, severity-tagged, re-evaluated whenever the calendar changes
([§16.6](../../architecture/phase-1b/16-calendar-engine.md)).

| Rule | Severity |
|---|---|
| `EXAM_ON_HOLIDAY` | **block** |
| `EXAM_CLASH_SAME_CLASS` | **block** |
| `INVIGILATOR_DOUBLE_BOOKED` | **block** |
| `ROOM_DOUBLE_BOOKED` | **block** |
| `TEACHER_DOUBLE_BOOKED` | **block** |
| `CLASS_ON_NON_WORKING_DAY` | warn |
| `EVENT_OVERLAPS_EXAM` | warn |
| `HOLIDAY_OVERLAPS_MANDATORY_DATE` | warn |

`warn` requires an explicit acknowledgement **recorded with the actor** — so "we
know, we meant it" is captured rather than lost.

## 14.8 Acceptance for Phase 3c

1. `working_day` materialises a full year for a campus/shift in < 2 s.
2. A school suppresses an inherited government holiday and that date becomes
   working.
3. Confirming a provisional Eid shifts the range and cascades the recompute.
4. A **retroactive** holiday reclassifies attendance via superseding rows,
   reverses late fees, and flags exam conflicts — all reversible from
   `calendar_recompute.changes`.
5. Attendance submitted offline for 40 students syncs idempotently; a replay
   changes nothing.
6. A record rejected because marks were locked stays visible with its reason.
7. Attendance cannot be recorded on a non-working day without `attendance.amend`.
8. Every attendance percentage uses `workingDayCount` as its denominator.
