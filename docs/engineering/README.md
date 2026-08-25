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

## Phase 2C — assessment, deliberately deferred

**Assessment (3d) is not specified here, on purpose.**

The roadmap says Phase 3d is *"built against the pilot schools' real grading
rules"*, and the pilot (Jun–Oct 2027) exists partly to **produce real assessment
configurations to use as fixtures**
([§45.3](../architecture/phase-1c/45-roadmap.md)). Writing final DDL for the
riskiest module fourteen months early, before the fixtures that would validate
it exist, is speculation dressed as progress — and every school's grading rules
differ, which is the whole reason it is a rules engine.

What already exists is enough to build against and does not need repeating:

| Already specified | Where |
|---|---|
| The rule vocabulary, evaluation pipeline, exam lifecycle | [§15, Phase 1B](../architecture/phase-1b/15-assessment-engine.md) |
| Entity sketch for schemes, components, marks, snapshots | [§11.8, Phase 1A](../architecture/phase-1a/11-entity-model.md) |
| The `ABSENT` constraint and mark states | [ADR-0012](../architecture/adr/0012-assessment-engine.md), [§1.3](phase-2a/01-conventions.md) |
| The marks grid interaction contract | [§12.3](phase-2b/12-component-inventory.md) |

**Write Phase 2C after the pilot**, with two or three real schemes in hand.

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
