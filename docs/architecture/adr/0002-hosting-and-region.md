# ADR-0002 — Hetzner/DO VPS in Singapore, Docker Compose, no Kubernetes

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A — provider confirmed by the project owner

## Context

Hosting on a Hetzner or DigitalOcean VPS was confirmed as a constraint. The
*region* was not specified, and it has a larger effect on the user experience
than the provider does. Users are in Bangladesh; the team has no DevOps
function; the infrastructure ceiling is ~US$250/month at 100 schools.

## Options

### A. Hetzner EU (Falkenstein/Helsinki)
Cheapest hardware available. Approximately **140–190 ms RTT** from Dhaka. A CDN
does not help: the dominant traffic is authenticated, per-tenant, uncacheable
requests.

### B. Hetzner or DigitalOcean **Singapore**
Approximately **60–90 ms RTT** from Dhaka. Modest hardware premium over EU.
DigitalOcean additionally offers managed Postgres in-region if the team later
wants to stop operating the database.

### C. AWS ap-south-1 (Mumbai)
Best latency at ~45–70 ms, and the best managed-service catalogue. Roughly 3–5×
the cost for equivalent capacity — a meaningful fraction of ARPU.

### D. Bangladeshi datacentre
Lowest latency and the strongest data-residency position. Weakest managed
services, backup tooling and DR story.

## Decision

**B — Singapore**, orchestrated with **Docker Compose** on a single VPS, plus a
second small VPS running a streaming replica for financial durability
([§4.5](../phase-1a/04-non-functional-requirements.md)).

The deciding reason: an EU region imposes roughly **100 ms extra on every
interactive request**. An accountant entering sixty receipts and a teacher
marking forty students pay that repeatedly, all day. The hardware premium for
Singapore is far smaller than the productivity it buys.

**No Kubernetes.** A cluster is a full-time role, and there is nobody to fill it.
Docker Compose plus a systemd unit is debuggable at 02:00 by one person.

### Minimum host size: 8 GB

Set by measurement, not by guess. [Spike OQ-13](../spikes/oq-13-pdf-memory/README.md)
put the PDF renderer's peak at 958 MB, which fixes the budget:

| Component | Budget |
|---|---|
| PostgreSQL | 2.5–3.0 GB |
| Next.js app | 0.7 GB |
| Worker (non-PDF) | 0.3 GB |
| PDF renderer, hard-capped | 1.2 GB |
| OS + page cache | 1.5 GB |
| **Total** | **~6.2–6.7 GB of 8 GB** |

On a 4 GB box the PDF renderer must move to its own machine or be restricted to
off-peak batches. Every container gets an explicit memory limit — Chromium in
particular sizes its caches to available memory and will otherwise expand until
it starves PostgreSQL.

## Consequences

**Makes easy:** a predictable flat monthly bill; full control of PostgreSQL
configuration (needed for RLS roles and per-transaction `synchronous_commit`);
trivial local/production parity; one host to reason about.

**Makes hard:** no automatic failover — availability is honestly capped around
99.5% in school hours ([§4.2](../phase-1a/04-non-functional-requirements.md));
scaling is a manual resize; the team owns backups, patching and monitoring.

**Forecloses:** nothing. The application is stateless, so adding a load balancer
and a second node is configuration, not redesign.

## Revisit when

- **[OQ-1](../phase-1a/13-open-questions.md)** — a data-residency ruling
  requires onshore storage. Then option D, immediately.
- Measured RTT to Singapore exceeds ~120 ms (**[OQ-11](../phase-1a/13-open-questions.md)**
  must confirm the assumed figures).
- ARPU proves materially higher than assumed, making managed Postgres worth the
  operational relief at this team size.
- Tenant count passes ~250, or a single host's CPU stays above 60% during school
  hours — at which point split the database onto its own host first, then add an
  application node.
