# 4. Non-functional requirements

The brief's §6 says architecture without numbers cannot be evaluated. Agreed.
Every value below is a **proposal**, derived from the constraints and the domain
analysis, and every one is falsifiable. Values marked **ASSUMED** rest on an
assumption in [`CONSTRAINTS.md`](../CONSTRAINTS.md).

## 4.1 The §6 table, filled in

| Target | Value | Reasoning |
|---|---|---|
| p95 API latency, interactive endpoints | **300 ms server-side**; **800 ms end-to-end from Dhaka** | Server-side is what the team controls. The 500 ms gap is network from a Singapore region plus TLS and mobile radio |
| p99 API latency, interactive endpoints | 1,200 ms server-side | |
| p95 page load, low-end Android on 3G | **LCP ≤ 3.5 s**, TTI ≤ 5 s on a Moto-G-class device over a 400 kbps / 400 ms-RTT profile | The teacher takes attendance on this device at 08:30 |
| JS budget, guardian and teacher routes | **≤ 180 KB gzipped** on first load | Drives the UI library choice — [ADR-0008](../adr/0008-ui-library.md) |
| Concurrent users — steady state | **400** at 100 schools | ASSUMED: ~4 concurrent staff per school in office hours |
| Concurrent users — result publication peak | **3,000** for one large school; **10,000** platform-wide worst case | See §4.3 — and note that the platform *controls* this number |
| Availability — school hours (07:00–17:00 Asia/Dhaka, Sun–Thu) | **99.5%** (~2.5 h/year of school-hours downtime) | Honest for a single VPS with no HA |
| Availability — outside school hours | 99.0% | Maintenance windows live here |
| RPO — general | **≤ 60 s** | Continuous WAL archiving with `archive_timeout = 60s` |
| RPO — financial records | **0** | Per-transaction synchronous replication — see §4.5 |
| RTO | **≤ 4 hours** | Restore from base backup + WAL replay + DNS. Single-operator, business hours |
| Bulk import ceiling | 5,000 rows or 20 MB per batch | Larger files are split by the importer |
| Report generation — interactive | ≤ 3 s or it becomes a background job | |
| Report generation — background | ≤ 5 min for a school-wide annual report | |
| PDF batch generation | ≥ 500 report cards in ≤ 10 min | One section's marksheets in under a minute |
| SMS dispatch | ≥ 20 messages/s sustained, provider permitting | |
| Backup retention | Daily base 30 days; WAL 7 days PITR; monthly archive 12 months | |
| Restore drill cadence | **Quarterly**, on a real restore to a scratch host | An untested backup is not a backup |
| Data export SLA on offboarding | ≤ 72 hours | |
| Data deletion SLA after offboarding | ≤ 30 days, then purged from backups within 12 months | |

## 4.2 Availability, stated honestly

A single VPS with a single PostgreSQL instance **has no high availability**.
A host failure means a restore, and a restore means hours. 99.5% during school
hours is achievable with a careful deploy process and a fast restore path; 99.9%
is not, and claiming it in a contract would be dishonest.

This is the right trade at the assumed ARPU. A hot standby plus a load balancer
roughly triples infrastructure cost to remove roughly two hours of annual
downtime that occurs outside the fee-collection window more often than in it.

**Trigger to revisit:** the first tenant whose contract requires a
higher availability figure, or 250 tenants — whichever comes first. The upgrade
is a streaming replica plus a floating IP, and the architecture already assumes
the application is stateless, so it is a configuration change rather than a
rewrite.

## 4.3 The two seasonal spikes

### Admission season (November–January) — write-heavy

- Bulk imports of entire schools, thousands of rows each
- Document and photo uploads
- Fee structure setup and opening-dues entry
- Concentrated in the working day, Sun–Thu

Sustained write load rather than a spike. Mitigated by running imports as
chunked background jobs with a per-tenant concurrency cap, so one school's
10,000-row import cannot starve another school's attendance submission.

### Result publication day — read-heavy, and orders of magnitude above baseline

A school publishes results, sends 800 SMS, and every guardian opens the link
within the hour.

The critical insight: **the platform sends the SMS, so the platform controls the
arrival rate.** Result publication is not an uncontrolled thundering herd unless
it is designed as one.

Three mechanisms, in order of importance:

1. **Shape the fan-out.** Dispatch result SMS at a controlled rate over 30–90
   minutes rather than instantly. Guardians perceive no difference; peak
   concurrency falls by an order of magnitude.
2. **Serve immutable snapshots.** A published result is a frozen
   `result_snapshot` row. It is read-only, identical for every viewer of that
   student, and safe to cache aggressively — in the application, and at the CDN
   edge behind a per-student signed URL.
3. **Degrade the right thing.** If the platform is saturated, staff writes take
   priority over guardian reads. Guardians retry; a half-written mark entry is a
   correctness problem.

Without (1), 10,000 concurrent readers hitting a single VPS is a genuine outage
risk. With it, the peak is a few hundred requests per second of cacheable reads,
which the target hardware handles.

## 4.4 Performance budget for the low-end device

This is a functional requirement in disguise. If attendance does not work on the
teacher's phone, the product does not work.

| Budget | Value | Enforced by |
|---|---|---|
| First-load JS, guardian and teacher routes | ≤ 180 KB gzipped | CI bundle-size check, failing the build |
| First-load JS, staff admin routes | ≤ 350 KB gzipped | Same, separate budget |
| Bangla + Latin webfont payload | ≤ 120 KB total, subset, `font-display: swap` | Build-time subsetting |
| Images | AVIF/WebP, responsive, lazy below the fold | Next.js image pipeline |
| Attendance screen — usable offline | 100% of the flow | Service worker + local queue |
| Interaction to next paint | ≤ 200 ms on the target device | Virtualised tables, no synchronous layout on scroll |

**Design consequences:** table-heavy screens use a headless virtualiser rather
than a component-library data grid; the marks-entry grid is a purpose-built
component, not a spreadsheet library; and no chart library ships to guardian
routes.

## 4.5 Financial durability — how "zero data loss" is actually achieved

The brief says max acceptable data loss for financial records *should be zero —
state how*. Here is how, without paying for a hot standby on every write.

PostgreSQL's `synchronous_commit` is settable **per transaction**. So:

```
-- Ordinary transactions: fast, group-committed, RPO bounded by WAL archiving.
--   (default synchronous_commit = on — durable against process crash,
--    at risk only in a total host loss between archive intervals)

-- Money-moving transactions: wait for the standby to confirm.
BEGIN;
  SET LOCAL synchronous_commit = 'remote_write';
  -- issue receipt number, insert payment, allocate against dues
COMMIT;
```

A second small VPS running a streaming replica costs roughly **US$5–8/month**
and converts financial RPO from ~60 seconds to zero, while attendance and page
views pay none of the latency cost. The replica doubles as the restore source
and, later, as the read replica for reporting.

This is the one piece of "extra" infrastructure recommended before its trigger
metric, because the brief is explicit that financial correctness outranks cost —
and at US$8/month it is not a real trade.

Additional financial durability properties, none of which cost anything:

- Receipts are **append-only**; corrections are reversing entries
- Receipt numbers are issued inside the same transaction as the payment
- Every money mutation carries an idempotency key, so a retried request cannot
  double-post
- A printed receipt exists in the school's hands as an out-of-band record

## 4.6 Security and privacy targets

| Target | Value |
|---|---|
| Cross-tenant data leakage | **Zero tolerance.** Enforced by RLS, not by convention — [§7](07-multi-tenancy.md) |
| PII in logs | Prohibited. Logs carry ids and tenant context, never names, phones or marks |
| Credential storage | Argon2id. No reversible storage, ever |
| Data in transit | TLS 1.2+ everywhere, HSTS |
| Data at rest | Full-disk encryption on the host; object storage encrypted; **application-level encryption for national ID and bank account fields** |
| Session lifetime | Staff 12 h idle / 30 d absolute; guardians 30 d rolling |
| Audit retention | 24 months minimum for financial and examination events |
| Time to revoke a compromised session | ≤ 1 minute, platform-wide |

## 4.7 Maintainability targets

Unusual to put in an NFR table, but at this team size these are the constraints
that actually bind.

| Target | Value |
|---|---|
| Time for one developer to run the whole stack locally | ≤ 10 minutes from clone |
| Deploy to production | Single command or a single CI run; ≤ 10 minutes |
| Rollback to the previous release | ≤ 5 minutes, without a database restore |
| Database migrations | Backwards compatible for one release, so rollback never needs a down-migration |
| Test suite runtime | ≤ 10 minutes in CI, or it stops being run |
| Time to diagnose which tenant an incident affects | ≤ 1 minute — every log line carries `tenant_id` |
| New developer to first merged PR | ≤ 5 working days |

## 4.8 What is deliberately *not* an NFR

- **Sub-100 ms global latency.** Users are in Bangladesh. Optimising for anywhere
  else is spend without return.
- **Horizontal autoscaling.** The load is predictable and diurnal. Manual
  vertical scaling ahead of admission season is cheaper and simpler.
- **Multi-region.** Not until a data-residency ruling or a customer demands it.
- **Five-nines anything.** See §4.2.
