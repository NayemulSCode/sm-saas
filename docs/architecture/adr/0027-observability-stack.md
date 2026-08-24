# ADR-0027 — Sentry plus self-hosted Prometheus/Grafana, tenant context on every signal, no tracing

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1C

## Context

**There is no on-call rotation.** One or two people run this during business
hours in Asia/Dhaka. Observability therefore has to serve three specific
purposes, not general curiosity:

1. Wake someone only when it genuinely cannot wait until morning.
2. Answer *"is this one tenant or the platform?"* in under a minute.
3. Leave enough evidence to diagnose a problem **after** it stopped.

## Options

### A. Logs only
Cheapest. No aggregate view; no way to see a trend approaching a trigger metric.

### B. Full observability SaaS (Datadog or similar)
Excellent, and priced per host and per GB. Against US$50/school ARPU it would
rival the entire infrastructure bill.

### C. Sentry (managed) + Prometheus/Grafana (self-hosted) + structured logs
Error tracking managed because it is the highest-value signal for a small team;
metrics self-hosted because they are cheap to run and expensive to buy.

### D. C plus OpenTelemetry distributed tracing
Complete. There is exactly one process boundary that matters here — app to worker
— and `request_id` propagation covers it at a fraction of the cost.

## Decision

**C.**

| Concern | Tool |
|---|---|
| Errors | **Sentry** — free tier, ~US$26/mo when volume requires |
| Metrics | Prometheus + Grafana, in Compose |
| Logs | Structured JSON to stdout → Loki or rotated files |
| Uptime | Cloudflare health checks + external prober |
| Database | `pg_stat_statements`, postgres_exporter |

Three rules matter more than the tool choices:

**1. Every log line, metric label and Sentry scope carries `tenant_id`.** This is
the single most useful decision in the section: "every tenant is erroring" and
"one school is erroring" are almost unrelated problems, and confusing them wastes
the first critical minutes of an incident.

**2. No PII in logs — ids only.** Never names, phones, marks or amounts. Logs are
the easiest place in the system to leak children's data, and the redaction is
asserted by a test.

**3. Page only for: it is down, money or results are wrong, or data is at risk.**
Everything else waits for morning — and the architecture is built so it can:
jobs retry, queues buffer, nothing is lost by a delayed response. An alert that
is not actionable at 02:00 trains people to ignore all alerts.

One deliberate tripwire: `rls_denied_total`. RLS returning zero rows is supposed
to be invisible, so a sustained rise means application code is querying without
proper tenant context — the bug class this architecture fears most.

## Consequences

**Makes easy:** isolating a tenant's problem in under a minute; a stack trace with
request context already attached; watching capacity trends approach the trigger
metrics in [§32.6](../phase-1c/32-scalability.md); a bill that stays near zero.

**Makes hard:** self-hosted monitoring is one more thing to run — mitigated by
treating it as non-critical, so its failure never pages anyone. Metric cardinality
needs care with `tenant_id` as a label at thousands of tenants: only a small set
of metrics carries it, and per-tenant detail comes from logs on demand.

**Forecloses:** nothing. OpenTelemetry can be added when there are services to
trace across.

## Revisit when

- Modules are extracted into services ([§6.6](../phase-1a/06-architecture-overview.md))
  — then tracing earns its cost.
- Metric cardinality becomes a Prometheus problem (roughly 1,000+ tenants).
- The team grows past two engineers, or an on-call rotation exists — the alert
  tiering assumes there is nobody to wake.
- Self-hosting the monitoring stack starts consuming host resources needed by the
  application.
