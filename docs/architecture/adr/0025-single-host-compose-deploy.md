# ADR-0025 — Docker Compose on one host, with a low-downtime rolling swap

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1C

## Context

[ADR-0002](0002-hosting-and-region.md) fixed a single VPS in Singapore with no
orchestrator. This decides how code actually reaches it, and what downtime is
honestly achievable. The test any answer must pass: **can one person diagnose and
fix this at 02:00, alone, from a laptop on hotel wifi?**

## Options

### A. Stop the stack, migrate, start
Trivial. Tens of seconds of downtime per deploy, during which an attendance
submission fails.

### B. Rolling app swap behind Caddy
Start a second `app` container on the new image, wait for `/readyz`, shift
traffic, drain and stop the old one. Seconds of overlap, no second host.

### C. Blue/green with duplicate stacks
Near-zero downtime. Doubles infrastructure cost for a benefit measured in seconds
at this traffic level.

## Decision

**B**, with the deploy sequence in [§35.3](../phase-1c/35-deployment.md):
CI builds one image, pushes it **by digest**, staging gets that digest, migrations
run, then the rolling swap.

**Low-downtime, not zero-downtime** — and the availability target says so out
loud: 99.5% in school hours ([§4.2](../phase-1a/04-non-functional-requirements.md)).
Genuine zero-downtime needs a second host and shared session state, which arrives
at [stage 2](../phase-1c/32-scalability.md) and is not worth its cost before then.

Supporting rules:

| Rule | Reason |
|---|---|
| **Every container has an explicit memory limit** | Chromium sizes caches to available memory and will starve PostgreSQL otherwise ([OQ-13](../spikes/oq-13-pdf-memory/README.md)) |
| Migrations are **backwards compatible for one release** | Rollback = deploy the previous tag. A destructive migration turns a 5-minute rollback into a multi-hour restore |
| Production runs a **tagged commit**, never a branch tip | The tag is the rollback target |
| Deploy window outside **07:00–15:00 Asia/Dhaka** | School hours are when attendance and fee collection happen |
| One image, deployed by digest to staging then production | Staging tests the artefact, not a rebuild of the same source |
| Staging holds **anonymised** production-shaped data | A migration that passes on an empty DB and fails on real data is the normal case |

## Consequences

**Makes easy:** deploying and rolling back in minutes; reasoning about one host;
running the whole stack locally with the same Compose files.

**Makes hard:** seconds of downtime per deploy; no automatic failover; manual
vertical scaling. All accepted and priced into the availability target.

**Forecloses:** nothing. The app is stateless, so a load balancer and a second
node is configuration.

## Revisit when

- A contractual uptime commitment requires better than 99.5% in school hours.
- A second application node exists — the swap becomes a genuine rolling deploy
  and Redis must be added first ([ADR-0014](0014-defer-redis.md)).
- Deploy frequency rises enough that seconds of downtime accumulate into a
  complaint.
