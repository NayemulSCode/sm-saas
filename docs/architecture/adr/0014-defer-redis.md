# ADR-0014 — Defer Redis until a second application node exists

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

Redis appears in §5.29 of the brief as a scalability component. The brief also
says, correctly, not to introduce unnecessary infrastructure and to state the
**trigger metric** at which each component becomes necessary.

The four things Redis would do here, and what covers them on one node:

| Need | Without Redis |
|---|---|
| Session store | PostgreSQL. Sessions are read once per request, on an indexed primary key |
| Job queue | pg-boss, on PostgreSQL ([ADR-0010](0010-job-queue.md)) |
| Rate limiting | Cloudflare at the edge, plus an in-process counter |
| Cache | In-process LRU for reference data — class levels, fee heads, working days |

## Options

### A. Add Redis now
One command in Docker Compose. Costs: another stateful service to monitor, back
up and reason about; another failure mode; and cache-coherence bugs that only
appear when it is present.

### B. Defer, with a named trigger
Everything above works on one node. When a second node appears, in-process
caches stop being coherent and in-process rate limits stop being global — and
that is precisely the moment Redis earns its place.

## Decision

**B — defer.** The trigger is **the second application node**, not a guess about
load. It is a discrete, observable event.

The design stays Redis-ready at no cost:

- Cache access goes through a `Cache` interface in the shared kernel, with an
  in-process LRU implementation. The Redis adapter is a file, added later.
- Sessions are already a database table with a token hash; moving hot session
  reads to Redis later is a read-through cache, not a migration.
- Rate limiting goes through a `RateLimiter` interface for the same reason.
- **Nothing depends on in-process state for correctness.** Caches are advisory
  and every value has a source of truth in PostgreSQL. A cold cache is a
  performance event, never a wrong answer.

That last point is the one that makes deferral safe rather than merely cheap.

## Consequences

**Makes easy:** one less service to run, monitor and back up; simpler local
development; one less thing that can be stale.

**Makes hard:** scaling to a second node requires adding Redis *before* the
second node serves traffic, not after. This is recorded here so the sequencing
is not discovered during an incident.

**Forecloses:** nothing. The interfaces exist from day one.

## Revisit when

- **A second application node is planned** — add Redis first.
- Session lookup shows up as a measurable share of request latency.
- Rate limiting needs to be global across processes, which includes the worker
  if it ever serves traffic.
- pg-boss job churn becomes a database load concern
  ([ADR-0010](0010-job-queue.md) revisit conditions).
