# 34. Observability architecture

The design constraint is unusual and worth stating first: **there is no on-call
rotation.** One or two people run this, during business hours, in Asia/Dhaka.

So observability is not optimised for a war room. It is optimised for:

1. Waking someone **only** when it genuinely cannot wait until morning.
2. Answering *"is this one tenant or the platform?"* in under a minute.
3. Leaving enough evidence that a problem can be diagnosed **after** it stopped.

## 34.1 The stack

| Concern | Tool | Cost |
|---|---|---|
| Error tracking | **Sentry** | Free tier initially; ~US$26/mo when volume requires |
| Metrics | **Prometheus + Grafana**, self-hosted in Compose | Host resources only |
| Logs | **Structured JSON to stdout** → Docker → Loki or files with rotation | Host resources |
| Uptime | **Cloudflare health checks** + an external prober | Free tier |
| Database | `pg_stat_statements`, `pg_stat_activity`, postgres_exporter | Free |
| Alerts | Grafana → email + a phone number for the critical set | Free |

Error tracking is the highest-value spend for a small team: it turns "a user says
it broke" into a stack trace with the request context already attached. Metrics
matter second. Distributed tracing is **not adopted** — there is one process
boundary that matters (app → worker) and `request_id` propagation covers it at a
fraction of the cost.

## 34.2 Every signal carries tenant context

Non-negotiable, and the single most useful decision in this section.

```jsonc
{
  "ts": "2026-08-24T09:14:22.881+06:00",
  "level": "error",
  "msg": "payment.record failed",
  "request_id": "01JB2K9X7T4QZC8M3N5P6R7S8T",
  "tenant_id": "01J9…",          // ALWAYS
  "tenant_slug": "dhaka-model",  // for humans
  "actor_person_id": "01J8…",    // never a name
  "module": "finance",
  "use_case": "recordPayment",
  "err_code": "RECEIPT_SEQUENCE_LOCKED",
  "duration_ms": 4211
}
```

| Rule | Reason |
|---|---|
| `tenant_id` on every log, metric label and Sentry scope | Isolates one tenant's problem from a platform symptom instantly |
| `request_id` generated at the edge, propagated into jobs | Traces "guardian got no SMS" from the HTTP request to the dispatch attempt |
| **No PII** — ids only, never names, phones, marks or amounts | Asserted by a redaction test; logs are the easiest place to leak ([§33.7](33-security.md)) |
| Money never logged as a value | The amount is in the database; the log says which payment |
| Tenant slug alongside the id | An operator should not have to look up a UUID under pressure |

Metric cardinality is a real risk with `tenant_id` as a label at thousands of
tenants. Mitigation: tenant-labelled metrics are limited to a small set (request
count, error count, job depth); everything else aggregates, and per-tenant detail
comes from logs on demand.

## 34.3 The metrics that matter

| Metric | Type | Labels | Watch for |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | route, method, status | p95 > 300 ms |
| `http_requests_total` | counter | route, status, tenant | 5xx rate > 1% |
| `db_query_duration_seconds` | histogram | module | p95 > 100 ms |
| `db_pool_in_use` | gauge | pool | Saturation |
| `job_queue_depth` | gauge | queue | `critical` > 100 |
| `job_oldest_pending_seconds` | gauge | queue | `critical` > 60 s |
| `job_failures_total` | counter | job_type | > 5% / 15 min |
| `sms_sent_total`, `sms_cost_minor_total` | counter | tenant, status | Spend anomalies |
| `pdf_render_duration_seconds` | histogram | template | p95 > 2 s |
| `pdf_renderer_memory_bytes` | gauge | — | > 1.2 GB → [§32](32-scalability.md) trigger |
| `tenant_active_students` | gauge | tenant | Billing and churn |
| `rls_denied_total` | counter | table | **Any sustained rise is a bug or an attack** |

The last row is a deliberate tripwire. RLS returning zero rows is *supposed* to
be invisible — a rising count means application code is querying without proper
tenant context, which is exactly the bug class the design fears most.

## 34.4 Health checks

| Endpoint | Checks | Used by |
|---|---|---|
| `/healthz` | Process alive | Container restart policy |
| `/readyz` | DB reachable, migrations current, pool healthy | Load balancer, deploy gate |
| `/healthz/deep` | DB write, R2 round-trip, queue responsive, renderer alive | Scheduled prober, operator console |

`/readyz` failing on a migration mismatch is deliberate: a container running code
that expects a schema it does not have must not take traffic
([§35](35-deployment.md)).

## 34.5 Alerts — and the rule for waking someone

Three tiers. The tiering is the point: with no rotation, an alert that is not
actionable at 02:00 trains people to ignore all alerts.

| Tier | Delivery | Criteria |
|---|---|---|
| **Page** (phone, any hour) | SMS/call | Site down > 5 min · DB unreachable · **payment or result data integrity error** · disk > 90% · security alert |
| **Notify** (email, business hours) | Email | Error rate > 1% · queue backing up · replica lag > 30 s · backup failed · SMS spend anomaly · cert expiring |
| **Digest** (daily) | Email | Slow queries, capacity trends approaching triggers ([§32.6](32-scalability.md)), DLQ summary |

**Page only for: it is down, money or results are wrong, or data is at risk.**
Everything else waits for morning — and the architecture is built so it *can*
wait: jobs retry, queues buffer, nothing is lost by a delayed response.

## 34.6 The first ten minutes of an incident

The brief asks for this explicitly. It is a runbook, not a philosophy.

```
 0–1 min  Is the site up?           /healthz/deep, Cloudflare status
          One tenant or all?        Grafana: error rate BY tenant label
                                    → one tenant  = data or config problem
                                    → all tenants = deploy, DB, or host

 1–3 min  What changed?             Last deploy time. Last migration.
                                    Roll back first, diagnose after — a tagged
                                    release is always the running version (§35)

 3–5 min  Where?                    Sentry: top error, grouped, with tenant scope
                                    Grab a request_id from the report

 5–8 min  Trace it                  Search logs by request_id — HTTP request
                                    through use case into any job it enqueued

 8–10 min Contain                   Feature flag off · suspend the integration ·
                                    revoke sessions · block at Cloudflare ·
                                    scale the box. THEN diagnose properly.
```

Step 1's tenant split is the highest-value question, which is why `tenant_id` is
on every signal. "Every tenant is erroring" and "one school is erroring" have
almost nothing in common as problems, and confusing them wastes the first
critical minutes.

## 34.7 Isolating one tenant's problem

| Capability | How |
|---|---|
| Error rate by tenant | Metric label |
| That tenant's recent activity | `audit_log` filtered by `tenant_id` |
| That tenant's jobs | `tenant_id` on every job record |
| That tenant's SMS | `notification_message` with delivery status |
| Reproduce as they see it | **Impersonation** — reason, time limit, audit, tenant-visible ([§38](38-support-console.md)) |
| Their config | Operator console: plan, flags, calendar state, academic year |

## 34.8 Retention

| Data | Retention | Why |
|---|---|---|
| Application logs | 14 days hot, 90 days cold | Diagnosis window |
| Metrics | 15 days at full resolution, 13 months downsampled | Year-over-year seasonal comparison |
| Sentry events | Per plan (~90 days) | |
| **`audit_log`** | **24 months minimum** | Financial and examination events; a business record, not telemetry |
| Job history | 30 days | |

`audit_log` is not observability data and is deliberately in a different
category: it lives in PostgreSQL, is backed up, and answers "who changed this
mark" years later.

## 34.9 What is deliberately absent

| Absent | Reason | Revisit when |
|---|---|---|
| Distributed tracing (OpenTelemetry) | One meaningful process boundary; `request_id` covers it | Services are split ([§6.6](../phase-1a/06-architecture-overview.md)) |
| APM / profiling in production | `pg_stat_statements` plus histograms cover the real cases | Sustained unexplained latency |
| Session replay | Sends children's screens to a third party | Never, for guardian and student routes |
| Log aggregation SaaS | Cost per GB against ARPU; self-hosted Loki is enough | Multi-host, or > 2 engineers |
| Synthetic user journeys | Real traffic covers it at this volume | Contractual uptime commitments |
