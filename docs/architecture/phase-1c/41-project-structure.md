# 41. Recommended project structure

Expands [§9.6](../phase-1a/09-domain-boundaries.md) into the full tree. The
layout exists to make one rule mechanically enforceable:

> **`modules/*/domain` imports nothing from `next/*`, Drizzle, or any SDK, and
> `modules/*/index.ts` is a module's only importable surface.**

Everything else is convention. That rule is the architecture
([ADR-0001](../adr/0001-modular-monolith.md)).

## 41.1 Tree

```
sm-saas/
├── CLAUDE.md                      working context for agent sessions
├── CONTRIBUTING.md                branching, commits, PRs, ADR discipline
├── docker-compose.yml             prod topology (§35.1)
├── docker-compose.dev.yml         + MinIO, mailpit, seeded DB
├── Dockerfile                     app + worker (one image, two entrypoints)
├── Dockerfile.render              Chromium + vendored fonts
│
├── assets/
│   └── fonts/                     VENDORED .ttf + SHA-256 checksums (ADR-0009)
│
├── docs/architecture/             this documentation
│
├── scripts/
│   ├── check-docs.sh              runs in CI today
│   ├── provision-host.sh          committed, runnable — the IaC substitute
│   ├── restore-drill.sh           quarterly DR rehearsal (§36.5)
│   └── seed.ts                    idempotent dev/E2E seed
│
├── src/
│   ├── app/                                    ── TRANSPORT ONLY ──
│   │   ├── [locale]/
│   │   │   ├── (tenant)/
│   │   │   │   ├── (staff)/                    principal · office · teacher
│   │   │   │   ├── (guardian)/                 own bundle budget (§20.7)
│   │   │   │   └── (auth)/
│   │   │   └── (platform)/                     operator console (§38)
│   │   └── api/
│   │       ├── v1/                             tenant REST
│   │       ├── platform/v1/                    operator REST
│   │       ├── hooks/<provider>/               signature-verified webhooks
│   │       └── public/v1/                      unauthenticated, rate-limited
│   │
│   ├── worker/
│   │   ├── index.ts                            second entrypoint, same modules
│   │   └── handlers/                           one per job type
│   │
│   ├── modules/                                ── THE ARCHITECTURE ──
│   │   ├── platform/
│   │   ├── identity/
│   │   ├── structure/
│   │   ├── directory/
│   │   ├── calendar/
│   │   ├── academics/
│   │   ├── attendance/
│   │   ├── assessment/
│   │   │   ├── domain/
│   │   │   │   ├── scheme.ts                   entities, value objects
│   │   │   │   ├── rules/
│   │   │   │   │   ├── evaluate.ts             PURE — no IO, exhaustively tested
│   │   │   │   │   ├── aggregate.ts
│   │   │   │   │   └── rank.ts
│   │   │   │   └── ports.ts                    interfaces the module needs
│   │   │   ├── application/
│   │   │   │   ├── enterMarks.ts               one file per business action
│   │   │   │   ├── lockMarks.ts
│   │   │   │   ├── tabulate.ts
│   │   │   │   └── publishResults.ts
│   │   │   ├── infrastructure/                 Drizzle repos, adapters
│   │   │   ├── events.ts
│   │   │   └── index.ts                        ← the ONLY importable surface
│   │   ├── finance/  notification/  documents/  dataport/  reporting/
│   │   └── (cms · library · inventory · transport — Phase 2, absent today)
│   │
│   ├── shared/                                 ── SMALL ON PURPOSE ──
│   │   ├── money.ts                            integer poisha (ADR-0011)
│   │   ├── date.ts                             LocalDate, Asia/Dhaka fixed
│   │   ├── ids.ts                              ULID, branded id types
│   │   ├── result.ts                           Result<T,E>, error taxonomy
│   │   ├── auth-context.ts                     AuthContext, Scope, authorize()
│   │   ├── cache.ts                            interface + LRU (ADR-0014)
│   │   └── rate-limiter.ts                     interface + in-process
│   │
│   ├── db/
│   │   ├── schema/                             Drizzle table definitions
│   │   ├── migrations/                         forward-only SQL
│   │   ├── rls.ts                              withTenant(), pools, policies
│   │   └── pools.ts                            app · worker · platform · replica
│   │
│   ├── components/
│   │   ├── ui/                                 shadcn primitives
│   │   ├── patterns/                           MoneyInput · DateInput · DataTable
│   │   ├── domain/                             AttendanceGrid · MarksGrid
│   │   └── layouts/
│   │
│   ├── messages/{en,bn}/                       namespaced per module
│   └── templates/documents/                    HTML/CSS per document kind
│
└── tests/
    ├── unit/                       domain rules, no IO
    ├── integration/                use cases against real PostgreSQL
    ├── generated/                  RLS isolation + permission matrix (§39.2)
    ├── e2e/                        ~15 journeys, both locales
    └── fixtures/
        ├── schools/                real school configs as assessment fixtures
        └── bangla/                 conjunct-heavy strings, real names
```

## 41.2 Why particular things sit where they do

| Placement | Reason |
|---|---|
| `worker/` beside `app/`, not inside | Both are transports over the same modules. A job handler and a route handler run identical business logic, with no API contract between them to drift |
| `rules/` as its own directory in `domain/` | These are the pure functions that get exhaustively tested. Separating them makes "is this testable without a database?" a structural question rather than a judgement call |
| `application/` = one file per business action | `recordPayment.ts` is findable. A `FinanceService` with thirty methods is not, and it grows a shared constructor that couples everything |
| `db/` outside `modules/` | Schema and migrations are global — one schema, one migration ([ADR-0003](../adr/0003-tenancy-model.md)). Repositories still live per module |
| `shared/` deliberately tiny | A growing shared kernel is the monolith re-forming inside the modules. Membership needs justification ([§9.5](../phase-1a/09-domain-boundaries.md)) |
| `assets/fonts/` vendored, checksummed | A distro font package changing across releases would silently alter shaping ([ADR-0009](../adr/0009-pdf-rendering.md)) |
| `templates/documents/` outside `modules/` | Tenant-overridable content, not code. Defaults live here; overrides live in the database |
| `tests/generated/` | Written by a generator from `pg_class`, not by hand — so a new table is covered the day it exists |
| Deferred modules **absent**, not stubbed | An empty module costs nothing; a half-built one costs maintenance |

## 41.3 Enforcement

Convention that is not enforced is decoration. Each rule maps to a check:

| Rule | Enforced by |
|---|---|
| `domain/` imports no framework or SDK | ESLint `no-restricted-imports`, zoned by path |
| Cross-module imports only via `index.ts` | ESLint boundaries plugin |
| No cycles between modules | Lint, build fails |
| DB access only through `withTenant` | Lint bans raw pool use outside `infrastructure/` |
| Every use case calls `authorize()` | Lint on exported `application/*` |
| Money never as `number` | Branded type + lint on float ops |
| Every user-visible string via `t()` | Lint bans bare JSX text |
| Tables carry RLS | Generated catalogue test ([§39.2](39-testing.md)) |

## 41.4 Naming

| Thing | Convention | Example |
|---|---|---|
| Use case file | `verbNoun.ts`, camelCase | `recordPayment.ts` |
| Domain entity | Singular noun | `enrolment.ts` |
| Table | `snake_case`, **singular** | `student`, `payment_allocation` |
| Event | Past tense | `PaymentRecorded` |
| Permission | `resource.action` | `fee.collect` |
| Message key | `module.area.item` | `fees.receipt.printed` |
| Job type | `queue.action` | `sms.payment_receipt` |
| Migration | `NNNN_short_description.sql` | `0042_add_late_fee_rule.sql` |
| Branch | `feat/<topic>-phase-N` | `feat/finance-phase-4` |

Singular table names are chosen so that `student` and `student_status_event` read
consistently, and because the ORM never pluralises anything on the developer's
behalf.
