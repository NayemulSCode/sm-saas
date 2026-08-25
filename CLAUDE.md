# CLAUDE.md — working context for this repository

Multi-tenant School Management SaaS for Bangladesh. Read this before doing
anything; it is the short version of decisions that are expensive to rediscover.

## Where you are

**Phase 1 complete. Phase 2A complete.** There is deliberately **no application
code** in this repository yet. Phase 1 produced the architecture, Phase 2 the
engineering specification, Phase 3 the implementation.

Do not scaffold an app, add a `package.json`, or write production code unless
the current task explicitly says Phase 3 has started.

| Need | Read |
|---|---|
| Every settled decision, in one page | [`docs/architecture/phase-1c/46-decision-summary.md`](docs/architecture/phase-1c/46-decision-summary.md) |
| The whole design | [`docs/architecture/README.md`](docs/architecture/README.md) |
| **What Phase 3a is built from** | [`docs/engineering/README.md`](docs/engineering/README.md) |
| Why something is the way it is | [`docs/architecture/adr/README.md`](docs/architecture/adr/README.md) |
| What is assumed rather than known | [`docs/architecture/phase-1a/13-open-questions.md`](docs/architecture/phase-1a/13-open-questions.md) |
| **Long-lead items nobody has started** | [`docs/EXTERNAL-ACTIONS.md`](docs/EXTERNAL-ACTIONS.md) — check at the start of every phase |
| The budget/team reality behind every trade-off | [`docs/architecture/CONSTRAINTS.md`](docs/architecture/CONSTRAINTS.md) |

When Phase 3a starts, the first commit is specified in
[`docs/engineering/phase-2a/11-scaffolding-lint-ci.md`](docs/engineering/phase-2a/11-scaffolding-lint-ci.md).
The isolation harness and migrations `0001`–`0002` come **before** the first
tenant table.

## The constraint that decides most arguments

**1–2 developers, no dedicated DevOps, ~US$50/month ARPU per school.**

Before proposing anything, ask whether two people can operate it at 02:00. That
single question has already ruled out microservices, Kubernetes,
schema-per-tenant, a separate analytics warehouse, and self-hosted object
storage. Do not reintroduce them without a trigger metric being hit.

**Never add infrastructure without naming the trigger metric** that made it
necessary. Every component in this design has one.

## Four non-negotiables

These outrank performance, elegance and convenience.

1. **Financial and examination correctness.** Money is `bigint` minor units
   (poisha) — never a float, never `numeric` at the language boundary. Receipt
   numbers are gapless per school per fiscal year. Nothing is hard-deleted;
   corrections are reversing entries.
2. **`ABSENT` is never zero.** `mark.state` is `entered | absent | exempt |
   incomplete`, and a `CHECK` constraint makes an absent-as-zero row
   unrepresentable. If you find yourself defaulting a missing mark to 0, stop.
3. **Cross-tenant isolation is structural.** Every tenant-owned table has RLS
   `ENABLED` *and* `FORCED` with a `USING` + `WITH CHECK` policy. The app role
   has no `BYPASSRLS`. A CI test enumerates `pg_class` and fails the build on any
   table that carries `tenant_id` without a policy.
4. **Every mutation is audited** — actor, tenant, timestamp, before/after,
   reason. No PII values in logs; ids only.

## Rules that will be enforced by lint in Phase 3

- `modules/*/domain/` imports **nothing** from `next/*`, Drizzle, or any SDK.
  Domain logic must be unit-testable with no database.
- `modules/*/index.ts` is a module's only importable surface. No reaching into
  another module's repositories or tables.
- All database access goes through `withTenant(ctx, fn)`. It opens the
  transaction and sets `app.tenant_ids`. There is no other path.
- Every use case calls `authorize(ctx, permission, target)`.
- Every index on a tenant-owned table leads with `tenant_id` (RLS adds
  `tenant_id = ANY(...)` to every plan).

## Domain vocabulary — use these words

`tenant` (unit of isolation and billing, normally one school) · `enrolment`
(student × section × academic year — the join all history hangs from; **roll
number lives here, not on the student**) · `section` (the unit a teacher owns) ·
`shift` (morning/day — a first-class entity, not an attribute) · `person`
(a human inside one tenant) · `account` (a login; spans tenants) ·
`working_day` (the single materialized answer to "is date D a working day for
section S?").

A phone number is **unique as a login identifier** and **non-unique as a contact
detail**. Those are different columns in different tables. Collapsing them
breaks siblings, shared handsets and separated parents.

## Bangla is a correctness concern, not a translation task

- Locale is **`bn`**, never `ba`. Languages: `en`, `bn` (`bn-BD`).
- Names are two columns, `name_bn` and `name_en` — both real, neither a
  translation of the other.
- Unicode **NFC normalisation on write**, or two visually identical names will
  not compare equal.
- Bangla SMS is UCS-2, ~70 chars per segment. Segment count and cost must be
  shown before send.
- PDFs need real OpenType shaping (conjuncts, ya-phala, reph). Headless Chromium
  with pinned Noto Bengali. `pdfmake`/`PDFKit`/`jsPDF` render Bangla visibly
  wrong — never suggest them.

## Git

- Branches: `feat/<topic>-phase-N`, `fix/`, `docs/`, `chore/`, `spike/`.
- Commits: one line, imperative, sentence case, **no `feat:`/`chore:` prefixes**.
  The trailing `(#N)` is added by GitHub's squash merge — don't write it.
- Squash merge only. `main` stays bisectable.
- Never commit `.env`, dumps, tenant data or keys. If a credential lands in
  history, rotating it is mandatory — deleting the file is not enough.
- **Changing a decision means writing a new ADR that supersedes the old one.**
  Never edit an accepted ADR's decision in place.

## Verify before you commit

```bash
bash ./scripts/check-docs.sh
```

Checks internal links, ADR index drift, missing revisit triggers, and
secret-shaped files. It runs in CI on every push and PR.

## Things that look like bugs but are not

- `tenant.shard_id` is `'primary'` for every row. Intentional — it is the
  indirection that lets one large tenant move to its own database later without
  touching call sites.
- `collected_at` and `recorded_at` on `payment` are separate columns. The office
  enters Saturday's cash on Monday.
- `is_billing_guardian` and `is_primary_contact` are separate flags. Separated
  parents: one may pay while the other is contacted.
- `result_snapshot` duplicates computed data. Published results are immutable;
  a revision writes a new version rather than editing the old one.
