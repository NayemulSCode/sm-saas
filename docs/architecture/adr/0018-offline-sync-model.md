# ADR-0018 — Client-generated ULID outbox for offline capture

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1B

## Context

A teacher takes attendance at 08:30 on a low-end Android with no usable data
connection. The submission must not fail, must not duplicate when retried, and
must not silently vanish. Two teachers may mark the same section from different
devices. Device clocks drift.

## Options

### A. Retry the request until it succeeds
No local durability. Closing the tab loses the data, and retries with no
idempotency key create duplicates.

### B. Full local replication with CRDT merge
Robust and general. Enormous complexity for two flows, and the domain has no
genuine need for concurrent multi-writer merge semantics.

### C. Outbox of client-generated records, server-side idempotent upsert
The device generates a ULID per record before it has connectivity, writes to
IndexedDB immediately, and a sync engine drains the outbox in batches. The
server upserts on `client_ref`, which carries a unique index.

## Decision

**C.**

`attendance.client_ref` is the client-generated ULID and the idempotency key. A
replayed queue is safe because duplicates conflict on the unique index and are
acknowledged as already applied
([§11.6](../phase-1a/11-entity-model.md)).

Conflict rules, decided rather than left to chance:

| Situation | Resolution |
|---|---|
| Same `client_ref` replayed | Idempotent, no change |
| Two devices marked the same student/date | Last write by `capturedAt` wins; the loser is retained as a superseded row |
| Date became a holiday after capture | Accepted, then reclassified by the calendar recompute — never discarded |
| Marks or attendance locked before sync | **Rejected with a reason**, and the record stays visible to the teacher |

**Nothing is resolved by silently discarding data.** Every non-applied record
remains in the queue with a reason and an action. A sync engine that quietly
drops records is worse than one that fails loudly, because the teacher believes
the work is done.

The **business date comes from the server**, not the device clock, since a
wrongly-set phone must not file attendance under the wrong day. The device sends
`capturedAt` plus a monotonic sequence so ordering within one device is reliable
even when its clock is not.

## Consequences

**Makes easy:** instant UI response regardless of connectivity; safe retries;
a visible pending-sync count; queues that survive session expiry and re-login.

**Makes hard:** a second state machine on the client that must be kept in step
with server rules; conflict UI that has to be designed rather than hidden;
IndexedDB eviction to defend against.

**Forecloses:** offline fee collection. Gapless server-issued receipt numbers and
offline issuance are incompatible, and gaplessness is the property schools trust
([§17.4](../phase-1b/17-finance-architecture.md)). Refused deliberately.

## Revisit when

- A third flow needs offline capture — at that point generalise the outbox
  rather than copying it.
- Multi-device concurrent editing of the same section becomes common enough that
  last-write-wins produces real disputes.
- Browser storage limits on target devices prove insufficient
  ([OQ-18](../phase-1a/13-open-questions.md)).
