# 22. Reporting — definitions and catalogue (Phase 3e)

Data path decided in [ADR-0021](../../architecture/adr/0021-reporting-data-path.md):
**primary → replica → rollups → warehouse**, each stage entered on a numeric
trigger, not an opinion. Phase 3e builds stage 1–2 and the report catalogue.

## 22.1 Report definitions are data

A report is a declared object, not a bespoke endpoint. The shape enforces three
properties that would otherwise depend on review.

```ts
export interface ReportDefinition<P extends ZodSchema> {
  code: string;
  module: ModuleName;
  titleKey: string;                              // localised at render
  /** Declared, so a report CANNOT exist without an access rule. */
  requiredPermission: Permission;
  params: P;                                     // validated, whitelisted
  /** Teacher-scoped reports are narrowed in SQL, never filtered in JS. */
  scopeAware: boolean;
  columns: Array<{
    key: string; labelKey: string;
    type: 'text' | 'money' | 'date' | 'number' | 'percent' | 'badge';
    align?: 'left' | 'right';
  }>;
  /** Parameterised. Raw interpolation is a lint error. */
  query: (p: z.infer<P>, ctx: AuthContext) => SQL;
  estimatedRows: (p: z.infer<P>) => number;
  class: 'interactive' | 'background';
  exports: Array<'xlsx' | 'pdf' | 'csv'>;
  cacheTtlSeconds?: number;
}
```

| Property | Enforced by |
|---|---|
| Every report has a permission | `requiredPermission` is required by the type |
| Scope is applied in SQL | `scopeFilter(ctx, …)` composed into `query` |
| RLS still applies underneath | The connection, not the report ([ADR-0003](../../architecture/adr/0003-tenancy-model.md)) |

Even a report with a bug returns only this tenant's rows. That is the point of
having two independent walls.

## 22.2 Execution

```
runReport(def, params, ctx):
  authorize(ctx, def.requiredPermission)
  p = def.params.parse(params)

  if def.class == 'background' or def.estimatedRows(p) > 5000:
      enqueue reports.generate  →  { jobId }        # and SAY SO
  else:
      withReadOnly(ctx, tx => tx.execute(def.query(p, ctx)))   # replica
```

| Class | Budget | Delivery |
|---|---|---|
| Interactive | ≤ 3 s | Rendered in the page, server component |
| Background | ≤ 5 min | Job → file in R2 → in-app notification |

A report crossing the threshold is **promoted to a job, not allowed to run and
time out**. A spinner that ends in an error after fifteen seconds is worse than
an honest "this will take a couple of minutes, we'll tell you when it's ready".

Reporting reads the **replica** via `DATABASE_URL_READONLY`
([§11.4](../phase-2a/11-scaffolding-lint-ci.md)) — the same replica already
justified by financial durability, so it costs nothing extra
([§4.5](../../architecture/phase-1a/04-non-functional-requirements.md)).

## 22.3 The catalogue

Ordered by what a principal actually asks for
([§2.2](../../architecture/phase-1a/02-domain-analysis.md)).

### Finance — ships with 3b

| Code | Report | Class | Permission |
|---|---|---|---|
| `fin.collection.daily` | Daily collection by collector, channel and head | interactive | `report.financial.read` |
| `fin.outstanding.aged` | **Outstanding dues, aged buckets** — the headline number | interactive | `report.financial.read` |
| `fin.defaulters` | Defaulter list by section; feeds SMS campaigns | interactive | `report.financial.read` |
| `fin.head.collection` | Head-wise collection, tuition vs exam vs transport | interactive | `report.financial.read` |
| `fin.discounts` | Discount and waiver register — who approved what, and why | interactive | `report.financial.read` |
| `fin.reconciliation` | Sessions with non-zero variance | interactive | `fee.reconcile` |
| `fin.reversals` | Refunds and reversing entries | interactive | `report.financial.read` |

### Attendance — 3c

| Code | Report | Class |
|---|---|---|
| `att.summary.monthly` | Per section, per month, with **`workingDayCount` as the denominator** | interactive |
| `att.student.detail` | One student, one range | interactive |
| `att.chronic` | Below a threshold over a window | interactive |
| `att.register` | Printable monthly register | background |

### Assessment — 3d

| Code | Report | Class |
|---|---|---|
| `exam.tabulation` | Per-section grid of every subject result | background |
| `exam.result.summary` | Pass statistics, grade distribution | background |
| `exam.subject.performance` | Per subject, per section | interactive |
| `exam.merit` | Position list for the configured scope | background |

### Directory and admissions — 3a/3e

| Code | Report | Class |
|---|---|---|
| `dir.roll` | Section roll with guardians | interactive |
| `dir.admission.funnel` | Applicant → admitted → active | interactive |
| `dir.status.changes` | Withdrawals and transfers over a period | interactive |
| `comm.sms.spend` | Segments, cost, delivery rate, estimate vs actual | interactive |

Every report exports to XLSX. Schools live in Excel, and a report they cannot
open in Excel is a report they do not use.

## 22.4 Export

| Format | Rule |
|---|---|
| **XLSX** | Default. **Typed cells** — money as a number with a currency format, dates as dates. Not strings |
| PDF | Through the document renderer ([§20](20-documents-and-report-cards.md)) |
| CSV | English headers, Latin digits — files get re-imported ([§16.7](../phase-2b/16-import-templates.md)) |

Money is `bigint` minor units everywhere internally; the XLSX writer divides by
100 **once**, at the cell boundary, with an explicit format string. That is the
only division in the reporting path.

Large exports stream rather than buffering, and land in R2 behind a signed,
expiring URL.

## 22.5 Caching

| Data | Strategy |
|---|---|
| Reference data — class levels, fee heads, grade scales | In-process LRU, invalidated on mutation |
| `working_day` ranges | LRU, invalidated by `CalendarRecomputed` |
| Published result pages | Immutable — cached hard, at the edge, behind signed URLs |
| Report results | Keyed `(code, params, tenant)`, short TTL, invalidated by the owning module's events |
| Dashboard tiles | 60 s TTL |

Invariant 15 holds throughout: every cache key carries `tenant_id`
(`cacheKey()` makes a key without one unconstructable), and **no cached value is
required for correctness**. A cold cache is a latency event.

A dashboard collection total that is 60 seconds stale is fine. One that costs a
full aggregate query per page view is not.

## 22.6 Rollups — stage 3, not built yet

Specified so the trigger is actionable when it fires.

```sql
CREATE TABLE report_rollup_daily_collection (
  tenant_id uuid NOT NULL, school_id uuid NOT NULL, business_date date NOT NULL,
  fee_head_id uuid, channel text,
  amount_minor bigint NOT NULL, payment_count integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, school_id, business_date, fee_head_id, channel)
);
```

Same shape for monthly attendance and exam aggregates. Rebuilt nightly,
idempotent by primary key, and the UI must say **"as of 02:00"** — staleness that
is not communicated is a bug report waiting to happen.

**Build when** report queries exceed 10% of primary CPU, or a single report
exceeds 60 s on the replica.

## 22.7 Platform analytics

Distinct from tenant reporting, deliberately minimal, and the churn signal is the
valuable part ([§21.5](21-saas-billing-and-console.md)).

**No third-party analytics SDK ships to guardian or teacher routes.** It would
cost bundle budget on exactly the devices that cannot afford it
([§4.4](../../architecture/phase-1a/04-non-functional-requirements.md)), and it
would send children's usage data to a third party.

## 22.8 Acceptance for Phase 3e

1. A class teacher running the attendance report sees **only their sections**,
   narrowed in SQL — verified by inspecting the generated query, not the output.
2. Every report in the catalogue declares a permission; a report without one
   fails to compile.
3. A report exceeding the row threshold is promoted to a job and the user is told.
4. Reporting queries hit the replica, not the primary.
5. XLSX money cells are numbers with a currency format, not strings.
6. Attendance percentages use `workingDayCount` as the denominator everywhere.
7. Cached dashboard tiles never affect correctness — clearing the cache changes
   latency only.
