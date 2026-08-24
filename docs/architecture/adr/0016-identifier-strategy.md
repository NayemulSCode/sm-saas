# ADR-0016 — ULID primary keys stored in `uuid` columns

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

Roughly a hundred tables, several of which grow continuously — `attendance`,
`mark`, `audit_log`, `notification_message`. Ids appear in URLs visible to
guardians and to anyone a link is forwarded to. The import module must build
large cross-referenced object graphs in a staging area **before** anything is
written to the database.

## Options

### A. `bigserial`
Smallest and fastest to index. Two problems: sequential ids in URLs disclose row
counts and growth rate — `/students/412` tells a competitor how many students a
school has — and ids must be assigned by the database, which the import staging
flow cannot accommodate.

### B. UUIDv4
Opaque and client-generatable. Random values scatter B-tree inserts across the
index, fragmenting pages and thrashing the buffer cache — worst on exactly the
high-volume tables listed above.

### C. ULID (or UUIDv7) stored as `uuid`
Time-ordered like a sequence, opaque like a UUID, generated in the application.
Stored as native `uuid` (16 bytes) rather than text (26+ bytes), rendered in
Crockford base32 only at the API boundary.

## Decision

**C.**

Three properties decide it, in order:

1. **Application-generated.** A full object graph — students, guardians,
   enrolments, opening dues — can be built and validated in the import staging
   area before a single row is committed. With `bigserial` this requires a
   placeholder-and-remap pass over every foreign key.
2. **Time-ordered inserts.** New rows land at the right edge of the index, which
   is what keeps `attendance` and `audit_log` writes cheap as they grow.
3. **No information leak.** Row counts, growth rates and neighbouring records
   are not inferable from a URL.

**Exception.** Append-only tables whose ids are never referenced externally —
`audit_log`, and event tables — may use `bigint` identity columns inside a
partitioned parent, where compactness beats opacity. Stated here so it is a
decision rather than an inconsistency.

## Consequences

**Makes easy:** import staging; safe URLs; offline clients generating ids for
queued attendance records (`attendance.client_ref` is a client-side ULID, which
is what makes replay idempotent); merging data from separate sources without
collision.

**Makes hard:** ids are 26 characters when displayed, so they are unusable as
anything a human reads aloud. Hence separate human-facing codes — `student_code`,
`employee_code`, `receipt_no` — which are per-school, meaningful, and the
identifiers actually used in conversation. Debugging is slightly worse than with
small integers.

**Forecloses:** nothing.

## Revisit when

- PostgreSQL's native `uuidv7()` is available in the deployed version — switch
  generation to the database default for rows created server-side, keeping ULID
  generation in the application where client-side ids are needed. Same storage
  type, no migration.
- An index-size analysis shows uuid keys are a material cost on a specific
  table — that table takes the `bigint` exception above.
