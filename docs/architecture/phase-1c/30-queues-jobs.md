# 30. Queue and background job architecture

pg-boss on the primary database ([ADR-0010](../adr/0010-job-queue.md)), consumed
by a worker process that shares the codebase and the domain modules with the web
app.

The property that decided the queue is worth restating: **a job is enqueued
inside the transaction that caused it.** There is no state in which a payment
exists without its notification job, or a job fires for a payment that rolled
back.

## 30.1 What must never run synchronously

| Work | Why |
|---|---|
| SMS and email dispatch | External latency, retries, rate limits |
| PDF generation | 0.5 s per document, 4 minutes for a batch ([OQ-13](../spikes/oq-13-pdf-memory/README.md)) |
| Report generation above the interactive threshold | [§26.2](../phase-1b/26-reporting-data-path.md) |
| Bulk import commit | Thousands of rows |
| Bulk promotion | Rewrites a cohort |
| Result computation and tabulation | CPU-bound over a whole class |
| **Calendar recomputation** | Cascades across attendance, fees and exams ([§16.5](../phase-1b/16-calendar-engine.md)) |
| Payment reconciliation and settlement matching | External calls, scheduled |
| Data export | Large, slow |
| Nightly meters and rollups | By definition |

## 30.2 Queues and priorities

Separate queues with separate worker concurrency, because the failure mode being
prevented is a bulk job delaying an interactive one.

| Queue | Concurrency | Contents | SLA |
|---|---|---|---|
| `critical` | 4 | OTP SMS, payment receipt SMS, password reset | Seconds |
| `default` | 4 | Domain events, small recomputes, single-document renders | < 1 min |
| `bulk` | 2 | Imports, batch PDF, exports, campaign fan-out | Minutes |
| `render` | **1** | PDF batches — one renderer per host ([§24.6](../phase-1b/24-documents-pdf-bangla.md)) | Minutes |
| `scheduled` | 2 | Nightly meters, rollups, late fees, reconciliation | Off-peak |

A login OTP must never queue behind a 20,000-message result fan-out. That is the
entire reason `critical` exists as a distinct queue rather than a priority field.

## 30.3 Per-tenant fairness

pg-boss has no group fairness, and BullMQ charges for it
([ADR-0010](../adr/0010-job-queue.md)). The pattern used instead:

```
1. Bulk work is ALWAYS chunked — never one long job.
   A 10,000-row import becomes 50 jobs of 200 rows, each re-enqueuing the next.

2. Each chunk acquires a per-tenant semaphore before running:
     SELECT pg_try_advisory_xact_lock(hashtext('tenant:' || $1 || ':bulk'))
   Failure to acquire = re-enqueue with a short delay, not a busy wait.

3. Concurrency cap per tenant per queue comes from the plan.
```

The result is that one school's 10,000-row import occupies at most its allotted
slots and **yields between chunks**, so another school's attendance submission is
never starved. About thirty lines of code for what the paid feature provides.

## 30.4 Retries, backoff and dead letters

| Property | Value |
|---|---|
| Retry limit | 5 for external-dependency jobs, 3 for internal |
| Backoff | Exponential with jitter — 10 s, 40 s, 3 min, 12 min, 45 min |
| Dead letter | After exhaustion, moved to a DLQ **table**, alerted, never silently dropped |
| DLQ handling | Operator console lists them with the error and a replay action |
| Idempotency | Every handler is idempotent; the job id is the natural key |
| Poison detection | A job failing identically across tenants raises a different alert than one failing for a single tenant |

That last distinction matters operationally: one tenant's job failing is a data
problem, and every tenant's job failing is a deployment problem. They need
different responses at 22:00.

## 30.5 Scheduled jobs

All times Asia/Dhaka.

| Job | Schedule | Notes |
|---|---|---|
| Late-fee accrual | 01:00 daily | Skips non-working days ([§17.5](../phase-1b/17-finance-architecture.md)) |
| Usage meters | 02:00 daily | Active students, SMS, storage — off the hot path |
| Reporting rollups | 02:30 daily | Stage 3 only ([ADR-0021](../adr/0021-reporting-data-path.md)) |
| Payment reconciliation | 03:00 daily | `queryStatus` for stale pendings, settlement matching |
| Calendar consistency sweep | 03:30 daily | Recompute a sample, alert on drift |
| Storage/orphan sweep | 04:00 weekly | [§29.7](29-file-media.md) |
| Backup verification | 04:30 daily | [§36](36-backup-dr.md) |
| Invoice generation | Per school, per billing period | Idempotent, re-runnable |
| Trial and dunning transitions | 06:00 daily | [§37](37-saas-billing.md) |
| Session and OTP purge | Hourly | The only hard deletes in the system |

Scheduled jobs run **once per platform**, not once per tenant, and fan out
internally — so adding the thousandth tenant does not add a thousand cron
entries.

## 30.6 Job observability

Every job record carries `tenant_id`, `request_id` (inherited from the request
that enqueued it) and `job_type`. That inheritance is what lets an operator trace
"the guardian says no SMS arrived" from the HTTP request through the payment to
the dispatch attempt.

| Signal | Alert |
|---|---|
| Queue depth by queue | `critical` > 100, or `bulk` > 5,000 |
| Oldest pending age | `critical` > 60 s, `default` > 10 min |
| Failure rate by job type | > 5% over 15 min |
| DLQ arrivals | Any, for money or result jobs. Otherwise > 10/hour |
| Worker heartbeat | Missing for 2 min |

## 30.7 Worker deployment

One worker process, one entrypoint, same image as the app
([§35](35-deployment.md)). The PDF renderer is a **separate container** because
Chromium's memory profile is unlike anything else and must be capped
independently ([OQ-13](../spikes/oq-13-pdf-memory/README.md)).

| Concern | Approach |
|---|---|
| Graceful shutdown | Stop accepting, finish in-flight, exit. `SIGTERM` handled |
| Deploy safety | Jobs are idempotent, so a killed job is retried, not lost |
| Long jobs across a deploy | Chunking means the longest job is ~200 rows |
| Statement timeout | 5 min on the worker pool vs 15 s interactive ([§10.10](../phase-1a/10-database-architecture.md)) |
| Scaling | Worker count is a Compose scale setting; the DB pool is sized for it |

Chunking pays for itself twice: once for tenant fairness, and once for deploy
safety. Neither was the original reason.
