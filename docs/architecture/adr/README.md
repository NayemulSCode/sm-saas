# Architecture Decision Records

One file per significant decision. The record of what was believed at the time
is the point — **never edit an accepted ADR's decision in place.** Write a new
ADR that supersedes it and mark the old one `Superseded by ADR-00NN`.

New ADR: copy [`TEMPLATE.md`](TEMPLATE.md), take the next free number, add a row
below. CI fails if an ADR is missing from this index, lacks a `**Status:**` line,
or lacks a `Revisit when` section.

## Log

| # | Decision | Status | Revisit trigger |
|---|---|---|---|
| [0001](0001-modular-monolith.md) | Modular monolith with a framework-free domain layer | Accepted | > 6 developers, or a module destabilises the host |
| [0002](0002-hosting-and-region.md) | Hetzner/DO VPS in Singapore, Docker Compose, no Kubernetes | Accepted | Data-residency ruling; RTT > 120 ms; > 250 tenants |
| [0003](0003-tenancy-model.md) | Shared schema with `tenant_id`, enforced by row-level security | Accepted | One tenant > 15% of DB size or IO |
| [0004](0004-application-framework.md) | Next.js full-stack, not NestJS plus a separate frontend | Accepted | A non-web API consumer at real volume |
| [0005](0005-orm.md) | Drizzle ORM, not Prisma | Accepted | > 4 developers; or Prisma ships RLS + partitioning support |
| [0006](0006-identity-model.md) | Global login account, tenant-scoped person, membership between them | Accepted | Tenant SSO; a national student identifier |
| [0007](0007-api-style.md) | Versioned REST, with a mandatory idempotency convention | Accepted | Partner integration needing flexible querying |
| [0008](0008-ui-library.md) | shadcn/ui + Radix + Tailwind, with headless tables | Accepted | Data-grid build exceeds ~3 weeks cumulative |
| [0009](0009-pdf-rendering.md) | Headless Chromium with pinned Noto Bengali fonts for PDF | Accepted | Shaping spike fails; Chromium memory destabilises the host |
| [0010](0010-job-queue.md) | pg-boss for background jobs, so enqueue is transactional | Accepted | Sustained enqueue > 500/s; job IO becomes material |
| [0011](0011-money-representation.md) | Money as integer minor units in `bigint` | Accepted | A second currency is genuinely needed |
| [0012](0012-assessment-engine.md) | Assessment as a versioned declarative rules engine | Accepted | 3+ schools need a rule the vocabulary cannot express |
| [0013](0013-calendar-as-infrastructure.md) | The academic calendar is infrastructure, with one materialized answer | Accepted | Per-student calendars; rebuild > 30 s per tenant-year |
| [0014](0014-defer-redis.md) | Defer Redis until a second application node exists | Accepted | **A second application node is planned** |
| [0015](0015-object-storage.md) | Cloudflare R2 for object storage, behind an S3-compatible interface | Accepted | Data-residency ruling; R2 egress pricing changes |
| [0016](0016-identifier-strategy.md) | ULID primary keys stored in `uuid` columns | Accepted | Native `uuidv7()` available in the deployed PostgreSQL |
| [0017](0017-pwa-not-native.md) | PWA, not native mobile apps | Accepted | Guardian push becomes required and SMS cost makes it economic |
| [0018](0018-offline-sync-model.md) | Client-generated ULID outbox for offline capture | Accepted | A third flow needs offline capture |
| [0019](0019-i18n-content-split.md) | Three-way split of translatable text; bilingual names as two real columns | Accepted | A third language makes paired columns unwieldy |
| [0020](0020-payment-provider-abstraction.md) | Provider-agnostic payments with an explicit `unknown` state | Accepted | Settlement reconciliation cannot close with a provider |
| [0021](0021-reporting-data-path.md) | Staged reporting path: primary → replica → rollups → warehouse | Accepted | Any stage trigger metric is hit |
| [0022](0022-cms-public-projection.md) | Puck CMS deferred to Phase 2, behind a public projection boundary | Accepted | 20 tenants live and the website appears in retention talks |
| [0023](0023-branding-contrast-guard.md) | Tenant branding with a computed contrast guard | Accepted | A compliance reason demands an exact unclamped colour |
| [0024](0024-import-staging-model.md) | Three-phase import: stage, validate, all-or-nothing commit | Accepted | Duplicate review becomes the onboarding bottleneck |
| [0025](0025-single-host-compose-deploy.md) | Docker Compose on one host, with a low-downtime rolling swap | Accepted | A contractual uptime commitment above 99.5% |
| [0026](0026-backup-and-financial-rpo.md) | WAL archiving to a second provider, per-transaction sync commit for money | Accepted | A restore drill fails or exceeds 4 hours |
| [0027](0027-observability-stack.md) | Sentry + self-hosted Prometheus/Grafana, tenant context everywhere, no tracing | Accepted | Modules extracted into services |
| [0028](0028-testing-strategy.md) | Bottom-heavy tests, with five non-negotiable suites | Accepted | A defect class none of the five would have caught |
| [0029](0029-impersonation-controls.md) | Impersonation is time-limited, reasoned, and visible to the tenant | Accepted | A tenant requires prior consent per session |
| [0030](0030-manual-first-saas-billing.md) | Manual-first BDT billing; suspension never denies student records | Accepted | > 50 tenants, or > half a day of monthly reconciliation |
| [0031](0031-dependency-version-policy.md) | Pin to latest stable at scaffold time, with a documented upgrade policy | Accepted | `typescript-eslint` ships TS 7 support; a new Node LTS line |

| [0032](0032-composite-tenant-foreign-keys.md) | Composite `(tenant_id, id)` foreign keys between tenant-owned tables | Accepted | A catalogue test guards it; or a legitimate cross-tenant reference appears |

## The three triggers most likely to fire first

1. **[ADR-0014](0014-defer-redis.md)** — Redis must be added *before* a second
   application node serves traffic, not after. Sequencing matters.
2. **[ADR-0009](0009-pdf-rendering.md)** — the Bangla shaping spike
   ([OQ-12](../phase-1a/13-open-questions.md)) is a week-one task, and a failure
   changes the rendering engine.
3. **[ADR-0002](0002-hosting-and-region.md)** and
   **[ADR-0015](0015-object-storage.md)** — both fall to a single data-residency
   ruling ([OQ-1](../phase-1a/13-open-questions.md)). Ask the lawyer early.
