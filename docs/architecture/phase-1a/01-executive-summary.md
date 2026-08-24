# 1. Executive summary

## The recommendation in one page

Build a **modular monolith** — one Next.js application, one PostgreSQL database,
one background worker — deployed with Docker Compose on a **single Hetzner or
DigitalOcean VPS in Singapore**. Isolate tenants in a **shared schema with a
`tenant_id` column on every tenant-owned table, enforced by PostgreSQL row-level
security**, so that a forgotten `WHERE` clause returns zero rows rather than
another school's students.

Put the domain logic in framework-agnostic TypeScript modules that both Next.js
and the worker call. Next.js is a *transport*, not the architecture. That single
discipline is what makes a later extraction into separate services possible
without a rewrite, and it costs nothing to adopt on day one.

Total infrastructure at 100 schools: **US$60–110/month**, roughly 1–2% of gross
revenue at the assumed ARPU. Detail lands in Phase 1C.

## The decisions that matter

| # | Decision | ADR |
|---|---|---|
| 1 | Modular monolith, not microservices; domain layer independent of the web framework | [0001](../adr/0001-modular-monolith.md) |
| 2 | Hetzner/DO **Singapore**, Docker Compose, no Kubernetes | [0002](../adr/0002-hosting-and-region.md) |
| 3 | Shared schema + `tenant_id` + **row-level security** as the structural isolation guarantee | [0003](../adr/0003-tenancy-model.md) |
| 4 | **Next.js full-stack** — not NestJS plus a separate frontend | [0004](../adr/0004-application-framework.md) |
| 5 | **Drizzle ORM**, not Prisma — RLS session variables, table partitioning and memory footprint decide it | [0005](../adr/0005-orm.md) |
| 6 | **Global login account, tenant-scoped memberships** — one phone is shared across siblings, one human holds roles in several schools | [0006](../adr/0006-identity-model.md) |
| 7 | **REST**, versioned, with an idempotency convention on every money-moving call | [0007](../adr/0007-api-style.md) |
| 8 | **shadcn/ui + Radix + Tailwind** — bundle size on a low-end Android phone is a functional requirement | [0008](../adr/0008-ui-library.md) |
| 9 | **Headless Chromium** for PDF with pinned Noto Bengali fonts — little else shapes Bangla conjuncts correctly | [0009](../adr/0009-pdf-rendering.md) |
| 10 | **pg-boss** for background jobs, so a job can be enqueued inside the transaction that caused it | [0010](../adr/0010-job-queue.md) |
| 11 | Money as **integer minor units (poisha) in `bigint`** — never a float, never `money` | [0011](../adr/0011-money-representation.md) |
| 12 | Assessment is a **declarative, versioned rules engine**; `ABSENT` is never coerced to zero | [0012](../adr/0012-assessment-engine.md) |
| 13 | The academic calendar is **infrastructure** — one materialized working-day table answers "is this a working day?" for every module | [0013](../adr/0013-calendar-as-infrastructure.md) |
| 14 | **Redis deferred** until a second application node exists — that is the trigger, not a guess | [0014](../adr/0014-defer-redis.md) |
| 15 | **Cloudflare R2** for object storage; zero egress fees decide it | [0015](../adr/0015-object-storage.md) |
| 16 | **ULID primary keys** stored as `uuid` — time-ordered inserts without exposing row counts | [0016](../adr/0016-identifier-strategy.md) |

## Where I disagree with the brief

Stated up front, as §0 asks.

**1. The scope-to-team ratio is off by roughly an order of magnitude.** §5
describes fourteen substantial modules, of which assessment, finance and the
calendar engine are each a full quarter of work for one developer. Delivered
sequentially by two people, the scope in §5 is a **three-to-four year** build.
The architecture below is sound at that scope; the *plan* is not, unless the MVP
cut is taken seriously. This is the principal risk in the project, and no
technical choice mitigates it.

**2. I would reorder the tie-break in §14.** The brief asks for "Scalable +
Secure + Maintainable + Configurable + Multi-tenant + Production-ready +
Cost-conscious, in that order". For a two-person team serving its first hundred
schools I recommend:

> **Correct → Operable → Secure → Configurable → Cost-conscious → Scalable**

Scalability last is deliberate. Nothing in this design blocks scale — the schema
is modelled for millions of students — but *optimising* for scale before the
first fifty schools spends the scarcest resource, developer hours, on the least
pressing risk. The brief's own carve-out, that financial and examination
correctness outranks everything, is retained and strengthened: it becomes first
by default rather than by exception.

**3. Puck Editor and the tenant CMS do not belong in the MVP.** A school does not
change vendors to get a website builder; it changes vendors because fee
collection and result publication are painful. The CMS is real product surface
and should ship — in Phase 2. Designing for it now costs nothing. Building it now
costs a quarter.

**4. "Thousands of schools" is a schema requirement, not an infrastructure
requirement.** Model for millions of students. Provision for one hundred schools.
Every piece of infrastructure in this design carries an explicit trigger metric
for when it becomes necessary. Buying capacity ahead of those triggers is how a
low-ARPU SaaS dies.

**5. §5.14's provider list is right, but the provider is not the hard part.** The
difficulty in Bangladeshi payments is the *lost callback* — money leaves the
guardian's wallet and the IPN never arrives. Idempotency keys, a reconciliation
job against settlement files, and a manual repair workflow matter more than which
of bKash, Nagad or SSLCommerz is integrated first.

**6. One contradiction to resolve.** §5.4 states that most students and guardians
have no email address and that phone is the primary identifier, while §5.23 asks
for email verification and §5.18 treats email as a channel. Both are true of
different populations — staff have email, guardians largely do not. The identity
model therefore treats **phone and email as interchangeable credential types on
one account**, with verification required for whichever is present, rather than
treating email as primary and phone as an add-on. See
[§8](08-identity-authn-rbac.md).

## The three highest-risk areas

1. **The assessment engine (§5.12).** Every school believes its grading rules are
   standard, and every school's differ. Modelled as screens, this becomes bespoke
   code per school and the business stops scaling. It is modelled here as
   configuration evaluated by a versioned pure function, with published results
   stored as immutable snapshots.
2. **Financial correctness (§5.13).** Gapless receipt numbering, arrears crossing
   academic years, and partial-payment allocation are what make this an
   accounting system rather than CRUD. Money is integer poisha, receipt numbers
   are issued under a row lock, and nothing is ever hard-deleted.
3. **Bangla PDF typography (§5.19).** Report cards are the product's most visible
   artefact, and most PDF toolchains render Bangla conjuncts, ya-phala and reph
   incorrectly. Decided in Phase 1, not discovered in Phase 3.

## The MVP cut

What a school pays for on day one: **attendance, results, fees, and telling
parents things.** Everything else is a reason to renew, not a reason to buy.

| Ships in MVP | Deferred but designed for | Out of scope entirely |
|---|---|---|
| Tenancy, identity, RBAC | Library, inventory, transport | Live vehicle tracking |
| School / class / section structure | Puck CMS and tenant sites | Payroll, hostel |
| Student, guardian, staff records | Custom domains | Marketplace / plugins |
| Academic calendar and working days | Biometric / RFID ingestion | Native mobile apps (PWA instead) |
| Attendance, offline-capable | Analytics warehouse | Alumni portal |
| Assessment and report card PDFs | Timetable auto-generation | |
| Fees, receipts, arrears | Online payment gateway *(cash and bank first)* | |
| SMS notifications | Push notifications | |
| Excel import and full export | Scheduled reports | |
| SaaS billing and tenant lifecycle | Support impersonation console | |

The two entries most likely to be argued with. **Timetable** ships as manual data
entry with clash *detection* — clash *solving* is a constraint-solver project of
its own and no school will leave a competitor to get it. **Online payments** ship
after cash and bank-deposit recording, because in this market the first fifty
schools collect most fees at the office counter, and the reconciliation workflow
is what they actually need.

Reasoning per module in [§3](03-functional-requirements.md).

## What Phase 1A does not answer

Deliberately deferred to 1B and 1C, per the gating in §10: module-by-module
design, the API contract surface, frontend component strategy, i18n mechanics,
queue topology, observability, deployment pipeline and the roadmap. Phase 1A
fixes the *foundations* — stack, tenancy, identity, boundaries and the data model
— because every later decision inherits from them.

Open questions, and the assumptions standing in for them, are in
[§13](13-open-questions.md). Three can invalidate decisions above and are marked
accordingly.
