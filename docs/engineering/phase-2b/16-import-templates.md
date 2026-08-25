# 16. Import templates and validation rules (Phase 3b)

Import quality decides whether onboarding takes two days or three weeks — which,
at one person, decides how many schools can be onboarded per season
([§2.3](../../architecture/phase-1a/02-domain-analysis.md)). It is a **sales
requirement**, not a feature.

Three phases: stage → validate (dry run) → all-or-nothing commit
([ADR-0024](../../architecture/adr/0024-import-staging-model.md)).

## 16.1 Schema

```sql
CREATE TABLE import_batch (
  -- + std
  kind         text NOT NULL
                 CHECK (kind IN ('students','guardians','staff','fee_structure',
                                 'opening_dues','photos')),
  filename     text NOT NULL,
  storage_key  text NOT NULL,
  row_count    integer NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'uploaded'
                 CHECK (status IN ('uploaded','validating','validated',
                                   'committing','committed','failed',
                                   'rolled_back')),
  dry_run_report jsonb,
  committed_at timestamptz,
  actor_person_id uuid REFERENCES person(id),
  academic_year_id uuid REFERENCES academic_year(id)
);

CREATE TABLE import_row (
  -- + std
  import_batch_id uuid NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  row_no       integer NOT NULL,
  raw          jsonb NOT NULL,                  -- the original cells, verbatim
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','valid','invalid','committed',
                                   'skipped')),
  errors       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- per CELL, localised
  warnings     jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_type  text,
  target_id    uuid,                            -- what this row BECAME
  duplicate_of_id uuid REFERENCES person(id),
  duplicate_score numeric(4,3),
  UNIQUE (tenant_id, import_batch_id, row_no)
);
CREATE INDEX ON import_row (tenant_id, import_batch_id, status);

CREATE TABLE export_job (
  -- + std
  kind        text NOT NULL CHECK (kind IN ('tenant_full','entity','report')),
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by uuid REFERENCES person(id),
  status      text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','failed')),
  storage_key text,
  manifest    jsonb,
  expires_at  timestamptz,
  completed_at timestamptz
);
```

`import_row.target_id` is what makes a committed batch **undoable**: every
created entity links back to the row that made it.

## 16.2 Template definitions

Downloadable XLSX per kind, with a header row, an example row and sheet-level
data validation. Column keys are stable; header labels are bilingual.

### `students`

| Column | Required | Type | Notes |
|---|---|---|---|
| `student_code` | — | text | Generated if blank |
| `name_bn` | **yes** | text | NFC-normalised on write |
| `name_en` | **yes** | text | Both names are real, neither derived |
| `date_of_birth` | — | date | `YYYY-MM-DD`, Latin digits |
| `gender` | — | enum | `male`/`female`/`other`, or Bangla equivalents |
| `class` | **yes** | text | Matched to `class_level.name_en`/`name_bn` |
| `section` | **yes** | text | Matched within the class |
| `roll_no` | — | integer | Unique per section per year |
| `admitted_on` | — | date | |
| `birth_reg_no` | — | text | Decisive duplicate signal |
| `religion`, `blood_group`, `address` | — | text | |

### `guardians`

| Column | Required | Notes |
|---|---|---|
| `student_code` | **yes** | Links to the student |
| `relationship` | **yes** | `father`/`mother`/`guardian`/`emergency` |
| `name_bn`, `name_en` | **yes** | |
| `phone` | — | Normalised to E.164; **may repeat across rows** |
| `is_billing_guardian` | — | At most one per student |
| `is_primary_contact` | — | At most one per student |
| `can_receive_results` | — | Defaults true |

Several rows per student. **A repeated phone number is expected, not an error** —
it is how siblings and shared handsets appear
([ADR-0006](../../architecture/adr/0006-identity-model.md)).

### `opening_dues` — the one everyone forgets

| Column | Required | Notes |
|---|---|---|
| `student_code` | **yes** | |
| `fee_head` | **yes** | Matched to `fee_head.code` or name |
| `period_label` | **yes** | `2026-11`, `2026-T2` |
| `amount_outstanding` | **yes** | Major units in the sheet; converted to minor |
| `due_date` | — | Defaults to the period end |

**This is the entry that blocks go-live.** A school switching in December carries
arrears from the old system; without importing them, every fee report is wrong
from day one and the principal loses confidence in week one. Imported as
carry-forward invoices with `source = 'import'`, structurally identical to
system-generated arrears ([§13.2](13-finance-schema-and-contracts.md)).

### `staff` and `fee_structure`

Follow the same shape; `staff` keys on `employee_code`, `fee_structure` keys on
`(class, fee_head)` with `amount` and `due_day`.

## 16.3 Validation rules

Three tiers, reported **together** so the office manager fixes everything in one
pass rather than discovering problems serially.

| Tier | Blocks commit | Examples |
|---|---|---|
| **error** | **yes** | Missing required column; unparseable date (`৩১/০২/২০১৮`); non-numeric amount; unknown class or fee head; duplicate `student_code` within the file; roll collision within the file |
| **warning** | no — needs acknowledgement | Possible duplicate of an existing person; phone shared with an unrelated student; roll-number gaps; date of birth implying an unusual age for the class |
| **info** | no | A section will be created; N rows used a default |

```ts
export interface CellError {
  row: number;
  column: string;
  value: string;                    // the ORIGINAL cell, verbatim
  code: string;                     // stable
  messageKey: string;               // localised at render
}
```

Rendered as a **downloadable annotated copy of the original spreadsheet**, with a
comment on each bad cell — because the person fixing it works in Excel, not in
the app.

Parsing accepts what a Bangladeshi office actually types: Bangla or Latin digits,
`DD/MM/YYYY` and `YYYY-MM-DD`, phone numbers in any of the three common forms,
and `class` matched against either `name_bn` or `name_en`.

## 16.4 Duplicate detection

Runs during validation, against existing records **and within the file**.

| Signal | Weight |
|---|---|
| `birth_reg_no` exact | **decisive** |
| Normalised phone on a guardian link **and** exact date of birth | high |
| Exact DOB + trigram similarity on `name_bn` > 0.6 | high |
| Trigram on a transliteration-normalised Latin key | medium |
| Same section and academic year | medium |

```ts
// Folds the common variants before comparison.
normaliseForMatch('মোহাম্মদ শাহরিয়ার')  →  'mohammad shahriar'
//  মোহাম্মদ / মুহাম্মদ  ↔  Mohammad, Mohammed, Muhammad, Md., Mohd
//  আবদুল / আব্দুল       ↔  Abdul, Abdool
//  plus honorific stripping, whitespace collapse, NFC
```

It will not be perfect, which is exactly why the output is a **review queue with
a suggested action, never an automatic merge**. Merging two students merges their
dues, so it requires `fee.read` plus explicit confirmation
([§8.6](../../architecture/phase-1a/08-identity-authn-rbac.md)).

## 16.5 Commit

| Property | Mechanism |
|---|---|
| All-or-nothing per batch | One transaction |
| Idempotent | `Idempotency-Key` on the commit endpoint |
| Graph built before writing | ULIDs generated at staging, so student → guardians → enrolment → opening dues are cross-referenced before any write ([ADR-0016](../../architecture/adr/0016-identifier-strategy.md)) |
| Ceiling | 5,000 rows / 20 MB; larger files split into sibling batches under one parent |
| Fairness | Chunked and re-enqueued with a per-tenant concurrency cap, so an import cannot starve interactive work |
| Audit | `import_row.target_id` per row; `import_batch` records who, when, which file |

**Undo:** a committed batch can be reversed by soft-deleting what it created,
*provided nothing has been built on top of it*. The check for "has this been
used?" — a payment against an imported invoice, a mark against an imported
student — is part of the undo, and a blocked undo names the rows preventing it.

## 16.6 API contracts

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/v1/import/templates/:kind` | `import.run` — XLSX download |
| `POST` | `/api/v1/import/batches` | `import.run` — register an uploaded file |
| `POST` | `/api/v1/import/batches/:id:validate` | `import.run` — async dry run |
| `GET` | `/api/v1/import/batches/:id` | `import.run` — status + report |
| `GET` | `/api/v1/import/batches/:id/report.xlsx` | `import.run` — annotated copy |
| `POST` | `/api/v1/import/batches/:id:commit` | `import.run` · **Idempotency-Key** |
| `POST` | `/api/v1/import/batches/:id:undo` | `import.run` — reason required |
| `POST` | `/api/v1/export/jobs` | `export.run` |
| `GET` | `/api/v1/export/jobs/:id` | `export.run` — signed URL when done |

```ts
export const CommitImportSchema = z.object({
  acknowledgeWarnings: z.boolean().default(false),
  duplicateResolutions: z.array(z.object({
    rowNo: z.number().int(),
    action: z.enum(['create_new','link_existing','skip']),
    existingPersonId: zUlid<'person'>().optional(),
  })).default([]),
}).strict();
// 422 UNRESOLVED_WARNINGS if warnings exist and acknowledgeWarnings is false.
// 422 UNRESOLVED_DUPLICATES if any candidate lacks a resolution.
```

## 16.7 Export

The mirror of import, and **the same code path serves three purposes** — which is
why it is one mechanism rather than three:

| Purpose | Requirement |
|---|---|
| Tenant offboarding (FR-1.10) | Complete, open format, ≤ 72 h |
| Single-tenant restore ([§7.5](../../architecture/phase-1a/07-multi-tenancy.md)) | Same path, exercised continuously |
| Routine data export | Per-entity CSV |

Format: a ZIP of CSVs, one per entity, plus `manifest.json` with schema version,
row counts, timestamp and checksum. **CSV headers are English only** — files are
opened in Excel and often re-imported, and stable headers matter more than
localisation. Documents and photos are referenced in the manifest with a separate
signed bundle, so the export is not one multi-gigabyte file.

An export routine only exercised during offboarding is one nobody has tested when
it is actually needed. Sharing it with the restore path fixes that.

## 16.8 Acceptance for Phase 3b

1. A 2,000-student file with 43 deliberate errors validates in < 30 s and returns
   an annotated spreadsheet naming every bad cell.
2. Nothing is written until commit; deleting the batch leaves no trace.
3. Commit is atomic — an error on row 1,999 leaves zero rows written.
4. Opening dues import as carry-forward invoices that the outstanding report
   counts identically to system-generated arrears.
5. Two guardians sharing a phone import as **two persons, one credential**, not
   as a duplicate error.
6. `মোহাম্মদ করিম` and `Mohammad Karim` with the same DOB surface as a duplicate
   **candidate**, not an automatic merge.
7. Re-submitting the same commit request changes nothing.
8. Undo works when nothing depends on the batch, and explains itself when
   something does.
