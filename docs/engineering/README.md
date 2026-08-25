# Engineering specification — Phase 2

Phase 1 decided *what* is built and *why*
([`docs/architecture/`](../architecture/README.md)). Phase 2 turns that into an
implementation-ready specification: schema, contracts, signatures, conventions.

**Still no application code.** Schema DDL, interface signatures, DTOs, config and
pseudocode are the deliverable; a codebase is Phase 3.

## Scope

[§46.7](../architecture/phase-1c/46-decision-summary.md) lists ten things Phase 2
must produce. Phase 2A covers the eight that are within the team's control,
scoped to what **Phase 3a** needs — tenancy with RLS, identity, structure,
directory, and the deployment scaffolding
([roadmap §45.3](../architecture/phase-1c/45-roadmap.md)).

| §46.7 item | Where | Status |
|---|---|---|
| 1 · Drizzle schema + migrations, RLS per table | [§3](phase-2a/03-schema-platform-identity.md), [§4](phase-2a/04-schema-structure-directory.md), [§6](phase-2a/06-drizzle-patterns.md), [§7](phase-2a/07-migrations-and-seed.md) | Done for 3a |
| 2 · API contracts and Zod DTOs | [§10](phase-2a/10-api-contracts.md) | Done for 3a |
| 3 · Auth flow and session mechanics | [§8](phase-2a/08-auth-and-session.md) | Done |
| 4 · Permission vocabulary + role seed | [§9](phase-2a/09-permissions-and-roles.md) | Done — full vocabulary, all phases |
| 5 · Component inventory, three critical screens | [§12](phase-2b/12-component-inventory.md) | Done |
| 6 · Folder scaffolding with lint boundaries | [§11](phase-2a/11-scaffolding-lint-ci.md) | Specified |
| 7 · Compose, provisioning, CI workflows | [§11](phase-2a/11-scaffolding-lint-ci.md) | Specified |
| 8 · Generated RLS test harness | [§5](phase-2a/05-rls-and-isolation-harness.md) | Done — **before the first tenant table** |
| 9 · Seed data | [§7.3](phase-2a/07-migrations-and-seed.md) | Done |
| 10 · Answers to OQ-1, OQ-2, OQ-5, OQ-11 | — | **Not producible here.** Legal opinion, pricing conversations, a BTRC application and a latency measurement. Still open |

## Phase 2A — documents

| # | Document | Answers |
|---|---|---|
| 1 | [Conventions](phase-2a/01-conventions.md) | TS config, naming, the four boundary rules, use-case shape, definition of done |
| 2 | [Shared kernel](phase-2a/02-shared-kernel.md) | `Money`, `LocalDate`, branded ids, `Result`, `AuthContext` — final signatures |
| 3 | [Schema — platform and identity](phase-2a/03-schema-platform-identity.md) | DDL: tenant, plan, account, credential, session, membership, role, audit |
| 4 | [Schema — structure and directory](phase-2a/04-schema-structure-directory.md) | DDL: school, campus, shift, class, section, person, student, enrolment, guardian |
| 5 | [RLS and the isolation harness](phase-2a/05-rls-and-isolation-harness.md) | Roles, policy template, `withTenant`, the generated leakage suite |
| 6 | [Drizzle patterns](phase-2a/06-drizzle-patterns.md) | Custom types, repositories, keyset pagination, what must never appear |
| 7 | [Migrations and seed](phase-2a/07-migrations-and-seed.md) | The 3a migration set in order, provisioning, three seed tiers |
| 8 | [Auth and session](phase-2a/08-auth-and-session.md) | OTP and password flows, context resolution, session mechanics, threats |
| 9 | [Permissions and roles](phase-2a/09-permissions-and-roles.md) | The closed union, role templates, scope semantics, the matrix test |
| 10 | [API contracts](phase-2a/10-api-contracts.md) | Endpoint catalogue and Zod DTOs for 3a |
| 11 | [Scaffolding, lint, CI](phase-2a/11-scaffolding-lint-ci.md) | First-commit contents, boundary rules, env, compose, CI, definition of ready |

## Phase 2B — documents

Specifies the modules that ship in **3b and 3c**, plus the interaction contracts
for all three critical screens.

| # | Document | Answers |
|---|---|---|
| 12 | [Component inventory](phase-2b/12-component-inventory.md) | The shared pattern library, and interaction contracts for attendance capture, the marks grid and fee collection |
| 13 | [Finance — schema and contracts](phase-2b/13-finance-schema-and-contracts.md) | Fee definition, invoicing, gapless receipts, allocation, reconciliation, gateway events |
| 14 | [Calendar, academics and attendance](phase-2b/14-calendar-attendance.md) | `working_day`, holiday resolution, retroactive recompute, the offline attendance contract |
| 15 | [Notification and SMS](phase-2b/15-notification-and-sms.md) | Segment counting, deduplication, budgets, dispatch policy, provider interface |
| 16 | [Import templates](phase-2b/16-import-templates.md) | Template columns, three-tier validation, duplicate detection, commit and undo, export |

## Phase 2C — documents

Specifies **3d** (assessment, documents) and **3e** (SaaS billing, operator
console, reporting), completing the engineering specification.

| # | Document | Answers |
|---|---|---|
| 17 | [Assessment — schema](phase-2c/17-assessment-schema.md) | Grade scales, versioned schemes, components, exams, marks, results, promotion |
| 18 | [Assessment — the engine](phase-2c/18-assessment-engine.md) | The rule vocabulary and the four pure functions: evaluate, aggregate, rank, promote |
| 19 | [Assessment — lifecycle and API](phase-2c/19-assessment-api.md) | Exam state machine, mark entry contract, publication, revision, promotion |
| 20 | [Documents and report cards](phase-2c/20-documents-and-report-cards.md) | Template registry, typed render contexts, batch rendering, the golden-image test wired |
| 21 | [SaaS billing and the console](phase-2c/21-saas-billing-and-console.md) | Tenant lifecycle, metering, manual-first billing, operator console, impersonation |
| 22 | [Reporting](phase-2c/22-reporting.md) | Report definitions as data, the catalogue, export, caching, rollups |

### Written ahead of the pilot — what to re-check before building 3d

Phase 2C was written now at the project owner's direction. The recommendation had
been to wait, because the roadmap says 3d is *"built against the pilot schools'
real grading rules"* and the pilot exists partly to produce those configurations
as fixtures ([§45.3](../architecture/phase-1c/45-roadmap.md)).

The specification is structured so that absorbing the pilot's findings is a
migration and a Zod edit, not a redesign. **Every element expected to change is a
rule object or a data row, never a table shape.**

| Confidence | Elements |
|---|---|
| **Settled — will not change** | `mark.state` and its `CHECK` (invariant 4) · immutable versioned `result_snapshot` (invariant 5) · publication as a reversible, audience-windowed event · `computation_hash` · component model with independent pass marks |
| **Medium — extend the union, then migrate** | Aggregation rule vocabulary · `optional_subject_rule` shape (the most likely revision) · ranking tie-breaks · promotion rule shape |
| **Low — seed data, zero code impact** | GPA 5.0 bands, descriptive levels, report card layouts |

Full breakdown: [§17.9](phase-2c/17-assessment-schema.md). The one acceptance
criterion that genuinely cannot be met yet is **§19.7 item 11** — two real pilot
schemes reproducing their known-correct outputs. Write those fixtures the moment
the pilot supplies them.

## The one correction to Phase 1

[§3.3](phase-2a/03-schema-platform-identity.md): Phase 1's §11.2 sketch allowed
`role.tenant_id` to be `NULL` for platform template roles. That would punch a
hole in RLS — a `NULL` `tenant_id` matches no policy, so the row becomes
invisible to everyone, including the tenant that needs it. Template roles now
live in a separate `role_template` table and are **copied** at provisioning.

Recorded here rather than silently changed, per the ADR discipline in
[CONTRIBUTING](../../CONTRIBUTING.md). It refines a sketch rather than reversing
a decision, so it does not supersede an ADR.

## Reading it quickly

Building the first migration: [§5](phase-2a/05-rls-and-isolation-harness.md) then
[§7](phase-2a/07-migrations-and-seed.md).

Reviewing the model: [§3](phase-2a/03-schema-platform-identity.md) and
[§4](phase-2a/04-schema-structure-directory.md) — the constraint tables at the end
of §4 are the fastest way to see which domain rules are enforced by the database.

Disagreeing with something: [§1](phase-2a/01-conventions.md) carries the rules
that will feel restrictive first.
