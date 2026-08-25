# 20. Documents and report cards (Phase 3d)

Design in [§24, Phase 1B](../../architecture/phase-1b/24-documents-pdf-bangla.md);
engine confirmed by measurement in
[spike OQ-12](../../architecture/spikes/oq-12-bangla-shaping/README.md) and
[OQ-13](../../architecture/spikes/oq-13-pdf-memory/README.md). This is the
implementable contract.

To the buyer, these artefacts **are** the product.

## 20.1 Schema

```sql
CREATE TABLE document_template (
  -- + std   (platform defaults live in document_template_default and are
  --          copied at provisioning — same reasoning as role_template, §3.3)
  code       text NOT NULL,
  kind       text NOT NULL
               CHECK (kind IN ('report_card','marksheet','tabulation_sheet',
                               'admit_card','money_receipt','id_card',
                               'certificate','transfer_certificate')),
  name       text NOT NULL,
  engine     text NOT NULL DEFAULT 'html' CHECK (engine = 'html'),
  body_html  text NOT NULL,
  styles_css text NOT NULL DEFAULT '',
  page_size  text NOT NULL DEFAULT 'A4'
               CHECK (page_size IN ('A4','A5','Letter','receipt_80mm')),
  orientation text NOT NULL DEFAULT 'portrait'
               CHECK (orientation IN ('portrait','landscape')),
  version    integer NOT NULL DEFAULT 1,
  is_active  boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code, version)
);
CREATE UNIQUE INDEX ON document_template (tenant_id, kind, code)
  WHERE is_active AND deleted_at IS NULL;

CREATE TABLE document_render (
  -- + std
  template_id   uuid NOT NULL REFERENCES document_template(id),
  template_version integer NOT NULL,            -- a reprint reproduces the ORIGINAL
  kind          text NOT NULL,
  subject_type  text NOT NULL,                  -- 'student' | 'payment' | 'exam'
  subject_id    uuid NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  storage_key   text,
  page_count    integer,
  byte_size     bigint,
  status        text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','rendering','done','failed')),
  batch_id      uuid,
  rendered_at   timestamptz,
  rendered_by   uuid REFERENCES person(id),
  expires_at    timestamptz,                    -- NULL = retained indefinitely
  error         text
);
CREATE INDEX ON document_render (tenant_id, subject_type, subject_id);
CREATE INDEX ON document_render (tenant_id, batch_id);
CREATE INDEX ON document_render (tenant_id, status) WHERE status = 'queued';
```

`template_version` on the render is what makes a reprint two years later
reproduce the **original** layout rather than the current one.

## 20.2 The render contract

Rendering is **always a job**, never inline with a request. The worker restores
tenant context from the job payload and reads through the same use cases as the
app — so a document cannot contain data the requester was not entitled to see.

```ts
export interface RenderRequest {
  templateCode: string;
  kind: DocumentKind;
  subject: { type: 'student' | 'payment' | 'exam'; id: string };
  params: Record<string, unknown>;
  locale: 'en' | 'bn';
  numerals: 'bn' | 'latin';
  batchId?: string;
}

export interface Renderer {
  render(html: string, opts: PageOptions): Promise<{ pdf: Buffer; pages: number }>;
}
```

Operational settings, all fixed by OQ-13 rather than guessed:

| Setting | Value | Source |
|---|---|---|
| Container memory cap | `mem_limit: 1.5g` | Measured peak 958 MB + headroom |
| Page recycle interval | **Every 25 renders** | 40% lower peak, costs nothing |
| Chunk size | ~50 documents per job | |
| Throughput expectation | ~120 docs/min | Measured |
| Typical output size | ~286 KB/page | Measured — drives storage estimates |
| Fonts | Vendored `.ttf`, fontconfig with **no Bengali fallback** | OQ-12 |
| Line height | **≥ 1.5 body, ≥ 1.35 dense tables** | OQ-12 — 1.0 clips |

## 20.3 Template context types

The context is **explicit and typed per document kind**. Templates cannot reach
beyond it — same boundary discipline as CMS blocks
([ADR-0022](../../architecture/adr/0022-cms-public-projection.md)).

```ts
export interface ReportCardContext {
  school: { nameBn; nameEn; address; logoUrl?; eiin?; phone? };
  brand:  { primary: string; onPrimary: string };   // resolved + contrast-clamped
  student: { nameBn; nameEn; studentCode; rollNo?;
             className; sectionName; photoUrl?; dateOfBirth? };
  exam: { nameBn; nameEn; academicYear; termName? };

  subjects: Array<{
    nameBn; nameEn;
    components: Array<{
      name: string;
      /** 'AB' and 'EX' travel all the way to the template. A context typed
       *  `number` would destroy the distinction at the last step. */
      obtained: string | 'AB' | 'EX';
      full: string;
    }>;
    total: string;
    grade?: string;
    gradePoint?: string;
    passed: boolean;
    isFullyExempt: boolean;
  }>;

  summary: {
    totalMarks: string; percent: string; gpa?: string;
    grade?: string;
    positionInSection?: number; positionInClass?: number;
    result: 'PASS' | 'FAIL' | 'INCOMPLETE';
  };

  attendance: { present: number; workingDays: number; percent: string };
  competencies?: Array<{ statement: string; level: string }>;
  remarks?: { classTeacher?: string; principal?: string };

  meta: { publishedAt: string; snapshotVersion: number; numerals: 'bn'|'latin' };
}
```

Two properties this shape guarantees:

- **`obtained: string | 'AB' | 'EX'`** — invariant 4 survives into the final
  artefact. There is no numeric path an absent mark can take.
- **`meta.snapshotVersion`** printed on the document, so a parent holding a
  revised report card can see which version they have.

`MoneyReceiptContext` follows the same shape, adding
`amountInWordsBn` — required on receipts and produced by `Money.toWordsBn`
([§2.1](../phase-2a/02-shared-kernel.md)), which uses the Indic lakh/crore system
rather than a translation of an English words-generator.

## 20.4 Template authoring

| Rule | Reason |
|---|---|
| **Restricted template syntax over the typed context** — no arbitrary code | Templates are tenant-authored content |
| No network access at render time | A failed fetch at 23:00 during a batch produces boxes |
| No `<script>`, no external stylesheets, no remote images | Same reason as the CMS boundary |
| Brand tokens come from the resolved, contrast-clamped palette | [ADR-0023](../../architecture/adr/0023-branding-contrast-guard.md) |
| Documents always render **light theme** | A dark-mode report card wastes toner and looks broken |
| Per-school layout by editing a template row | FR-10.4, no code change |
| Page-break control: a subject block never splits across pages | `break-inside: avoid` |
| Repeating table headers on multi-page tabulation sheets | `thead { display: table-header-group }` |

The same HTML renders in the **browser print view**
([§20.10, Phase 1B](../../architecture/phase-1b/20-frontend-architecture.md)), so
what staff see and what downloads cannot diverge.

## 20.5 Batch generation

```
renderBatch(kind, subjectIds, templateCode):
  create batch_id
  chunk into ~50
  per chunk: enqueue documents.render, per-tenant concurrency capped
  on completion: optional merged PDF for printing
  progress reported per chunk; completed chunks are not re-rendered on retry
```

Target ≥ 500 report cards in ≤ 10 min; **measured at 4.1 min**
([§4.1](../../architecture/phase-1a/04-non-functional-requirements.md)). The
target is retained for headroom on weaker hardware.

## 20.6 Storage and retention

| Rule | Detail |
|---|---|
| Key layout | `tenant/<id>/documents/<kind>/<yyyy>/<renderId>.pdf` |
| Access | Private bucket, **authorization checked before signing** (invariant 13) |
| Signed URL lifetime | Minutes |
| Receipts | Retained for the tenant's full retention period; a reprint reproduces the original, **never with a new number** |
| Report cards | Retained; regenerable from the immutable snapshot, so storage is an optimisation rather than the system of record |
| Bulk exports | `expires_at` = 7 days |
| Offboarding | Included in the export bundle, then deleted per SLA |

## 20.7 The golden-image test, wired

The fixture is **already committed** at
[`docs/architecture/spikes/oq-12-bangla-shaping/fixture.html`](../../architecture/spikes/oq-12-bangla-shaping/fixture.html).
Phase 3d wires it into CI:

```
render fixture.html through the REAL PDF path on the Linux runner
  → rasterise page 1
  → compare against the committed reference with a small tolerance
  → FAIL the build on any shaping difference
```

Runs on every change to the renderer, the fonts, the templates or the container
image. A font bump, a Chromium bump or a CSS change that alters shaping fails the
build rather than reaching a parent.

The fixture pairs every case with a ZWNJ-forced control, so the diff is readable
by a human as well as by a pixel comparison.

## 20.8 API contracts

| Method | Path | Permission |
|---|---|---|
| `GET`/`POST` | `/api/v1/document-templates` | `scheme.manage` |
| `POST` | `/api/v1/document-templates/:id:preview` | `scheme.manage` — sample data, no persistence |
| `POST` | `/api/v1/documents:render` | Per kind — `result.read`, `fee.read`, … |
| `POST` | `/api/v1/documents:renderBatch` | **Idempotency-Key** |
| `GET` | `/api/v1/documents/:id` | Owner-scoped; returns a signed URL |
| `GET` | `/api/v1/documents/batches/:batchId` | Progress |

```ts
export const RenderBatchSchema = z.object({
  kind: z.enum(['report_card','marksheet','admit_card','tabulation_sheet']),
  templateCode: z.string(),
  scope: z.discriminatedUnion('by', [
    z.object({ by: z.literal('section'), sectionId: zUlid<'section'>(),
               examId: zUlid<'exam'>() }),
    z.object({ by: z.literal('students'), studentIds: z.array(zUlid<'student'>())
               .min(1).max(1000), examId: zUlid<'exam'>() }),
  ]),
  locale: z.enum(['en','bn']).default('bn'),
  numerals: z.enum(['bn','latin']).default('bn'),
  merge: z.boolean().default(false),
}).strict();
```

Admit cards accept `requireFeeClearance`, which filters the batch and reports who
was excluded and why — rather than silently producing fewer documents than
expected.

## 20.9 Acceptance for Phase 3d

1. The golden-image test fails the build when a font is swapped. **Verify by
   doing it once, on purpose.**
2. A report card renders with correct conjuncts, reph, ya-phala and matra
   reordering at print resolution on the Linux runner.
3. An absent subject prints **AB**, never 0.
4. Bangla numerals group as `১,২৩,৪৫৬` (lakh), not `১২৩,৪৫৬`.
5. A receipt prints amount-in-words in Bangla using lakh/crore.
6. 500 report cards render in ≤ 10 min within the 1.5 GB cap.
7. Two schools with different templates produce visibly different report cards
   from the same data, with no code change.
8. Line height ≥ 1.5 — no clipped reph or upper matras.
9. Reprinting a two-year-old receipt reproduces the original layout and number.
