# 43. Major risks and trade-offs

Ranked by expected damage, not by likelihood. Each has an owner, a mitigation and
an early-warning signal — a risk with no signal is one you find out about from a
customer.

## 43.1 The risk register

### R1 — Scope exceeds team capacity by roughly an order of magnitude

**Severity: critical · Likelihood: near-certain · Owner: project owner**

§5 describes fourteen substantial modules. Assessment, finance and the calendar
engine are each a quarter of work for one developer. At ~1.5 FTE the full scope
is a **three-to-four year build**.

No architectural decision mitigates this. It has been named in
[§1](../phase-1a/01-executive-summary.md), [§9.1](../phase-1a/09-domain-boundaries.md)
and [§11.11](../phase-1a/11-entity-model.md), and the only real mitigation is the
MVP cut being taken seriously.

| Mitigation | Signal it is failing |
|---|---|
| Ship the MVP cut, defer the rest | "While we're in there" additions to a shipped module |
| One module at a time to production quality | Three modules simultaneously at 80% |
| Re-derive scope from a design partner if one exists ([OQ-23](../phase-1a/13-open-questions.md)) | Building features nobody has asked for |
| Treat the roadmap in [§45](45-roadmap.md) as a commitment, not a wish | Phase boundaries slipping without a decision |

**This is the risk most likely to end the project**, and it is a planning risk
rather than a technical one.

---

### R2 — Onboarding capacity caps growth long before infrastructure does

**Severity: high · Likelihood: near-certain · Owner: project owner**

Schools switch in November–January or not at all
([§2.3](../phase-1a/02-domain-analysis.md)). Hands-on onboarding runs at perhaps
3–5 schools per week per person — **15–20 per season**. Infrastructure supports
150 schools on one box ([§42](42-cost-model.md)).

| Mitigation | Signal |
|---|---|
| Import quality is an MVP requirement, not a feature ([ADR-0024](../adr/0024-import-staging-model.md)) | Onboarding taking > 3 days per school |
| Self-service import with dry-run validation | Every school needing a call |
| Templates that a school's office can fill unaided | Repeated same-error support tickets |

The architectural consequence is already reflected: **import is worth more than
any infrastructure optimisation in this document.**

---

### R3 — A cross-tenant data leak

**Severity: catastrophic · Likelihood: low · Owner: engineering**

Children's records exposed to another school ends the company. Recovery is not
possible in a market where trust is the product.

| Mitigation | Where |
|---|---|
| RLS enabled **and forced**, no `BYPASSRLS` on the app role | [§7.2](../phase-1a/07-multi-tenancy.md) |
| **Generated** isolation tests from `pg_class` — a new table is covered the day it exists | [§39.2](39-testing.md) |
| Two independent walls: application scoping and RLS | [§6.4](../phase-1a/06-architecture-overview.md) |
| `rls_denied_total` as a tripwire metric | [§34.3](34-observability.md) |
| 404 not 403 on tenant miss | [§7.3](../phase-1a/07-multi-tenancy.md) |
| Authenticated responses never edge-cached | [§31.5](31-caching.md) |

Likelihood is low **because** of these, not inherently. Removing any one of them
raises it materially.

---

### R4 — Data residency ruling invalidates the hosting and storage decisions

**Severity: high · Likelihood: unknown · Owner: project owner**

[OQ-1](../phase-1a/13-open-questions.md). If student PII may not leave
Bangladesh, [ADR-0002](../adr/0002-hosting-and-region.md) and
[ADR-0015](../adr/0015-object-storage.md) both fall.

| Mitigation | Effect |
|---|---|
| Storage behind an S3-compatible interface, MinIO exercised daily in dev | Swap is configuration, not a rewrite |
| Application is stateless; the DB is standard PostgreSQL | Portable |
| Tenancy, identity, schema and module boundaries are unaffected | **The expensive parts do not change** |
| Cost impact modelled | [§42.5](42-cost-model.md): ~$250–320/mo at 100 schools |

Budget 2–4 weeks of infrastructure work and a materially higher bill. **Ask a
Bangladeshi lawyer in week one** — this is cheap to resolve and expensive to
discover late.

---

### R5 — The assessment engine cannot express a real school's rules

**Severity: high · Likelihood: medium · Owner: engineering**

If schools need code changes to be onboarded, the business stops scaling — the
exact failure [ADR-0012](../adr/0012-assessment-engine.md) exists to prevent.

| Mitigation | Signal |
|---|---|
| Declarative vocabulary over a fixed rule set | A second school needing a code change |
| Real school configurations as test fixtures | Fixtures all resembling one another |
| Extend the vocabulary, never branch per school | `if (tenantId === …)` appearing anywhere |
| Three schools needing the same missing rule → extend | Sales blocked on grading |

---

### R6 — Financial correctness defect

**Severity: catastrophic (reputationally) · Likelihood: low · Owner: engineering**

A gap in receipt numbering, a lost payment, arrears that vanish at promotion. In
this market a missing receipt serial reads as theft.

| Mitigation | Where |
|---|---|
| Integer poisha; `Money` forbids float | [ADR-0011](../adr/0011-money-representation.md) |
| Gapless numbering under a row lock, tested **concurrently** | [§39.2](39-testing.md) |
| Append-only with reversing entries; nothing deleted | [§17.8](../phase-1b/17-finance-architecture.md) |
| Idempotency keys on every money endpoint | [§19.5](../phase-1b/19-api-architecture.md) |
| Financial RPO 0 via per-transaction sync commit | [§36.2](36-backup-dr.md) |
| Two-person approval for operator money repairs | [§38.4](38-support-console.md) |

---

### R7 — SMS provider or BTRC approval delays launch

**Severity: medium · Likelihood: medium · Owner: project owner**

Masked-sender approval is per-provider with an unpredictable lead time
([OQ-5](../phase-1a/13-open-questions.md)). SMS is the primary channel — without
it the product is materially less valuable.

| Mitigation | Signal |
|---|---|
| **Start the approval process in week one**, before the product is finished | Approval not started by the end of month one |
| Two providers implemented behind one interface | Single-provider dependency |
| In-app notices as the zero-cost fallback | — |

---

### R8 — Seasonal revenue concentration

**Severity: medium · Likelihood: high · Owner: project owner**

Missing a December deadline costs twelve months, not one. A slipped MVP does not
slip by a quarter; it slips by a year.

| Mitigation |
|---|
| Roadmap phases sized against the November window ([§45](45-roadmap.md)) |
| Ship fee collection first — it sells on its own and can onboard mid-year |
| A school can start on fees in March and adopt attendance and results in January |

---

### R9 — Single-tenant restore is slow

**Severity: medium · Likelihood: low · Owner: engineering**

The acknowledged cost of shared-schema tenancy: 2–4 hours to restore one tenant
to a point in time ([§36.4](36-backup-dr.md)).

Accepted because soft deletes, audit trails and compensating batch actions handle
the overwhelming majority of real "restore us" requests in minutes — and those
requests are nearly always "undo what we did at 11:40".

---

### R10 — Key-person dependency

**Severity: high · Likelihood: high · Owner: project owner**

At 1–2 developers, one person leaving is an existential event.

| Mitigation | Where |
|---|---|
| ADRs record *why*, not just what | [`adr/`](../adr/README.md) |
| `CLAUDE.md` as the fast on-ramp | [`CLAUDE.md`](../../../CLAUDE.md) |
| Boring, widely-known technology | [§5](../phase-1a/05-technology-review.md) |
| Committed provisioning and restore scripts | [§41.1](41-project-structure.md) |
| Quarterly restore drill performed by whoever did **not** build it | [§36.5](36-backup-dr.md) |

The last row is the real test of documentation, and the only one that reliably
finds the gaps.

## 43.2 Accepted trade-offs

Deliberate choices with real costs, recorded so they are not mistaken for
oversights.

| Trade-off | Gained | Paid |
|---|---|---|
| Shared schema over per-tenant DB | Flat migrations, near-zero per-tenant cost | Slow single-tenant restore; weaker noisy-neighbour isolation |
| Single VPS over HA | ~$300/mo saved, one thing to operate | No automatic failover; 99.5% in school hours, stated honestly |
| Drizzle over Prisma | RLS ergonomics, partitioning, lower memory | Smaller local hiring pool |
| REST over GraphQL | One authorization surface, cacheable | Purpose-built endpoints for composite screens |
| Next.js full-stack over NestJS | One deployable, one auth path | Discipline needed to keep domain out of route handlers |
| pg-boss over BullMQ | **Transactional enqueue** — removes a class of correctness bug | Lower throughput ceiling |
| Chromium PDF over lighter engines | Correct Bangla, HTML templates, preview parity | ~1 GB of memory, capped |
| Redis deferred | One less service | Must be added *before* the second node |
| PWA over native | One codebase, no install friction | No reliable guardian push |
| Manual SaaS billing first | No integration work at low volume | Operator time; automate past 50 tenants |
| No formal pen test at launch | Budget | Stated as a known gap, not implied coverage |
| Timetable detection, not generation | A quarter saved | Schools with complex timetables see less value |

## 43.3 What would make us reconsider the architecture

Not tuning — genuine redesign triggers:

| Event | Reconsider |
|---|---|
| Data residency requires onshore hosting | [ADR-0002](../adr/0002-hosting-and-region.md), [ADR-0015](../adr/0015-object-storage.md) |
| A single tenant exceeds 15% of DB size or IO | Shard that tenant ([§7.6](../phase-1a/07-multi-tenancy.md)) — not the model |
| Three schools need a grading rule the vocabulary cannot express | Extend the vocabulary; only reconsider [ADR-0012](../adr/0012-assessment-engine.md) if extensions become routine |
| Team exceeds six developers | [ADR-0001](../adr/0001-modular-monolith.md), [ADR-0004](../adr/0004-application-framework.md) |
| ARPU proves 3× higher | Managed PostgreSQL and HA become affordable |
| A regulator requires double-entry accounting | [§17.11](../phase-1b/17-finance-architecture.md) upgrade path |
| An enterprise or NGO buyer requires physical isolation | Per-tenant shard, not a global model change |
