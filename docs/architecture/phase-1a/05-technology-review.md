# 5. Technology review and recommended stack

This section answers §11 of the brief: challenge the suggested stack, give a
verdict on each item, and state the switching cost — including hiring and
maintenance in the local market.

Two constraints decide most of these calls, and it is worth naming them once:

- **1–2 developers, no dedicated DevOps.** Every additional service is a thing
  that breaks at 02:00 with nobody rostered to fix it.
- **US$50/month ARPU.** Per-tenant fixed cost has to round to nothing.

Prices below are approximate and should be confirmed before Phase 2 closes.

---

## 5.1 Verdict table

| Technology | Verdict | Reasoning |
|---|---|---|
| **Next.js 15 (App Router)** | **Recommended** | One deployable serving UI, API and server-rendered pages. RSC lets the dashboard read the database without an HTTP hop. The team already ships it. The real risk — putting domain logic in route handlers — is mitigated by [ADR-0001](../adr/0001-modular-monolith.md), not by changing framework |
| **shadcn/ui + Radix + Tailwind v4** | **Recommended** | Components are copied into the repo, so tenant theming is CSS variables rather than a theme-provider fight. Radix carries the accessibility work needed for WCAG 2.2 AA. Near-zero runtime. Decisive on the 180 KB budget |
| MUI | **Not recommended** | Emotion runtime plus a heavy component set blows the low-end-Android budget. Its DataGrid is excellent and is the strongest argument for it — replaced here by TanStack Table + Virtual at a fraction of the weight |
| Ant Design | **Not recommended** | Best-in-class dense tables and forms, which genuinely fit a school admin panel. Rejected on bundle size and on a visual language that is hard to re-brand per tenant |
| Chakra UI | **Not recommended** | Runtime-CSS cost without a compensating advantage over Radix |
| **Puck Editor** | **Optional — deferred to Phase 2** | Right tool for tenant-authored pages when the CMS ships. Not MVP: schools do not switch vendors for a website builder. Nothing in the data model precludes it |
| **NestJS** | **Not recommended for this team** | Excellent framework, wrong shape here. A separate API service means two deployables, two CI pipelines, two auth surfaces and an HTTP hop the RSC dashboard does not need. Its actual value — module boundaries and dependency inversion — is adopted directly as plain TypeScript modules. See [ADR-0004](../adr/0004-application-framework.md) |
| **Prisma ORM** | **Not recommended** | Three concrete blockers, not preference. See §5.2 |
| **Drizzle ORM** | **Recommended** | Thin TypeScript over SQL. Transaction-scoped `SET LOCAL` for RLS is natural. Raw DDL for partitioning. No engine process. See [ADR-0005](../adr/0005-orm.md) |
| **PostgreSQL 16+** | **Strongly recommended** | RLS is the tenancy enforcement mechanism, and nothing else in reach offers it. Also supplies the job queue, full-text search, `numeric`/`bigint` money, partitioning and JSONB for configuration |
| **REST (versioned) over GraphQL** | **Recommended** | See §5.3 |
| **Redis** | **Optional — deferred** | Nothing in the MVP needs it that Postgres and in-process caching do not cover. Adopted at a named trigger: the second application node. [ADR-0014](../adr/0014-defer-redis.md) |
| **pg-boss** (job queue) | **Recommended** | Jobs live in the same database, so a job can be enqueued *inside* the transaction that caused it. That removes the dual-write problem from every money and result flow. [ADR-0010](../adr/0010-job-queue.md) |
| BullMQ | **Optional — later** | Better throughput and tooling; needs Redis, and its group-based fairness is a paid feature. Migration path documented |
| **Cloudflare R2** (object storage) | **Recommended** | S3-compatible, ~US$0.015/GB-month, **zero egress fees**. Egress is the cost that matters when every guardian downloads a report card. [ADR-0015](../adr/0015-object-storage.md) |
| MinIO self-hosted | **Not recommended** | Durability becomes the team's problem. Kept as a swap-in for a data-residency ruling |
| **Shared schema + `tenant_id` + RLS** | **Recommended** | The only model whose migration and backup cost stays flat as tenant count grows. [ADR-0003](../adr/0003-tenancy-model.md) |
| **Headless Chromium (Playwright) + pinned Noto Bengali** | **Recommended** | HarfBuzz shaping is required for Bangla conjuncts, ya-phala and reph. Templates are HTML/CSS, so per-school layouts need no code. [ADR-0009](../adr/0009-pdf-rendering.md) |
| pdfmake / PDFKit / jsPDF | **Not recommended** | No complex-script shaping. Bangla output is visibly wrong. Non-negotiable |
| WeasyPrint / Typst | **Optional — fallback** | Both shape correctly and use far less memory than Chromium. Revisit if the PDF worker's footprint becomes the binding constraint |
| **Hetzner / DO VPS, Singapore, Docker Compose** | **Recommended** | Latency and cost. No Kubernetes at this team size. [ADR-0002](../adr/0002-hosting-and-region.md) |
| Vercel + Neon | **Not recommended** | Superb DX. Its per-request cost model is exactly wrong for result-publication read spikes, and serverless connection limits fight RLS session state |
| Kubernetes | **Not recommended** | A cluster is a full-time role. Revisit at multiple nodes *and* a person to own them |
| **Postgres FTS + `pg_trgm`** (search) | **Recommended** | Covers student and guardian lookup, including Bangla/English fuzzy matching for the duplicate detection in FR-11.5 |
| Elasticsearch / Meilisearch | **Not recommended now** | Another stateful service. Trigger: search p95 above 500 ms, or cross-tenant operator search over millions of records |
| **Sentry** (errors) + **Grafana/Prometheus or Grafana Cloud free tier** (metrics, logs, uptime) | **Recommended** | Error tracking is the highest-value observability spend for a small team. Detail in Phase 1C |

---

## 5.2 Prisma versus Drizzle — the three blockers

This is a real disagreement with the brief, so the reasoning is set out fully.
Prisma is a good ORM and the more widely known of the two. It is rejected here
for architectural reasons, not preference.

**Blocker 1 — RLS needs transaction-scoped session state.** Tenant isolation
works by setting a PostgreSQL session variable that RLS policies read:

```sql
SET LOCAL app.tenant_id = '01J...';
```

`SET LOCAL` only lasts for the enclosing transaction, so **every** query must run
inside a transaction that first sets it. With Drizzle that is one wrapper:

```ts
export function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
```

Prisma can do this through `$transaction` plus a client extension, but every
query then pays interactive-transaction overhead, and the pattern fights
Prisma's connection handling rather than working with it. When the isolation
guarantee is the thing you least want to be clever about, the ORM should make it
boring.

**Blocker 2 — partitioning.** Attendance, audit logs and notifications are
declared partitioning candidates in §5.31 and will need it. Prisma's schema
language cannot express `PARTITION BY RANGE`, so partitioned tables end up
managed outside the schema, which is exactly the drift that makes migrations
dangerous. Drizzle's migrations are SQL, so partitions are ordinary DDL.

**Blocker 3 — memory.** Prisma runs a Rust query engine alongside Node. On a
box hosting the app, the worker, PostgreSQL and a Chromium PDF renderer, a few
hundred megabytes of avoidable resident memory is a real cost. Drizzle is a thin
layer over `node-postgres`.

A fourth, softer reason: the reporting, tabulation and fee-aggregation queries
in this system are genuinely SQL-shaped. Prisma pushes those into
`$queryRaw` anyway, at which point its main benefit no longer applies.

**Switching cost, stated honestly.** Prisma has the larger hiring pool in
Bangladesh; Drizzle-experienced developers are rarer. Mitigations: Drizzle's API
is close to SQL, so anyone who knows SQL is productive in about a day, whereas
Prisma's abstractions have to be learned *and then* worked around; and the
existing `bdagency` codebase already runs Drizzle underneath Payload 3, so the
team has exposure. Net: a few days of ramp-up against a structural fit problem.

**Revisit if** the team grows past four developers and onboarding speed starts to
dominate — or if Prisma ships first-class RLS and partitioning support.

---

## 5.3 REST versus GraphQL

| | REST (chosen) | GraphQL | Hybrid |
|---|---|---|---|
| Authorization surface | One check per endpoint, in one place | Per field, per resolver, per path — combinatorially larger | Two surfaces to secure |
| Tenant scoping | Enforced once in the request context, backed by RLS | Every resolver must be trusted not to escape context | Both |
| Caching | HTTP caching works, and CDN caching of published results works | POST by default; caching requires extra work | Mixed |
| N+1 risk | Explicit and visible | Requires DataLoader discipline everywhere | Mixed |
| Cost to a 2-person team | Low | Schema + resolvers + loaders + client cache is a second system | Highest |
| Over-fetching on mobile | Real, mitigated by purpose-built endpoints | Solved natively | Solved partly |

**Decision: REST.** GraphQL's genuine advantage — a mobile client fetching
exactly what it needs — is largely neutralised here because Next.js RSC already
lets a server component select precisely the columns it renders. Its cost, an
authorization surface that grows with the schema, lands directly on the one
property that must not fail: cross-tenant isolation.

Recorded as [ADR-0007](../adr/0007-api-style.md).

---

## 5.4 The recommended stack

| Layer | Choice | Note |
|---|---|---|
| Framework | **Next.js 15**, App Router, TypeScript strict | One deployable |
| Domain layer | **Plain TypeScript modules**, framework-free | The seam for a later split |
| Database | **PostgreSQL 16+**, single instance + streaming replica | RLS is the isolation mechanism |
| Data access | **Drizzle ORM** + `node-postgres` pool | SQL migrations |
| Jobs | **pg-boss** in a separate worker process | Transactional enqueue |
| Cache | In-process LRU now; **Redis** at the second node | [ADR-0014](../adr/0014-defer-redis.md) |
| UI | **shadcn/ui + Radix + Tailwind v4** | Tenant theming via CSS variables |
| Tables | **TanStack Table + TanStack Virtual** | Headless, cheap, virtualised |
| Forms | **React Hook Form + Zod** | One Zod schema validates client and server |
| i18n | **next-intl**, `en` + `bn` | Matches `bdagency` |
| Type | **Noto Sans Bengali / Noto Serif Bengali** + a Latin pair | Bangla coverage decides it |
| PDF | **Playwright + headless Chromium**, pinned fonts, in the worker image | HTML/CSS templates |
| Files | **Cloudflare R2**, private buckets, signed URLs | Zero egress |
| CDN / WAF / DNS | **Cloudflare** free tier | Rate limiting and bot protection at the edge |
| SMS | Provider-agnostic interface, two BD providers | [§5.5](#55-provider-abstractions) |
| Payments | Provider-agnostic interface, SSLCommerz first | Phase 2 |
| Email | Resend or Amazon SES | Staff-facing only |
| Auth | **Own implementation** on Argon2id + opaque server-side sessions | See below |
| Validation | **Zod** at every boundary | |
| Tests | **Vitest** + **Playwright** | Golden-image tests for Bangla PDF |
| Runtime | **Docker Compose** on one VPS | No orchestrator |
| CI/CD | **GitHub Actions** | |
| Errors | **Sentry** | |
| Metrics/logs | Prometheus + Grafana, or Grafana Cloud free tier | Phase 1C |

### On rolling our own authentication

Normally the wrong instinct. Here the requirements defeat the off-the-shelf
options: one account holding memberships across several tenants, phone-OTP as a
first-class login, phone numbers that are shared between people, and role
context switching. Auth.js and similar libraries assume one user row per
identity and one tenant.

What is **not** hand-rolled: Argon2id for hashing, the OTP transport, TLS,
CSRF token generation, and rate limiting. What is hand-rolled is the *session
and context resolution*, which is domain logic in any case. Sessions are opaque
random tokens stored server-side, not JWTs — revocation within a minute
(NFR §4.6) is a requirement, and stateless tokens cannot do it without a
revocation list, which is a session store with extra steps.

### Provider abstractions

SMS, payments, email and object storage each sit behind an interface owned by
the domain layer, with adapters in an infrastructure module. This is not
speculative generality: BTRC masked-sender approval can stall, providers change
pricing, and a data-residency ruling could force object storage onshore
overnight. The interfaces are small — `send()`, `charge()`, `put()` — and the
cost of defining them is a morning.
