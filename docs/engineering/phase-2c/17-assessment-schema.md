# 17. Assessment — schema (Phase 3d)

The highest-risk module. Rules are **data**; the engine is a versioned pure
function ([ADR-0012](../../architecture/adr/0012-assessment-engine.md)).

> **Read [§17.9](#179-pilot-dependent--expect-to-revise) before building.** This
> module ships in Phase 3d (Aug–Nov 2027), *after* the pilot, and the roadmap
> says it is "built against the pilot schools' real grading rules". The
> structural parts below are stable; the rule vocabulary and seed data are the
> parts the pilot is expected to change, and they are isolated so that revising
> them is a migration rather than a redesign.

Conventions from [§3.1](../phase-2a/03-schema-platform-identity.md); `-- + std`
is the standard column set. All tables are `[T]`.

## 17.1 Grade scales

```sql
CREATE TABLE grade_scale (
  -- + std
  code    text NOT NULL,
  name_bn text NOT NULL, name_en text NOT NULL,
  kind    text NOT NULL
            CHECK (kind IN ('gpa','letter','pass_fail','descriptive')),
  UNIQUE (tenant_id, code)
);

CREATE TABLE grade_band (
  -- + std
  grade_scale_id uuid NOT NULL REFERENCES grade_scale(id) ON DELETE CASCADE,
  min_percent  numeric(5,2) NOT NULL CHECK (min_percent BETWEEN 0 AND 100),
  max_percent  numeric(5,2) NOT NULL CHECK (max_percent BETWEEN 0 AND 100),
  label_bn     text NOT NULL, label_en text NOT NULL,
  grade_point  numeric(4,2),                    -- NULL for pass_fail/descriptive
  is_failing   boolean NOT NULL DEFAULT false,
  sequence     integer NOT NULL,
  CHECK (max_percent >= min_percent),
  UNIQUE (tenant_id, grade_scale_id, sequence)
);
```

Bands must **tile [0,100] without gaps or overlap**. That is not expressible as a
row-level `CHECK`, so it is enforced by a deferred constraint trigger on
`grade_scale` plus a domain validator — a scale with a hole between 32.99% and
33% silently produces ungraded students.

## 17.2 Schemes and components

```sql
-- A named, VERSIONED bundle of rules. Editing a published scheme forks a
-- version; results always record the version they were computed under.
CREATE TABLE assessment_scheme (
  -- + std
  code             text NOT NULL,
  name_bn          text NOT NULL, name_en text NOT NULL,
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  class_level_id   uuid REFERENCES class_level(id),     -- NULL = all classes
  grade_scale_id   uuid NOT NULL REFERENCES grade_scale(id),
  version          integer NOT NULL DEFAULT 1,
  status           text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','published','archived')),
  -- Rule objects over a FIXED vocabulary (§18.2). Validated by Zod on write;
  -- the jsonb is a serialisation format, not an excuse for arbitrary shapes.
  aggregation_rule      jsonb NOT NULL,
  optional_subject_rule jsonb,
  ranking_rule          jsonb NOT NULL,
  promotion_rule        jsonb NOT NULL,
  UNIQUE (tenant_id, code, version)
);
-- A published scheme is immutable: enforced in the use case and by an
-- ON UPDATE trigger that rejects changes to rule columns when status='published'.

CREATE TABLE assessment_component (
  -- + std
  assessment_scheme_id uuid NOT NULL
                         REFERENCES assessment_scheme(id) ON DELETE CASCADE,
  subject_id       uuid NOT NULL REFERENCES subject(id),
  code             text NOT NULL,               -- 'CQ' | 'MCQ' | 'PRACTICAL' | …
  name_bn          text NOT NULL, name_en text NOT NULL,
  -- Marks are integer minor units too: 1 mark = 100. Gives exact 0.5 and 0.25
  -- grading for free and reuses one rounding implementation (§2.1).
  full_marks_minor bigint NOT NULL CHECK (full_marks_minor > 0),
  weight_percent   numeric(5,2) NOT NULL CHECK (weight_percent >= 0),
  -- The requirement most systems miss: a subject can require passing CQ AND
  -- MCQ separately, so 70 total is not a pass if CQ alone is below its mark.
  pass_mark_minor  bigint CHECK (pass_mark_minor IS NULL OR pass_mark_minor >= 0),
  is_required_to_pass boolean NOT NULL DEFAULT false,
  sequence         integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, assessment_scheme_id, subject_id, code),
  CHECK (pass_mark_minor IS NULL OR pass_mark_minor <= full_marks_minor),
  CHECK (NOT is_required_to_pass OR pass_mark_minor IS NOT NULL)
);
```

The last `CHECK` closes a real trap: a component flagged "required to pass" with
no pass mark would silently never fail anyone.

Component weights per (scheme, subject) must sum to 100. Same treatment as grade
bands — a deferred trigger plus a domain validator, because it spans rows.

## 17.3 Exams

```sql
CREATE TABLE exam (
  -- + std
  academic_year_id uuid NOT NULL REFERENCES academic_year(id),
  term_id          uuid REFERENCES term(id),
  class_level_id   uuid NOT NULL REFERENCES class_level(id),
  assessment_scheme_id uuid NOT NULL REFERENCES assessment_scheme(id),
  scheme_version   integer NOT NULL,            -- pinned at creation
  name_bn          text NOT NULL, name_en text NOT NULL,
  status           text NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned','scheduled','marks_open',
                                       'marks_locked','tabulated','published',
                                       'revised')),
  marks_locked_at  timestamptz, marks_locked_by uuid REFERENCES person(id),
  published_at     timestamptz, published_by   uuid REFERENCES person(id),
  UNIQUE (tenant_id, academic_year_id, class_level_id, name_en)
);
CREATE INDEX ON exam (tenant_id, academic_year_id, status);

CREATE TABLE exam_schedule (
  -- + std
  exam_id     uuid NOT NULL REFERENCES exam(id) ON DELETE CASCADE,
  subject_id  uuid NOT NULL REFERENCES subject(id),
  section_id  uuid REFERENCES section(id),      -- NULL = all sections
  date        date NOT NULL,
  start_time  time NOT NULL,
  end_time    time NOT NULL CHECK (end_time > start_time),
  duration_minutes integer,
  room        text,
  invigilator_staff_id uuid REFERENCES staff(id),
  UNIQUE (tenant_id, exam_id, subject_id, COALESCE(section_id,
          '00000000-0000-0000-0000-000000000000'::uuid))
);
CREATE INDEX ON exam_schedule (tenant_id, date);
CREATE INDEX ON exam_schedule (tenant_id, invigilator_staff_id, date);
```

`scheme_version` is pinned on the exam, not resolved at tabulation time. A scheme
edited between mark entry and publication must not silently change results.

## 17.4 Marks — the constraint that matters most

```sql
CREATE TABLE mark (
  -- + std
  exam_id       uuid NOT NULL REFERENCES exam(id),
  student_id    uuid NOT NULL REFERENCES student(id),
  subject_id    uuid NOT NULL REFERENCES subject(id),
  assessment_component_id uuid NOT NULL REFERENCES assessment_component(id),
  score_minor   bigint CHECK (score_minor IS NULL OR score_minor >= 0),
  state         text NOT NULL
                  CHECK (state IN ('entered','absent','exempt','incomplete')),
  entered_by    uuid REFERENCES person(id),
  entered_at    timestamptz,
  -- INVARIANT 4, made structural. An absent student cannot be REPRESENTED as a
  -- zero, so no code path can produce one.
  CHECK (
    (score_minor IS NOT NULL AND state = 'entered') OR
    (score_minor IS NULL     AND state IN ('absent','exempt','incomplete'))
  ),
  UNIQUE (tenant_id, exam_id, student_id, assessment_component_id)
);
CREATE INDEX ON mark (tenant_id, exam_id, subject_id, student_id);
CREATE INDEX ON mark (tenant_id, exam_id, state) WHERE state = 'incomplete';

-- Grace and moderation are ADJUSTMENT ROWS, never edits to score_minor, so a
-- tabulation sheet can show raw and adjusted side by side — which is what an
-- exam controller needs when a parent challenges a result.
CREATE TABLE mark_adjustment (
  -- + std
  mark_id      uuid NOT NULL REFERENCES mark(id),
  kind         text NOT NULL
                 CHECK (kind IN ('grace','moderation','recheck','correction')),
  delta_minor  bigint NOT NULL CHECK (delta_minor <> 0),
  reason       text NOT NULL,
  requested_by uuid REFERENCES person(id),
  approved_by  uuid REFERENCES person(id),
  approved_at  timestamptz,
  CHECK (kind = 'correction' OR approved_by IS NOT NULL)
);
CREATE INDEX ON mark_adjustment (tenant_id, mark_id);
```

The partial index on `state = 'incomplete'` exists because "are there any
incomplete marks left?" is the guard on locking, and it is asked constantly.

## 17.5 Competency assessment

Runs **parallel** to marks against the same exam, not instead of them (FR-7.1).
A school with descriptive KG reporting and marks in Class 5 uses both.

```sql
CREATE TABLE competency (
  -- + std
  curriculum_id  uuid REFERENCES curriculum(id),
  subject_id     uuid REFERENCES subject(id),   -- NULL = cross-subject
  class_level_id uuid REFERENCES class_level(id),
  code           text NOT NULL,
  statement_bn   text NOT NULL, statement_en text NOT NULL,
  sequence       integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, code)
);

CREATE TABLE competency_scale_level (
  -- + std
  grade_scale_id uuid NOT NULL REFERENCES grade_scale(id) ON DELETE CASCADE,
  label_bn text NOT NULL, label_en text NOT NULL,
  sequence integer NOT NULL,
  UNIQUE (tenant_id, grade_scale_id, sequence)
);

CREATE TABLE competency_assessment (
  -- + std
  exam_id       uuid NOT NULL REFERENCES exam(id),
  student_id    uuid NOT NULL REFERENCES student(id),
  competency_id uuid NOT NULL REFERENCES competency(id),
  level_id      uuid REFERENCES competency_scale_level(id),
  state         text NOT NULL DEFAULT 'entered'
                  CHECK (state IN ('entered','not_assessed')),
  remark        text,
  assessed_by   uuid REFERENCES person(id),
  assessed_at   timestamptz,
  UNIQUE (tenant_id, exam_id, student_id, competency_id),
  CHECK ((level_id IS NOT NULL AND state = 'entered') OR
         (level_id IS NULL     AND state = 'not_assessed'))
);
```

The same state/value discipline as `mark`: "not assessed" is a state, never the
lowest level.

## 17.6 Results — immutable, versioned

```sql
CREATE TABLE result_snapshot (
  -- + std
  exam_id        uuid NOT NULL REFERENCES exam(id),
  student_id     uuid NOT NULL REFERENCES student(id),
  enrolment_id   uuid NOT NULL REFERENCES enrolment(id),   -- section AT THE TIME
  scheme_version integer NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  -- Hash over (scheme rules + every input mark + adjustments). A recomputation
  -- that produces a different number becomes DETECTABLE, not silent.
  computation_hash bytea NOT NULL,
  total_minor    bigint NOT NULL,
  percent        numeric(5,2) NOT NULL,
  grade_label    text,
  grade_point    numeric(4,2),
  position_in_section integer,
  position_in_class   integer,
  is_passed      boolean NOT NULL,
  failed_subject_ids uuid[] NOT NULL DEFAULT '{}',
  -- The full per-subject breakdown AS COMPUTED. Duplicated on purpose: it is
  -- what the report card renders and what a dispute is settled against.
  payload        jsonb NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  superseded_by_id uuid REFERENCES result_snapshot(id),
  UNIQUE (tenant_id, exam_id, student_id, version)
);
CREATE INDEX ON result_snapshot (tenant_id, exam_id)
  WHERE superseded_by_id IS NULL;
CREATE INDEX ON result_snapshot (tenant_id, student_id, computed_at DESC);

-- Publication is a controlled, REVERSIBLE event with a per-audience window.
CREATE TABLE result_publication (
  -- + std
  exam_id      uuid NOT NULL REFERENCES exam(id),
  version      integer NOT NULL,
  audience     text NOT NULL
                 CHECK (audience IN ('guardian','student','staff')),
  visible_from timestamptz NOT NULL,
  visible_to   timestamptz,
  -- Gate publication on fee clearance, per tenant policy (FR-7.17 style).
  requires_fee_clearance boolean NOT NULL DEFAULT false,
  published_by  uuid NOT NULL REFERENCES person(id),
  revoked_at    timestamptz,
  revoke_reason text,
  UNIQUE (tenant_id, exam_id, version, audience),
  CHECK (revoked_at IS NULL OR revoke_reason IS NOT NULL)
);

CREATE TABLE promotion_decision (
  -- + std
  from_enrolment_id uuid NOT NULL REFERENCES enrolment(id),
  to_section_id     uuid REFERENCES section(id),
  academic_year_id  uuid NOT NULL REFERENCES academic_year(id),
  outcome  text NOT NULL
             CHECK (outcome IN ('promoted','retained','transferred','withdrawn')),
  basis    text NOT NULL CHECK (basis IN ('automatic','manual','override')),
  attendance_percent numeric(5,2),
  carried_forward_subject_ids uuid[] NOT NULL DEFAULT '{}',
  reason   text,
  decided_by uuid REFERENCES person(id),
  batch_id uuid,                                -- for undo (§14.5, Phase 1B)
  UNIQUE (tenant_id, from_enrolment_id),
  CHECK (basis <> 'override' OR reason IS NOT NULL)
);
```

`enrolment_id` on the snapshot rather than just `student_id` is deliberate: a
result belongs to the section the student was in **at the time**, so last year's
tabulation sheet stays correct after promotion.

## 17.7 Migration set

| # | Migration | Contents |
|---|---|---|
| `0020` | `grade_scales` | `grade_scale`, `grade_band`, tiling trigger |
| `0021` | `assessment_schemes` | `assessment_scheme`, `assessment_component`, weight-sum trigger, published-immutability trigger |
| `0022` | `exams` | `exam`, `exam_schedule` |
| `0023` | `marks` | `mark` (with the state `CHECK`), `mark_adjustment` |
| `0024` | `competency` | `competency`, `competency_scale_level`, `competency_assessment` |
| `0025` | `results` | `result_snapshot`, `result_publication`, `promotion_decision` |

Migration `0023` is the one to review carefully: its `CHECK` is invariant 4, and
it is the single most important constraint in the schema.

## 17.8 Events

| Event | Consumers |
|---|---|
| `MarksLocked` | documents (pre-render tabulation) |
| `ResultsTabulated` | reporting |
| `ResultsPublished` | notification (**staggered fan-out**), documents |
| `ResultRevised` | notification, documents (re-render) |
| `ResultPublicationRevoked` | notification |
| `StudentPromoted` | finance (carry arrears forward), directory |

## 17.9 Pilot-dependent — expect to revise

This module ships **after** the pilot, and the pilot exists partly to produce
real grading configurations as fixtures. The table below separates what is
structural from what is a guess.

| Element | Confidence | If the pilot disagrees |
|---|---|---|
| `mark.state` + its `CHECK` | **Settled.** Invariant 4 | Does not change |
| Immutable versioned `result_snapshot` | **Settled.** Invariant 5 | Does not change |
| Component model with independent `pass_mark_minor` | **High** — this is the documented Bangladeshi convention | Does not change |
| Publication as a reversible, audience-windowed event | **Settled** | Does not change |
| `computation_hash` over inputs | **Settled** | Does not change |
| **Aggregation rule vocabulary** | **Medium** | Extend the union + a migration. No structural change |
| **`optional_subject_rule` shape** | **Medium** — conventions vary and have changed | Most likely revision. Isolated to one jsonb column |
| **Ranking tie-break vocabulary** | **Medium** | Extend the union |
| **Promotion rule shape** | **Medium** | Extend the union |
| **Seeded grade scales** (GPA 5.0 bands, descriptive levels) | **Low — this is seed data, not schema** | Edit rows. Zero code impact |
| Report card layouts | **Low** | Per-school templates already ([§20](20-documents-and-report-cards.md)) |

The design goal was that **every "Medium" or "Low" row is a rule object or a
data row, never a table shape**. That is what makes the post-pilot revision a
migration and a Zod schema edit rather than a redesign — and it is the reason
the rules are jsonb over a fixed vocabulary instead of columns.

**Before building 3d:** collect two or three real schemes from pilot schools and
re-read [§18.2](18-assessment-engine.md). If any of them cannot be expressed,
extend the vocabulary *then* — do not add branching.
