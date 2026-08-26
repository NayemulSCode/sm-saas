# CLAUDE.md — working context for this repository

Multi-tenant School Management SaaS for Bangladesh. Read this before doing
anything; it is the short version of decisions that are expensive to rediscover.

## Where you are

**Phase 1 complete. Phase 2 complete (2A, 2B, 2C).** There is deliberately **no application
code** in this repository yet. Phase 1 produced the architecture, Phase 2 the
engineering specification, Phase 3 the implementation.

Build on the scaffold; do not re-scaffold. Before adding anything, run
`pnpm verify` (typecheck + lint + tests) and keep it green.

**Versions are governed by [ADR-0031](docs/architecture/adr/0031-dependency-version-policy.md)**,
not by the version numbers written in Phase 1 and Phase 2 prose. Pin exact
versions — no `^`, no `~`. TypeScript is deliberately held at 6.x; the reason is
in that ADR.

| Need | Read |
|---|---|
| Every settled decision, in one page | [`docs/architecture/phase-1c/46-decision-summary.md`](docs/architecture/phase-1c/46-decision-summary.md) |
| The whole design | [`docs/architecture/README.md`](docs/architecture/README.md) |
| **What Phase 3a is built from** | [`docs/engineering/README.md`](docs/engineering/README.md) |
| Why something is the way it is | [`docs/architecture/adr/README.md`](docs/architecture/adr/README.md) |
| What is assumed rather than known | [`docs/architecture/phase-1a/13-open-questions.md`](docs/architecture/phase-1a/13-open-questions.md) |
| **Long-lead items nobody has started** | [`docs/EXTERNAL-ACTIONS.md`](docs/EXTERNAL-ACTIONS.md) — check at the start of every phase |
| The budget/team reality behind every trade-off | [`docs/architecture/CONSTRAINTS.md`](docs/architecture/CONSTRAINTS.md) |

The scaffold follows
[`docs/engineering/phase-2a/11-scaffolding-lint-ci.md`](docs/engineering/phase-2a/11-scaffolding-lint-ci.md).
Migrations `0001`–`0002` and the isolation harness exist **before** the first
tenant table — migration `0005` (`person`) is the milestone the suite must be
green for.

## Guards that are already live

Each one has been verified by deliberately violating it, per §11.7:

| Guard | Breaks on |
|---|---|
| `boundaries/dependencies` | Any import crossing a layer the policy forbids |
| `no-restricted-imports` in `domain/**` | `domain/` importing Next, React, Drizzle, `pg`, an SDK or `db/**` |
| `no-restricted-imports` outside `db/**` | Importing `db/pool` instead of using `withTenant` |
| `no-restricted-syntax` | Arithmetic on `Money.minor` outside `shared/money.ts` |
| Isolation suite | A `tenant_id` table without RLS enabled, forced and a `WITH CHECK` policy |
| Isolation suite | `UPDATE` or `DELETE` on `audit_log` / `auth_event` — both are append-only |
| `audit()` | Recording a destructive action without a reason |
| Permission matrix | Adding a `Permission` without saying which roles hold it |

If a guard blocks you, the guard is usually right.

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

## Rules enforced by lint today

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
pnpm verify && bash ./scripts/check-docs.sh
```

`pnpm verify` runs typecheck, lint (including the architecture boundaries) and
the unit tests. `check-docs.sh` checks internal links, ADR index drift, missing
revisit triggers and secret-shaped files. Both run in CI on every push and PR.

The tenant isolation suite needs a real PostgreSQL and runs as its own CI step:

```bash
pnpm db:migrate && pnpm seed && pnpm test:isolation
```

`pnpm seed` writes the `permission` vocabulary and `role_template` rows from
`src/shared/permissions.ts`. It is not optional: `role_permission.permission_key`
has a foreign key to `permission(key)`, so on an unseeded database no permission
can be granted and every authorised endpoint answers 403.

A school is created by `pnpm provision` (`scripts/provision-tenant.ts`), which
copies `role_template` into the tenant. Never build a tenant by hand in a test
fixture if the use case can do it — hand-built tenants are how the missing
`permission` seed stayed invisible for four increments.

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
