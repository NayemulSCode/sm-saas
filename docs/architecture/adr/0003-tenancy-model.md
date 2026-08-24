# ADR-0003 — Shared schema with `tenant_id`, enforced by row-level security

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

Thousands of potential tenants, an ARPU around US$50/month, and 1–2 developers
with no DevOps. The brief asks not merely for a tenancy model but for the
**enforcement mechanism that makes cross-tenant leakage structurally
impossible**. Cross-tenant leakage in a system holding children's records is the
failure that ends the company.

Full comparison in [§7.1](../phase-1a/07-multi-tenancy.md).

## Options

### A. Shared database, shared schema, `tenant_id` column
One migration regardless of tenant count. One connection pool. Weakest
noisy-neighbour isolation. Per-tenant restore is the hardest of the three.

### B. Shared database, schema per tenant
Easy per-tenant dump. At 1,000 tenants × ~100 tables that is 100,000 tables:
catalogue bloat, degraded autovacuum and planning, and a migration fan-out that
needs a resumable orchestrator nobody has time to build.

### C. Database per tenant
Strongest isolation, trivial restore. Requires a connection pool per tenant,
which alone makes it impossible at this scale on one instance. Per-tenant fixed
cost is incompatible with the ARPU.

## Decision

**A**, with row-level security as the enforcement mechanism — not application
convention.

Every tenant-owned table gets `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, a
policy with both `USING` and `WITH CHECK`, and a `tenant_id` defaulted from the
transaction-local session variable. The application role holds **no `BYPASSRLS`**.
A CI test enumerates `pg_class` and fails the build if any table carrying
`tenant_id` lacks enabled-and-forced RLS with a policy.

The deciding reason: RLS converts "the developer remembered the `WHERE` clause"
into "the database returns zero rows". Isolation stops being a discipline
problem, which matters most precisely because the team is small and reviews are
thin.

## Consequences

**Makes easy:** migrations, backups, cross-tenant operator queries, near-zero
per-tenant fixed cost, and onboarding a tenant in seconds.

**Makes hard:** per-tenant point-in-time restore — hours, not minutes
([§7.5](../phase-1a/07-multi-tenancy.md)); noisy-neighbour isolation, addressed
with timeouts, per-tenant job concurrency caps and rate limits
([§7.4](../phase-1a/07-multi-tenancy.md)); and every index must lead with
`tenant_id`.

**Forecloses:** nothing permanently. `tenant.shard_id` exists from day one so a
single large tenant can be moved to its own database as an operational procedure
([§7.6](../phase-1a/07-multi-tenancy.md)).

## Revisit when

- A single tenant exceeds **~15% of total database size or IO** — move that
  tenant to its own shard rather than changing the model.
- A contractual or regulatory requirement demands physical isolation for a
  specific tenant — again, per tenant, not globally.
- **[OQ-15](../phase-1a/13-open-questions.md)**: if `= ANY(app.current_tenant_ids())`
  fails to use indexes at scale, fall back to a single-value `app.tenant_id` GUC
  and handle organization-level reads with one query per school.
