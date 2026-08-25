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
| 5 · Component inventory, three critical screens | — | **Phase 2B** (those screens ship in 3b–3d) |
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

## Phase 2B — not started

- Component inventory for attendance capture, the marks grid and fee collection
- Schema and contracts for finance (3b), calendar and attendance (3c),
  assessment (3d)
- Notification templates and the SMS provider interface in implementable detail
- Import template definitions and the validation rule set

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
