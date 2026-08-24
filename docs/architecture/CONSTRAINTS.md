# §1 Constraints — the values every decision is argued against

Confirmed values came from the project owner. Everything marked **ASSUMED** is my
working assumption; it is used consistently throughout Phase 1A and is listed
again in [`phase-1a/13-open-questions.md`](phase-1a/13-open-questions.md). If an
assumed value is wrong, the decisions that depend on it are named there so you
can see exactly what moves.

| Constraint | Value | Source |
|---|---|---|
| Team size and mix | **1–2 developers, no dedicated DevOps** | Confirmed |
| Seniority profile | 1 senior full-stack + 1 mid, both generalists | **ASSUMED** |
| Timeline to first paying school | 5 months from start of Phase 3 | **ASSUMED** |
| Timeline to 50 schools | 18 months | **ASSUMED** |
| Target price per student per month | ৳20 (range ৳15–30) | **ASSUMED** |
| Expected ARPU per school per month | ৳6,000 (300 students × ৳20) ≈ US$50 | **ASSUMED** |
| Infrastructure ceiling — first 100 schools | **US$250/month** (~5% of gross revenue at 100 schools) | **ASSUMED** |
| Hosting preference | **Hetzner / DigitalOcean VPS** — I recommend the **Singapore** region, not EU (see below) | Confirmed (region is my recommendation) |
| Existing assets | `bdagency`: Next.js 15 + Payload 3 + Postgres, GitHub org, Cloudflare account, Git Bash/Windows dev machines | Observed |
| Support model | Founder-led onboarding and support; business hours Asia/Dhaka; no 24×7 on-call | **ASSUMED** |
| Hard non-negotiables | Single Postgres instance for year one; **no Kubernetes**; must run unattended for days at a time | Derived from team size |
| Regulatory posture | EIIN/BANBEIS reporting export; VAT/withholding on SaaS subscriptions; data-protection posture pending | **ASSUMED / OPEN** — see below |

Exchange rate used throughout: **৳120 = US$1** (ASSUMED).

## What "1–2 developers, no DevOps" actually forecloses

This is the single most decision-shaping constraint in the document, more than
budget and more than scale. It rules the following **out**, permanently for
year one, regardless of technical merit:

| Ruled out | Why |
|---|---|
| Microservices | *n* services means *n* deploy pipelines, *n* on-call surfaces and distributed transactions across the fee ledger. Two people cannot staff it. |
| Kubernetes | A cluster is a full-time job. Docker Compose on a VPS is operable by one person at 02:00. |
| Schema-per-tenant or database-per-tenant | Migration fan-out across thousands of targets needs an operations function that does not exist here. See [ADR-0003](adr/0003-tenancy-model.md). |
| A separate analytics warehouse at launch | ETL is a system that breaks silently. Deferred behind a trigger metric. |
| Self-hosted object storage (MinIO) at launch | Durability becomes your problem. Managed S3-compatible storage is US$5/month. |
| Anything requiring a 24×7 response | The architecture must degrade safely and wait until morning. |

It rules the following **in**:

- A **modular monolith** with hard internal boundaries — one deployable, one
  database, one mental model, seams marked for a later split.
- **Managed anything** where the managed price is under roughly US$20/month.
- **Boring, well-documented technology** with large hiring pools locally.
- Operational simplicity treated as a **correctness property**, not a nice-to-have.

## On hosting region — a recommendation that differs from the brief

The brief offers "BD-local DC vs AWS ap-south-1 vs Hetzner/DO". Hetzner/DO was
chosen, but *region* was not specified and it matters more than the provider.

| Region | Approx. RTT from Dhaka | Note |
|---|---|---|
| Hetzner Falkenstein / Helsinki (EU) | ~140–190 ms | Cheapest hardware anywhere |
| Hetzner Singapore | ~60–90 ms | Newer region, smaller instance catalogue |
| DigitalOcean Singapore | ~60–90 ms | Higher unit cost, managed Postgres available |
| AWS ap-south-1 (Mumbai) | ~45–70 ms | ~3–5× the cost for equal capacity |

These figures are **indicative and must be measured** before Phase 2 closes
(see [open questions](phase-1a/13-open-questions.md)).

An EU region costs roughly **100 ms extra on every uncached request**. A teacher
marking attendance for 40 students, or an accountant entering 60 receipts, pays
that repeatedly. A CDN does not fix it — those are authenticated, dynamic,
per-tenant requests that cannot be cached at the edge.

**Recommendation: Singapore.** The hardware premium over EU is small next to the
latency it buys. Recorded as [ADR-0002](adr/0002-hosting-and-region.md).

## On the regulatory line — flagged, not answered

I am not able to verify current Bangladeshi requirements from inside this
project, and getting them wrong is expensive in a system that holds children's
records and moves money. Three items need a definitive answer from someone
qualified before Phase 2 closes:

1. **Data residency.** Whether student PII may lawfully be stored outside
   Bangladesh. If the answer is no, Singapore/EU hosting is void and the entire
   cost model changes. This is the highest-impact open question in Phase 1A.
2. **VAT / withholding treatment** of a domestic SaaS subscription, and the
   invoice format required.
3. **BANBEIS / EIIN reporting**: which returns schools must file and in which
   format, so the export is designed for it rather than retrofitted.

The architecture stays viable under either residency answer — the tenancy model
does not change — but the hosting decision and the cost model do. Item 1 is why
[ADR-0002](adr/0002-hosting-and-region.md) carries an explicit revisit trigger.
