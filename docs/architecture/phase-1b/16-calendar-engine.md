# 16. Academic calendar and holiday engine

Infrastructure, not a display feature ([ADR-0013](../adr/0013-calendar-as-infrastructure.md)).
Five modules ask it the same question and must get the same answer.

## 16.1 The published contract

```ts
interface CalendarService {
  isWorkingDay(sectionId: string, date: LocalDate): Promise<boolean>;
  workingDays(sectionId: string, range: DateRange): Promise<LocalDate[]>;
  workingDayCount(sectionId: string, range: DateRange): Promise<number>;
  resolve(sectionId: string, date: LocalDate): Promise<DayResolution>;
  nextWorkingDay(sectionId: string, after: LocalDate): Promise<LocalDate>;
}

interface DayResolution {
  status: 'working' | 'weekly_off' | 'holiday' | 'exam_only' | 'partial';
  holidayId?: string;
  source: 'section' | 'class' | 'campus' | 'school' | 'organization' | 'government';
  reasonBn: string;                 // "শুক্রবার — সাপ্তাহিক ছুটি"
  reasonEn: string;                 // "Friday — weekly off"
  isProvisional: boolean;
}
```

`resolve()` returning a **reason** is not decoration. A teacher blocked from
taking attendance must be told "Eid-ul-Fitr vacation (school calendar)", not
"not a working day" — otherwise every such day generates a support call.

`isProvisional` propagates so consuming UIs can show "expected holiday, subject
to confirmation" for an unconfirmed Eid.

## 16.2 Resolution algorithm

Runs per (campus, shift, date) when materialising `working_day`.

```
resolve(campus, shift, date):

  # 1. Collect candidates from every level
  candidates = holidays covering `date` for:
      section? (only when materialising a section override)
      class    of the sections in this campus/shift
      campus
      school
      organization
      government (imported into this tenant)
    filtered to rows where date BETWEEN effective_from AND effective_to
    and state != 'cancelled'

  # 2. SUPPRESSION PASS — runs BEFORE precedence.  FR-5.4
  #    A school row may cancel an inherited government holiday.
  suppressed = { h.suppresses_holiday_id for h in candidates if set }
  candidates = [h for h in candidates if h.id not in suppressed]

  # 3. PRECEDENCE — most specific wins
  order = section > class > campus > school > organization > government
  winner = first candidate in `order`; ties broken by created_at DESC

  if winner exists:
      return (status = winner.is_full_day ? 'holiday' : 'partial',
              source = winner.level, reason = winner.title,
              isProvisional = winner.state == 'provisional')

  # 4. WEEKLY OFF — effective-dated, per campus/shift.  FR-5.6
  pattern = weekly_off_pattern for (campus, shift) effective on `date`
  if date.dayOfWeek in pattern.days_of_week:
      return (status = 'weekly_off', reason = localized day name)

  # 5. ACADEMIC YEAR BOUNDS
  if date outside academic_year range:
      return (status = 'holiday', reason = 'outside session')

  return (status = 'working')
```

Two details worth stating:

**Suppression before precedence.** If precedence ran first, a school row that
merely *exists* would win and there would be no way to express "this government
holiday does not apply to us" without inventing a fake working-day holiday.
Explicit suppression keeps the intent readable in the data.

**Effective dating.** Rows carry `effective_from` / `effective_to` so editing the
weekend pattern in July does not retroactively rewrite January's attendance
denominators. History stays as it was.

## 16.3 Materialisation and rebuild triggers

`working_day` is a projection. Every trigger enqueues a `calendar_recompute` job
scoped to the smallest affected range.

| Trigger | Range rebuilt |
|---|---|
| Holiday created / edited / cancelled | The holiday's date range |
| Holiday confirmed (provisional → confirmed) | Its range, plus dependent cascade (§16.4) |
| Weekly-off pattern changed | `effective_from` → end of academic year |
| Academic year bounds changed | The whole year |
| Government calendar version imported | Imported ranges, for subscribing tenants |
| Campus or shift created | That campus/shift for the current year |
| Section-level override added | That section only |

A **nightly consistency job** recomputes a random sample and alerts on
mismatch. Materialised projections drift; the question is whether you find out
from a job or from a parent.

## 16.4 Provisional holidays and the confirmation cascade

Eid dates depend on moon sighting and are confirmed days before. Two Eids a
year, every year, every tenant — this is the normal path, not an edge case.

```mermaid
sequenceDiagram
    autonumber
    participant A as Admin
    participant C as calendar
    participant J as recompute job
    participant X as assessment / finance / attendance
    participant N as notification

    A->>C: confirm Eid-ul-Fitr = 20–24 Mar (was 19–23, provisional)
    C->>C: update holiday state + dates, effective-dated
    C->>J: enqueue recompute(range = 19–24 Mar)
    J->>J: re-resolve working_day for every campus/shift
    J->>X: 19 Mar is now WORKING; 24 Mar is now HOLIDAY
    X->>X: flag exams scheduled on 24 Mar (block severity)
    X->>X: reverse late-fee accrual for 24 Mar
    X->>X: reclassify attendance recorded on 24 Mar
    J->>N: notify staff of conflicts
    J->>C: write calendar_recompute.changes (reversible record)
```

The shift can move a day **into** the working set as well as out of it. A day
that becomes working has no attendance recorded — which is correct, and the
attendance summary must treat it as an unrecorded working day rather than
silently marking everyone absent.

## 16.5 Retroactive closures (FR-5.8)

A government closure announced at 09:00 for a day when attendance was taken at
08:30. The recompute path, all inside one auditable job:

| Step | Action | Reversible? |
|---|---|---|
| 1 | Re-resolve `working_day` for the affected dates | Yes |
| 2 | **Reclassify** existing attendance by writing new superseding rows with `reason = 'retroactive holiday'` | Yes — originals remain |
| 3 | Reverse late-fee accruals dated in the range | Yes — reversing entries |
| 4 | Flag exam schedules and timetable entries now on a non-working day, at `block` severity | n/a |
| 5 | Notify affected staff; guardians only if attendance visibility changed | n/a |
| 6 | Record the full change set in `calendar_recompute.changes` | This is what makes 1–3 undoable |

Step 2 is where most systems get it wrong by deleting or updating attendance
rows. Superseding rows preserve the fact that a teacher *did* take attendance
that morning — which matters if the closure is later rescinded.

## 16.6 Conflict rules

Named, severity-tagged, evaluated on publish and re-evaluated whenever the
calendar changes.

| Rule | Severity | Fires when |
|---|---|---|
| `EXAM_ON_HOLIDAY` | **block** | An `exam_schedule` falls on a non-working day |
| `EXAM_CLASH_SAME_CLASS` | **block** | Two exams for one class overlap in time |
| `INVIGILATOR_DOUBLE_BOOKED` | **block** | One staff member invigilates two rooms at once |
| `ROOM_DOUBLE_BOOKED` | **block** | Two exams in one room at once |
| `EVENT_OVERLAPS_EXAM` | warn | A school event overlaps an examination period |
| `HOLIDAY_OVERLAPS_MANDATORY_DATE` | warn | A holiday covers a result publication or admission deadline |
| `CLASS_ON_NON_WORKING_DAY` | warn | A timetable entry lands on a non-working day |
| `EXAM_OUTSIDE_TERM` | warn | An exam date falls outside its term bounds |

`block` prevents the transition. `warn` requires an explicit acknowledgement
that is recorded with the actor — so "we know, we meant it" is captured rather
than lost.

## 16.7 The government calendar

Platform-scoped, versioned per year. An operator maintains it; tenants import it.

| Operation | Behaviour |
|---|---|
| Publish version | Creates `government_holiday` rows at version *n* |
| Tenant import | Copies into `holiday` with `source_government_holiday_id` and level `school` |
| Re-import a new version | Diffs against previously imported rows; **never silently overwrites a tenant edit** — conflicts are presented for review |
| Tenant override | A tenant row that suppresses or replaces an imported row |

Never hardcoded in schema or logic, per FR-5.1. The seed is data shipped with
the platform, editable by an operator when the government changes something —
which happens with little notice.

## 16.8 Recurrence

Generated instances plus exception dates, exactly as the brief instructs. **No
RFC 5545 engine.**

```ts
interface Recurrence {
  kind: 'weekly' | 'monthly_nth_weekday' | 'annual_fixed_date';
  until: LocalDate;
  exceptions: LocalDate[];
}
```

That covers weekly assembly, monthly parent meetings and fixed national days —
which is the whole realistic requirement. Lunar-calendar holidays are **not**
modelled as recurrence; they are explicit provisional rows per year, because
their dates are not computable from a rule the platform should own.

Timezone is fixed to `Asia/Dhaka`. Holiday boundaries are stored as `DATE` with
optional time components, never as timestamps — a holiday is a calendar day, and
storing it as an instant introduces an offset bug that surfaces once a year.

## 16.9 Views and filters (FR-5.11)

| View | Primary user | Notes |
|---|---|---|
| Month grid | Everyone | Working/holiday/exam colour-coded; the default |
| Academic-year timeline | Principal, admin | Terms, exam windows, admission periods |
| Exam calendar | Exam controller, guardians | Subject-wise, filtered by class/section |
| Holiday list | Admin | Grouped by category; shows source level and provisional state |
| Event calendar | Everyone | Meetings, sports, orientation |

Filterable by campus, academic year, class, section, term, calendar type,
holiday type and examination. All views read `working_day` plus the holiday and
event rows — none of them re-implements resolution.

## 16.10 Performance and sizing

| Metric | Value |
|---|---|
| `working_day` rows | 100 schools × 2 campuses × 2 shifts × 365 ≈ **146k/year** |
| `isWorkingDay` | Single indexed lookup on the primary key |
| `workingDayCount` for a month | One `COUNT(*)` on the same index |
| Full-year rebuild, one campus/shift | Target < 2 s; alert above 30 s ([ADR-0013](../adr/0013-calendar-as-infrastructure.md) revisit trigger) |
| Cache | Hot ranges in the in-process LRU; invalidated by `CalendarRecomputed` |

Section-level rows are materialised **only** where a section override exists.
Materialising every section unconditionally would multiply the table by the
section count for no benefit — the overwhelming majority of sections inherit
their campus/shift calendar exactly.
