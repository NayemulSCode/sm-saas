# 10. Database architecture

PostgreSQL 16+, single primary, one streaming replica. Tenancy enforcement is
specified in [§7](07-multi-tenancy.md); this section covers everything else that
must be decided before a single table is created, because these are the choices
that are expensive to reverse.

## 10.1 Conventions applied to every table

| Convention | Rule |
|---|---|
| Naming | `snake_case`, singular table names (`student`, not `students`) |
| Primary key | `id uuid` holding a **ULID** — see §10.2 |
| Tenant key | `tenant_id uuid NOT NULL DEFAULT app.current_tenant_id()` on every tenant-owned table |
| Timestamps | `created_at`, `updated_at` as `timestamptz`, defaulted and trigger-maintained |
| Actor | `created_by`, `updated_by` referencing `person(id)` |
| Soft delete | `deleted_at timestamptz`, `deleted_by`, `delete_reason` |
| Optimistic locking | `version integer NOT NULL DEFAULT 1` on entities edited concurrently |
| Money | `bigint` minor units + a `currency` column where more than BDT is possible |
| Dates | `date` for calendar days, `timestamptz` for instants. **Never `timestamp`** |
| Enums | PostgreSQL `text` + `CHECK`, not `enum` types — see §10.6 |
| Config | `jsonb` for genuinely open-ended tenant configuration, always with a validating `CHECK` or an application-side Zod schema |

### On soft delete

Every tenant-owned entity soft-deletes. Rationale is domain, not habit: a school
office deletes a student in December and needs them back in January, and a
deleted fee record must remain visible in last year's collection totals.

The cost is that every query must exclude deleted rows, and someone will forget.
Mitigation: repositories expose `find*` (excludes deleted) and
`findIncludingDeleted` (explicit). Views are **not** used for this — a view that
silently filters is worse than an explicit predicate, because it hides the rule.

Hard deletion happens in exactly two places: tenant offboarding after the
retention SLA, and the purge of expired OTP challenges and sessions.

## 10.2 Identifier strategy

**Decision: ULIDs stored in a `uuid` column.** Recorded as
[ADR-0016](../adr/0016-identifier-strategy.md).

| Option | Index behaviour | Leaks? | Verdict |
|---|---|---|---|
| `bigserial` | Best — sequential, compact | **Yes** — row counts, growth rate, and it is guessable in a URL | No |
| UUIDv4 | Poor — random inserts fragment the B-tree and thrash the buffer cache | No | No |
| **ULID / UUIDv7** | Time-ordered, so inserts stay at the right edge of the index | No | **Yes** |

The `uuid` column type is used rather than `text` because it is 16 bytes rather
than 26, indexes better, and every tool understands it. ULIDs render to their
Crockford-base32 form only at the API boundary.

Three properties that matter here specifically:

- **Ids are generated in the application**, so a full object graph can be built
  before any of it is written — necessary for import staging, where thousands of
  cross-referenced rows are validated before commit.
- **Ids do not leak business information.** `student/00000412` tells a competitor
  how many students a school has; a ULID does not.
- **Time-ordered inserts** matter most on `attendance`, `mark`, `audit_log` and
  `notification`, which are the highest-volume tables in the system.

Exception: high-volume append-only tables where the id is never referenced
externally (`audit_log`, `attendance_event`) may use `bigint` identity columns
inside a partitioned parent, since compactness matters more than opacity there.

## 10.3 Money

`bigint` minor units — **poisha**, where ৳1 = 100 poisha.

```sql
amount_minor  bigint NOT NULL,          -- 150000 = ৳1,500.00
currency      char(3) NOT NULL DEFAULT 'BDT'
```

| Rejected | Why |
|---|---|
| `double precision` / `real` | ৳0.1 + ৳0.2 ≠ ৳0.3. Disqualifying |
| `numeric(14,2)` | Exact and defensible. Rejected because it still arrives in JavaScript as a `number` or a string, and the first careless `Number()` reintroduces float error. `bigint` minor units force the conversion to be deliberate |
| `money` | Locale-dependent, fixed precision, universally advised against |

Rounding is explicit: division for sibling-discount splits uses banker's rounding
with the remainder assigned to the first allocation, so the parts always sum to
the whole. The rule lives in `Money`, is unit-tested, and is not reimplemented
per module.

## 10.4 Bangla text, collation and search

| Concern | Decision |
|---|---|
| Encoding | UTF-8 throughout. Non-negotiable |
| Collation | Database default `C.UTF-8` for predictable byte ordering; **ICU collation `bn-BD`** applied per column where human-visible alphabetical sorting is required (student and staff names) |
| Search | `pg_trgm` GIN indexes for fuzzy name lookup — works on Bangla text without a language-specific dictionary |
| Full text | `tsvector` with the `simple` configuration for notices and CMS content. There is no PostgreSQL stemmer for Bangla, and `simple` is honest about that |
| Normalisation | Unicode **NFC** on write. Bangla conjuncts have multiple valid encodings; without normalisation, two visually identical names do not compare equal |
| Duplicate detection | Trigram similarity on both the Bangla name and a transliteration-normalised Latin key — [§8.6](08-identity-authn-rbac.md) |

NFC normalisation on write is easy to overlook and expensive to retrofit: it
must be applied before any index is built, or the index encodes the
inconsistency.

Names are stored as **two columns**, `name_bn` and `name_en`, not one localised
blob. Both are needed simultaneously — the report card prints Bangla, the board
registration list needs English — and neither is a translation of the other.

## 10.5 Indexing under RLS

RLS silently adds `tenant_id = ANY (...)` to every plan. Two consequences:

1. **Every index on a tenant-owned table leads with `tenant_id`.** An index on
   `(section_id, date)` alone forces the planner to filter afterwards.
2. **Unique constraints are scoped by tenant.** A roll number is unique per
   section per year *within a tenant*:

```sql
CREATE UNIQUE INDEX ON enrolment (tenant_id, section_id, academic_year_id, roll_no)
  WHERE deleted_at IS NULL;
```

The partial predicate matters: without it, soft-deleting a student and
re-admitting them with the same roll number violates the constraint.

Baseline indexes established at design time rather than after the first slow
query:

| Table | Index |
|---|---|
| `student` | `(tenant_id, status)`, `(tenant_id, student_code)`, GIN trigram on `name_bn`, `name_en` |
| `enrolment` | `(tenant_id, section_id, academic_year_id)`, `(tenant_id, student_id, academic_year_id)` |
| `attendance` | `(tenant_id, section_id, date)`, `(tenant_id, student_id, date)` |
| `mark` | `(tenant_id, exam_id, subject_id, student_id)` unique |
| `invoice` | `(tenant_id, student_id, status)`, `(tenant_id, due_date) WHERE status <> 'paid'` |
| `payment` | `(tenant_id, receipt_no)` unique, `(tenant_id, collected_at)` |
| `working_day` | `(tenant_id, campus_id, shift_id, date)` unique — the hottest lookup in the system |
| `audit_log` | `(tenant_id, entity_type, entity_id, at DESC)` |

## 10.6 Enums as text with a check constraint

PostgreSQL `enum` types cannot have a value removed and, before PG12, could not
add one inside a transaction. Status vocabularies here change — student
lifecycle, tenant lifecycle, attendance statuses, payment channels — and some
are tenant-extensible.

```sql
status text NOT NULL
  CHECK (status IN ('applicant','admitted','active','on_leave',
                    'withdrawn','alumni'))
```

Adding a value is a one-line migration. Where a tenant may define its own values
(attendance statuses, fee heads, holiday categories), the vocabulary becomes a
table with a `tenant_id` and seeded defaults, not a check constraint.

## 10.7 Partitioning

Not applied on day one. Partitioning a small table adds planning overhead and
operational surface for no gain. The candidates, with their triggers:

| Table | Strategy | Trigger to partition |
|---|---|---|
| `attendance` | Range by `date`, monthly | > 50 M rows, or when a monthly detach is wanted for archival |
| `audit_log` | Range by `at`, monthly | > 100 M rows, or when retention pruning starts costing IO |
| `notification_message` | Range by `created_at`, monthly | > 50 M rows |
| `mark` | Not partitioned | Bounded by students × subjects × exams; stays modest |

Sizing sanity check: 100 schools × 400 students × 220 school days ≈ **8.8 M
attendance rows per year**. Partitioning is years away. The design cost today is
only that these tables avoid features incompatible with later partitioning —
notably, no unique constraint that does not include the partition key.

Drizzle's SQL migrations make this straightforward, which is part of why it was
chosen over Prisma ([ADR-0005](../adr/0005-orm.md)).

## 10.8 Archival of graduated cohorts

A school produces a permanently growing archive of alumni whose records are
almost never read but must never be lost — a transfer certificate may be
requested a decade later.

| Stage | Where | Access |
|---|---|---|
| Current academic year | Primary tables | Normal |
| Previous 2–3 years | Primary tables | Normal, slightly colder |
| Older cohorts | Same tables, `archived_at` set; partitions detached once partitioning exists | Read-only, through an explicit "historical records" path |
| Beyond retention | Exported to a signed JSON+CSV bundle in R2, rows removed | Restored on request by an operator |

Deliberately conservative: nothing is deleted automatically, ever. Storage is
cheap; a lost transcript is a lawsuit.

## 10.9 Migrations

| Rule | Reasoning |
|---|---|
| Forward-only, sequentially numbered SQL | Down-migrations are written under stress and rarely tested. Rollback is achieved by deploying the previous application version, which is why the next rule exists |
| **Backwards compatible for one release** | Add a column, deploy, backfill, deploy the code that uses it, drop the old one in a later release. Never in one step |
| No long-held `ACCESS EXCLUSIVE` locks | `lock_timeout` set on the migration session; a blocked migration fails fast instead of freezing the school day |
| Indexes built `CONCURRENTLY` on populated tables | Avoids blocking writes |
| Run by `sm_migrator`, never the app role | Separation from [§7.2](07-multi-tenancy.md) |
| Every migration adding a `tenant_id` table must add RLS in the same file | Verified by the catalogue test — an unprotected table fails CI |
| Tested against a restored production-shaped dump before release | Migrations that pass on an empty database and fail on real data are the norm, not the exception |

## 10.10 Connection pooling

| Setting | Value | Note |
|---|---|---|
| Pool per process | 10–20 connections | Single app node; sized well under `max_connections` |
| `max_connections` | 100–200 | Modest, matching available RAM |
| PgBouncer | **Not yet** | Trigger: a second app node, or pool saturation under load |
| Transaction mode compatibility | Preserved from day one | `set_config(..., true)` is transaction-scoped, so adding PgBouncer later needs no code change |
| Operator pool | Separate, small, `sm_platform` | Cannot be reached from tenant request paths |
| Worker pool | Separate, with a longer `statement_timeout` | A five-minute report must not need the interactive limit |

## 10.11 Constraints live in the database

Application-only validation is a suggestion. Anything that must always be true is
a database constraint, so that a bug, a bad import or a manual `psql` session
cannot violate it:

```sql
-- A payment can never be negative; refunds are separate reversing rows.
CHECK (amount_minor > 0)

-- An academic year cannot end before it starts.
CHECK (end_date > start_date)

-- Exactly one current academic year per school.
CREATE UNIQUE INDEX ON academic_year (tenant_id, school_id)
  WHERE is_current AND deleted_at IS NULL;

-- One attendance record per student per date per period.
CREATE UNIQUE INDEX ON attendance (tenant_id, student_id, date, period_no)
  WHERE deleted_at IS NULL;

-- A mark row must carry either a score or a non-scored state, never both,
-- and never neither. This is the constraint that stops ABSENT becoming 0.
CHECK (
  (score_minor IS NOT NULL AND state = 'entered') OR
  (score_minor IS NULL     AND state IN ('absent','exempt','incomplete'))
)
```

The last one is the single most important `CHECK` in the schema. FR-7.5 requires
that absent never silently becomes zero, and this makes it impossible to
represent an absent student *as* a zero — the illegal state cannot be written at
all.
