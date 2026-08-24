# 42. Capacity and monthly cost model

Measured against [`CONSTRAINTS.md`](../CONSTRAINTS.md): infrastructure ceiling
**US$250/month for the first 100 schools**, ARPU **৳6,000 ≈ US$50** per school
per month, exchange rate **৳120 = US$1**.

> **All prices are indicative and marked [VERIFY].** Provider pricing, and the
> Singapore region surcharge in particular, must be confirmed before Phase 2
> closes. The *shape* of the model — which components appear at which tenant
> count — is the durable part.

## 42.1 Sizing inputs

Two of these come from measurement rather than estimate, which is unusual for a
Phase 1 cost model and is the reason to trust it:

| Input | Value | Source |
|---|---|---|
| Minimum host size | **8 GB** | **Measured** — [OQ-13](../spikes/oq-13-pdf-memory/README.md) |
| PDF renderer peak | **958 MB**, capped at 1.5 GB | **Measured** — OQ-13 |
| PDF throughput | **120 docs/min** | **Measured** — OQ-13 |
| Generated PDF size | **286 KB/doc** | **Measured** — OQ-13 |
| Students per school | 400 | ASSUMED |
| Attendance rows | ~88k/school/year | 400 × 220 working days |
| Mark rows | ~72k/school/year | 400 × 12 subjects × 5 components × 3 exams |
| DB growth | **~80–100 MB/school/year** incl. indexes | Estimated from the above |
| Object growth | **~600 MB/school/year** | Photos 40 MB + documents 120 MB + PDFs 430 MB |

At 100 schools that is roughly **10 GB of database and 60 GB of objects per
year** — small enough that the database fits comfortably in RAM for years, which
is the single biggest reason this architecture stays cheap.

## 42.2 Cost by tenant count

[VERIFY] all figures. Monthly, USD.

| Component | 10 | 50 | 100 | 250 | 500 |
|---|---|---|---|---|---|
| App host | 25 (8 GB) | 25 | 45 (16 GB) | 25 (8 GB) | 50 (2× 8 GB) |
| Database host | — | — | — | 45 (16 GB) | 90 (32 GB) |
| Replica | 12 (4 GB) | 12 | 22 (8 GB) | 22 | 45 (16 GB) |
| PDF render host | — | — | — | — | 25 |
| Redis | — | — | — | — | 8 |
| Load balancer | — | — | — | — | 6 |
| Staging | — | 8 | 8 | 8 | 8 |
| R2 storage + ops | <1 | 1 | 2 | 5 | 10 |
| Cloudflare | 0 | 0 | 0 | 0 | 0 (free tier) |
| Sentry | 0 (free) | 26 | 26 | 26 | 80 |
| Domain, misc | 2 | 2 | 2 | 3 | 5 |
| **Total** | **~$40** | **~$74** | **~$105** | **~$134** | **~$327** |
| Revenue @ $50 ARPU | $500 | $2,500 | $5,000 | $12,500 | $25,000 |
| **Infra as % of revenue** | **8.0%** | **3.0%** | **2.1%** | **1.1%** | **1.3%** |
| Per school per month | $4.00 | $1.48 | **$1.05** | $0.54 | $0.65 |

**At 100 schools: ~$105/month against a $250 ceiling.** The constraint is met
with roughly 2.4× headroom, and it matches the US$60–110 figure claimed in
[§1](../phase-1a/01-executive-summary.md).

Stage transitions follow the trigger metrics in
[§32.1](32-scalability.md) — the 250 and 500 columns are what those stages cost,
not a schedule.

## 42.3 What is not infrastructure

Deliberately excluded, because mixing them hides the number that matters:

| Cost | Treatment |
|---|---|
| **SMS** | **Pass-through, resold with margin.** A tenant's SMS spend is billed to that tenant against a credit balance ([§18.4](../phase-1b/18-notification-architecture.md)). It scales with usage and is revenue-positive, not a cost |
| Payment gateway fees | Per-transaction, borne per the school's arrangement |
| Salaries | The dominant real cost of this business by an order of magnitude |
| Support time | The actual constraint at 1–2 people — see below |
| Domain/legal/accounting | Business overhead |

## 42.4 The honest observation about cost

At 100 schools, infrastructure is **$105/month against $5,000 of revenue**. It is
2% of revenue and rounding error against a single salary.

**Infrastructure is not this business's cost problem. Onboarding capacity is.**

The seasonal analysis in [§2.3](../phase-1a/02-domain-analysis.md) says schools
switch in November–January or not at all. One person can onboard perhaps 3–5
schools a week during that window with hands-on data import. That is **15–20
schools per season, per person** — which caps growth far below anything
infrastructure would.

The architectural consequence, already reflected in the MVP cut: **import quality
and self-service onboarding are worth more than any infrastructure optimisation
in this document.** Every hour spent shaving $20/month off the hosting bill is an
hour not spent on the thing that actually limits the company
([§25](../phase-1b/25-data-import.md)).

## 42.5 Sensitivity

What breaks the model, and by how much.

| Scenario | Effect | Verdict |
|---|---|---|
| **ARPU is ৳2,000, not ৳6,000** ([OQ-2](../phase-1a/13-open-questions.md)) | At 100 schools: revenue $1,667, infra 6.3% | **Survivable.** Shared-schema tenancy is what makes this true; per-tenant databases would not survive it |
| ARPU is ৳20,000 | Infra 0.5% | Managed PostgreSQL becomes affordable; revisit [ADR-0002](../adr/0002-hosting-and-region.md) for the operational relief |
| **Data residency forces BD hosting** ([OQ-1](../phase-1a/13-open-questions.md)) | Compute 2–3×, self-hosted object storage, second onshore backup site. ~$250–320/mo at 100 schools | **The one scenario that threatens the ceiling.** At low ARPU it reaches 15–19% of revenue. Highest-impact open question in the document |
| Average school is 800 students, not 400 | Storage and DB double; hosts unchanged until a trigger | Negligible |
| Result-day traffic 5× the estimate | Absorbed by rate-shaped fan-out and edge caching ([§4.3](../phase-1a/04-non-functional-requirements.md)) | No cost change |
| Sentry outgrows the free tier early | +$26/mo | Negligible |
| A whale tenant needs its own shard | +$45/mo, billed to that tenant | Self-funding |

## 42.6 Cost controls that are already architectural

Not aspirations — decisions already taken elsewhere that keep this bill flat:

| Control | Where |
|---|---|
| Shared schema, near-zero per-tenant fixed cost | [ADR-0003](../adr/0003-tenancy-model.md) |
| **R2 zero egress** — egress is the spiky cost on result day | [ADR-0015](../adr/0015-object-storage.md) |
| No Redis until the second node | [ADR-0014](../adr/0014-defer-redis.md) |
| No warehouse until rollups hurt | [ADR-0021](../adr/0021-reporting-data-path.md) |
| No Kubernetes | [ADR-0002](../adr/0002-hosting-and-region.md) |
| Self-hosted Prometheus/Grafana rather than a per-GB SaaS | [§34.1](34-observability.md) |
| Report cards regenerate from snapshots, so storage is optional | [§29.5](29-file-media.md) |
| Cloudflare free tier for CDN, WAF and DNS | [§35.6](35-deployment.md) |
| Every component has a trigger metric | [§32.2](32-scalability.md) |

## 42.7 The one place to spend ahead of a trigger

The **$12–22/month streaming replica**, provisioned from day one rather than at a
capacity trigger.

It buys three things for one price: financial RPO of zero via per-transaction
`synchronous_commit` ([§36.2](36-backup-dr.md)), a fast restore source, and the
reporting read replica at [stage 2](32-scalability.md).

The brief is explicit that correctness of financial records outranks
cost-consciousness. At $12/month against $500 of revenue at ten schools, this is
not a real trade — and it is the only component in this document deliberately
bought before its trigger fires.
