# 46. Architecture Decision Summary

The consolidated, final decisions carried into Phase 2. If you read one document
from Phase 1, read this one — everything here is settled unless a listed trigger
fires.

## 46.1 The stack, decided

| Layer | Decision | ADR |
|---|---|---|
| Architecture | **Modular monolith**, domain layer free of framework and SDK imports | [0001](../adr/0001-modular-monolith.md) |
| Framework | **Next.js 15** App Router, TypeScript strict — not NestJS + separate frontend | [0004](../adr/0004-application-framework.md) |
| Database | **PostgreSQL 16+**, single primary + streaming replica | [0002](../adr/0002-hosting-and-region.md) |
| Data access | **Drizzle ORM**, SQL migrations — not Prisma | [0005](../adr/0005-orm.md) |
| Tenancy | **Shared schema + `tenant_id` + RLS enabled *and forced*** | [0003](../adr/0003-tenancy-model.md) |
| Identity | **Global account → tenant membership → tenant-scoped person** | [0006](../adr/0006-identity-model.md) |
| API | **Versioned REST**, idempotency on money and bulk | [0007](../adr/0007-api-style.md) |
| UI | **shadcn/ui + Radix + Tailwind v4**, TanStack Table/Virtual | [0008](../adr/0008-ui-library.md) |
| PDF | **Headless Chromium**, vendored Noto Bengali | [0009](../adr/0009-pdf-rendering.md) |
| Jobs | **pg-boss** — transactional enqueue | [0010](../adr/0010-job-queue.md) |
| Money | **`bigint` integer poisha** | [0011](../adr/0011-money-representation.md) |
| Assessment | **Declarative versioned rules engine** | [0012](../adr/0012-assessment-engine.md) |
| Calendar | **Materialised `working_day` table** | [0013](../adr/0013-calendar-as-infrastructure.md) |
| Cache | **In-process LRU; Redis deferred** | [0014](../adr/0014-defer-redis.md) |
| Storage | **Cloudflare R2**, private, signed URLs | [0015](../adr/0015-object-storage.md) |
| Ids | **ULID in `uuid` columns** | [0016](../adr/0016-identifier-strategy.md) |
| Mobile | **PWA**, offline for two flows only | [0017](../adr/0017-pwa-not-native.md) |
| Offline | **Client-ULID outbox**, nothing silently dropped | [0018](../adr/0018-offline-sync-model.md) |
| i18n | **Three-way text split**; `name_bn`/`name_en` both real | [0019](../adr/0019-i18n-content-split.md) |
| Payments | **Provider-agnostic**, `unknown` a first-class state | [0020](../adr/0020-payment-provider-abstraction.md) |
| Reporting | **Primary → replica → rollups → warehouse**, by metric | [0021](../adr/0021-reporting-data-path.md) |
| CMS | **Puck, Phase 2**, behind a public projection | [0022](../adr/0022-cms-public-projection.md) |
| Branding | **Computed contrast guard** | [0023](../adr/0023-branding-contrast-guard.md) |
| Import | **Stage → validate → all-or-nothing commit** | [0024](../adr/0024-import-staging-model.md) |
| Deployment | **Compose on one host, rolling app swap** | [0025](../adr/0025-single-host-compose-deploy.md) |
| Backup | **WAL to a second provider; per-transaction sync commit for money** | [0026](../adr/0026-backup-and-financial-rpo.md) |
| Observability | **Sentry + self-hosted Prometheus/Grafana**, no tracing | [0027](../adr/0027-observability-stack.md) |
| Testing | **Bottom-heavy, five non-negotiable suites** | [0028](../adr/0028-testing-strategy.md) |
| Impersonation | **Time-limited, reasoned, tenant-visible** | [0029](../adr/0029-impersonation-controls.md) |
| SaaS billing | **Manual-first BDT; suspension never denies records** | [0030](../adr/0030-manual-first-saas-billing.md) |

## 46.2 Numbers that are now fixed

Facts Phase 2 builds against rather than re-derives. **Bold = measured, not
estimated.**

| Quantity | Value | Source |
|---|---|---|
| **Minimum host size** | **8 GB** | [OQ-13](../spikes/oq-13-pdf-memory/README.md) |
| **PDF throughput** | **120 docs/min; 500 in 4.1 min** | OQ-13 |
| **PDF renderer peak / cap** | **958 MB / `mem_limit: 1.5g`** | OQ-13 |
| **Page recycle interval** | **Every 25 renders** (40% lower peak, free) | OQ-13 |
| **Generated PDF size** | **286 KB per page** | OQ-13 |
| **Bangla line-height** | **≥ 1.5 body, ≥ 1.35 dense; 1.0 clips** | [OQ-12](../spikes/oq-12-bangla-shaping/README.md) |
| **Bangla ascent vs Latin** | **~23% higher** | OQ-12 |
| p95 API latency | 300 ms server-side / 800 ms from Dhaka | [§4.1](../phase-1a/04-non-functional-requirements.md) |
| First-load JS | 150 KB guardian / 180 KB teacher / 350 KB admin | §4.4 |
| LCP on low-end Android, 3G | ≤ 3.5 s | §4.4 |
| Availability, school hours | 99.5% | §4.2 |
| RPO general / financial | ≤ 60 s / **0** | [ADR-0026](../adr/0026-backup-and-financial-rpo.md) |
| RTO | ≤ 4 h, confirmed by quarterly drill | §36.5 |
| Import ceiling | 5,000 rows / 20 MB per batch | §4.1 |
| CI budget | ≤ 10 min | [ADR-0028](../adr/0028-testing-strategy.md) |
| Infra at 100 schools | **~US$105/mo** vs a $250 ceiling | [§42.2](42-cost-model.md) |
| Result SMS fan-out | Spread over 30–90 min | §4.3 |
| Impersonation limit | 30 min, reason required | [ADR-0029](../adr/0029-impersonation-controls.md) |

## 46.3 Invariants — true everywhere, forever

| # | Invariant |
|---|---|
| 1 | Every tenant-owned table has RLS **enabled and forced**, with `USING` + `WITH CHECK`. `sm_app` has no `BYPASSRLS` |
| 2 | Money is `bigint` minor units. No floats, ever |
| 3 | Receipt numbers are **gapless** per school per fiscal year |
| 4 | `ABSENT` is never coerced to zero — unrepresentable at the database level |
| 5 | Published results are immutable; revisions create a new version |
| 6 | Nothing is hard-deleted except sessions, OTPs and offboarded tenants |
| 7 | Every mutation is audited with actor, tenant, timestamp and reason |
| 8 | `working_day` is the single answer to "is this a working day?" |
| 9 | Jobs are enqueued inside the transaction that caused them |
| 10 | `domain/` imports no framework, ORM or SDK |
| 11 | Every index on a tenant table leads with `tenant_id` |
| 12 | No PII in logs — ids only |
| 13 | Authorization is checked before a storage URL is signed |
| 14 | A suspended tenant keeps read access and export |
| 15 | Every cache key carries `tenant_id`; no cached value is needed for correctness |

Phase 2 and Phase 3 may not weaken any of these without a superseding ADR.

## 46.4 Conventions

| Area | Convention |
|---|---|
| Tables | `snake_case`, singular |
| Ids | ULID in `uuid`; human-facing codes are separate (`student_code`, `receipt_no`) |
| Enums | `text` + `CHECK`, or a tenant-scoped table |
| Dates | `date` for days, `timestamptz` for instants, never `timestamp`. Timezone fixed to `Asia/Dhaka` |
| Money on the wire | **Strings** of minor units — JSON numbers lose `bigint` precision |
| Events | Past tense, ids only |
| Permissions | `resource.action`, a closed TypeScript union |
| Use cases | One file, `verbNoun.ts`; always `authorize()` then `withTenant()` |
| Errors | Stable `code` + localised `message` + `requestId` |
| Pagination | Keyset by default |
| Migrations | Forward-only, backwards compatible for one release |
| Commits | One imperative line, sentence case, no type prefix |
| Text | NFC normalise on write; `name_bn` and `name_en` both `NOT NULL` on `person` |

## 46.5 Deferred, with the trigger that reopens it

| Deferred | Trigger |
|---|---|
| Redis | A second app node is **planned** — added before it serves traffic |
| PgBouncer | Pool saturation, or the second node |
| Table partitioning | `attendance` > 50 M rows; `audit_log` > 100 M |
| Read replica for reporting | Report queries > 10% of primary CPU |
| Dedicated PDF host | Peak > 1.2 GB, or batches degrading interactive p95 |
| BullMQ | Sustained enqueue > 500/s |
| Search engine | Search p95 > 500 ms |
| Analytical store | Rollups > 2 h nightly |
| Tenant sharding | One tenant > 15% of DB size or IO |
| Kubernetes | Multiple nodes **and** someone hired to own them |
| Automated SaaS billing | > 50 tenants, or > half a day of monthly reconciliation |
| Puck CMS | 20 tenants live and the website appears in retention conversations |
| Online payment gateway | After cash and bank recording ship |
| Impersonation console | Phase 2 |
| MFA for all staff | Any tenant requests it |
| Formal pen test | First enterprise contract, or 100 tenants |

## 46.6 Open questions carried into Phase 2

The four that need people rather than documents — OQ-1, OQ-2, OQ-5, OQ-11 — are
tracked with owners and dates in
[`docs/EXTERNAL-ACTIONS.md`](../../EXTERNAL-ACTIONS.md).

| # | Question | Status | Impact if unanswered |
|---|---|---|---|
| **OQ-1** | **Data residency** | **OPEN — ask a lawyer in week one** | Invalidates [ADR-0002](../adr/0002-hosting-and-region.md) and [ADR-0015](../adr/0015-object-storage.md); +2–4 weeks, ~3× infra cost |
| **OQ-2** | Real ARPU | OPEN — five pricing conversations | Model survives ৳2,000 ([§42.5](42-cost-model.md)); changes managed-service affordability |
| **OQ-3** | Actual FTE | OPEN — a calendar, not a conversation | At 0.5 FTE the MVP must halve |
| OQ-5 | BTRC masked-sender lead time | OPEN — **start in week one** | Longest external dependency |
| OQ-11 | Dhaka → Singapore RTT | OPEN — measure | Confirms the region choice |
| OQ-15 | RLS planner behaviour at scale | OPEN — `EXPLAIN` on 10 M rows | Fallback: single-value GUC |
| OQ-23 | Is there a design partner? | OPEN | **If yes, re-derive the MVP from their workflow** |
| ~~OQ-12~~ | ~~Bangla shaping~~ | **CLOSED — passed** | [spike](../spikes/oq-12-bangla-shaping/README.md) |
| ~~OQ-13~~ | ~~PDF memory~~ | **CLOSED — renderer stays put** | [spike](../spikes/oq-13-pdf-memory/README.md) |

## 46.7 What Phase 2 must produce

1. Final Drizzle schema and migration set for Phase 3a, RLS included per table
2. API contracts and Zod DTOs for the foundation modules
3. Auth flow and session mechanics in implementable detail
4. The permission vocabulary as a closed union, with the role seed data
5. Component inventory for the three critical screens
6. Folder scaffolding per [§41](41-project-structure.md) with lint boundaries wired
7. Compose files, provisioning script, CI workflows
8. The generated RLS test harness — **before** the first tenant table exists
9. Seed data: system roles, grade scales, fee heads, government calendar
10. Answers to OQ-1, OQ-2, OQ-5, OQ-11

**No complete codebase.**

## 46.8 The three things most likely to go wrong

1. **Scope versus capacity (R1).** The plan, not the architecture, is the risk.
   The roadmap in [§45](45-roadmap.md) is honest that the November 2026 window is
   unreachable — believing otherwise is the most expensive mistake available.
2. **Data residency (OQ-1).** Two ADRs and the cost model hang on a legal answer
   nobody has asked for yet.
3. **Onboarding capacity (R2).** Infrastructure supports 150 schools on one box;
   one person can onboard 15–20 per season. Import quality is worth more than any
   optimisation in this document.

Everything else in Phase 1 is decided, argued, and — for the PDF stack —
measured.
