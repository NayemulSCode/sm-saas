# ADR-0010 — pg-boss for background jobs, so enqueue is transactional

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

Substantial asynchronous work: SMS fan-out, PDF batches, bulk imports, result
computation, calendar recomputation, scheduled fee generation, exports and
reconciliation. Correctness of money and results outranks throughput.

The specific hazard: a payment is recorded and an SMS job is enqueued. With the
queue in a different system, those are two writes that can diverge — a guardian
told about a payment that rolled back, or a payment with no notification.

## Options

### A. BullMQ on Redis
Mature, fast, good tooling. Requires Redis (a second stateful service to run and
back up). Enqueue is a separate system from the database, so the dual-write
problem is real and must be solved with a transactional outbox — which is
another table, another poller and more code. Per-tenant group fairness is a paid
feature.

### B. pg-boss on the existing PostgreSQL
Jobs are rows. `pg_boss.send()` inside the application transaction means the job
and the state change commit or roll back **together**. No outbox, no dual write.
No new service. Lower ceiling on throughput, and job churn adds write load and
vacuum pressure to the primary.

### C. A cloud queue (SQS or similar)
Managed, durable, and reintroduces the dual-write problem plus egress and
latency to another region.

## Decision

**B — pg-boss.**

The deciding reason is not operational simplicity, welcome as that is at 1–2
developers. It is that transactional enqueue removes an entire class of
correctness bug from the flows the brief ranks highest. There is no state in
which a receipt exists without its notification job, or a notification fires for
a receipt that never committed.

Per-tenant fairness, which BullMQ charges for, is implemented instead by
**chunking**: bulk work is split into ~200-item chunks that re-enqueue
themselves, with a per-tenant concurrency semaphore in Postgres. One school's
10,000-row import therefore yields between chunks and cannot starve another
school's attendance submission ([§7.4](../phase-1a/07-multi-tenancy.md)).

## Consequences

**Makes easy:** transactional enqueue; one backup covering jobs and data; jobs
inspectable with SQL; no extra service; scheduled jobs via pg-boss cron.

**Makes hard:** throughput ceiling — measured in low thousands per second at
best, well above the projected 20 messages/s but a real limit. Job churn adds
write and vacuum load to the primary, so the job tables need their own retention
policy. Tooling is thinner than BullMQ's dashboard.

**Forecloses:** nothing. Job handlers are ordinary use-case calls; swapping the
transport means changing the enqueue call site and the consumer bootstrap —
though the transactional guarantee would then need an outbox.

## Revisit when

- **[OQ-16](../phase-1a/13-open-questions.md)** — a 20,000-message fan-out fails
  to complete within its window on the target hardware.
- Job-table write load becomes a measurable share of primary database IO.
- Sustained enqueue rate exceeds ~500/s.

At that point the likely move is BullMQ for **high-volume, non-transactional**
work (SMS dispatch, PDF batches) while money and result flows stay on pg-boss —
a split, not a migration.
