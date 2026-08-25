# ADR-0032 — Composite `(tenant_id, id)` foreign keys between tenant-owned tables

**Status:** Accepted
**Date:** 2026-08-25
**Deciders:** Phase 3a, migration 0009

## Context

[ADR-0003](0003-tenancy-model.md) makes row-level security the structural
guarantee of tenant isolation, and invariant 3 states that cross-tenant
isolation is *structural, not merely unlikely*.

RLS does not cover foreign keys. **PostgreSQL performs foreign-key checks with
the privileges of the referenced table's owner and does not apply row-level
security to them.** A single-column FK between two tenant-owned tables is
therefore satisfied by a row in *any* tenant.

This was not identified in Phase 1 or Phase 2. It surfaced while writing
migration 0008, where foreign keys between tenant tables first become dense.

**It was then proven rather than argued.** A test was added to the isolation
suite asserting that a cross-tenant FK is refused, and CI failed on it:

```
FAIL  refuses a foreign key pointing into another tenant
AssertionError: promise resolved "Result{ command: 'INSERT' }" instead of rejecting
```

Tenant A successfully created a `campus` row referencing tenant B's `school`.

### Severity

Lower than it first appears, and worth stating honestly:

- **Reads do not leak.** Any query joining to the referenced row is RLS-filtered
  and returns nothing.
- **The id must be known.** References are ULIDs, which are not guessable.

So this is an **integrity** hole, not a **disclosure** one. It matters because a
dangling cross-tenant reference is unresolvable, silently corrupts reports that
count rows, and cannot be cleaned up by a tenant-scoped process — and because
"structural" has to mean structural.

## Options

### A. Leave it; enforce in the application
Every use case would have to verify that each referenced id belongs to the
active tenant. That is the discipline RLS exists to replace, and it is exactly
the class of check that is forgotten under time pressure.

### B. Trigger-based validation
A `BEFORE INSERT/UPDATE` trigger per FK checking the parent's `tenant_id`.
Works, but adds a per-row function call on every write and puts the rule
somewhere nobody looks.

### C. Composite foreign keys carrying the tenant
```sql
UNIQUE (tenant_id, id)                     -- on the referenced table
FOREIGN KEY (tenant_id, child_col)         -- on the child
    REFERENCES parent (tenant_id, id)
```
The check now looks for `(tenant_id, id)` and cannot match another tenant's row,
because the child's own `tenant_id` is part of the lookup — and that column is
already pinned by the RLS `WITH CHECK` policy.

## Decision

**C**, applied in migration `0009` to every **domain** reference between
tenant-owned tables.

### Scope: domain references only

Audit and bookkeeping references — `created_by`, `updated_by`, `deleted_by`,
`verified_by`, `actor_person_id` — keep their simple foreign keys.

The line is drawn on **where the value originates**, not on convenience:

| Reference kind | Set from | Composite? |
|---|---|---|
| Domain (`section_id`, `student_id`, `school_id`) | **Request payload** | **Yes** |
| Audit (`created_by`, `updated_by`) | `ctx.personId`, derived from a verified membership in the active tenant | No |

A domain reference is exactly where a cross-tenant id could be injected by a
caller. An audit column cannot be set from input at all, and the blast radius of
a mis-set one is an unresolvable name rather than corrupted domain data.

### Implementation

Two helpers in `0009` rather than forty hand-written `ALTER` statements, because
forty hand-written statements is where one of them ends up wrong:

- `app.add_tenant_id_unique(table)` — adds `UNIQUE (tenant_id, id)`
- `app.tenantize_fk(child, column, parent, on_delete)` — finds the existing
  constraint in `pg_constraint` by *(child, parent, column)* rather than by
  name, drops it, and recreates it composite. Auto-generated constraint names
  are not stable enough to hard-code across a schema this size.

## Consequences

**Makes easy:** a cross-tenant reference becomes unrepresentable rather than
merely discouraged; no per-use-case validation to remember; no runtime cost
beyond an index lookup that already existed.

**Makes hard:** every referenced tenant-owned table now carries an extra unique
index on `(tenant_id, id)` — small, since `id` is already unique. Future tables
must remember composite FKs for domain references; there is **no automated guard
for this yet**, which is the main residual risk.

**Forecloses:** referencing a tenant-owned row from a platform-scoped table
using a plain FK. `session.active_membership_id → membership` stays simple
because `session` is global and has no `tenant_id` to compose with.

## Revisit when

- A catalogue test is added asserting "no single-column FK between two
  tenant-owned tables" — that closes the residual risk above and should be the
  next addition to the isolation suite.
- A tenant-owned table legitimately needs to reference another tenant's row.
  There is no such case today, and there should not be one.
