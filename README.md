# sm-saas

Multi-tenant School Management SaaS for Bangladesh — kindergarten, primary and
secondary schools, Bangla- and English-medium, single-campus and multi-campus.

Bilingual at launch: **English** (`en`) and **বাংলা** (`bn`, `bn-BD`).
Currency **BDT**. Platform timezone **Asia/Dhaka**.

> **Status: Phase 1 complete. Phase 2A + 2B complete; 2C follows the pilot.** There is no
> application code in this repository yet, by design. Phase 1 produces the
> architecture; Phase 2 the engineering specification; Phase 3 the
> implementation.
> Start at the **[decision summary](docs/architecture/phase-1c/46-decision-summary.md)**,
> then the **[engineering spec](docs/engineering/README.md)** for what Phase 3a
> is built from.

## Start here

| Document | What it answers |
|---|---|
| [Decision summary](docs/architecture/phase-1c/46-decision-summary.md) | Every settled decision, fixed number and deferred item — the Phase 2 handoff |
| [Executive summary](docs/architecture/phase-1a/01-executive-summary.md) | The recommendation, the disagreements with the brief, the MVP cut |
| [Constraints](docs/architecture/CONSTRAINTS.md) | The values every trade-off is argued against |
| [ADR log](docs/architecture/adr/README.md) | Every significant decision, with its revisit trigger |
| [Engineering spec](docs/engineering/README.md) | Phase 2: schema DDL, RLS harness, API contracts, conventions |
| [External actions](docs/EXTERNAL-ACTIONS.md) | The four long-lead items engineering cannot produce — lawyer, BTRC, pricing, latency |
| [Open questions](docs/architecture/phase-1a/13-open-questions.md) | What is assumed, and what breaks if the assumption is wrong |
| [Contributing](CONTRIBUTING.md) | Branching, commits, PRs, how ADRs are amended |
| [CLAUDE.md](CLAUDE.md) | Working context: the non-negotiables, vocabulary and rules, in one page |

## The shape of the system

A **modular monolith**: one Next.js application, one PostgreSQL database, one
background worker, on a single VPS in Singapore under Docker Compose. Tenants
share a schema and are isolated by PostgreSQL **row-level security**, so a
forgotten `WHERE` clause returns zero rows rather than another school's students.

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router), TypeScript strict |
| Domain layer | Framework-free TypeScript modules |
| Database | PostgreSQL 16+, RLS tenant isolation, streaming replica |
| Data access | Drizzle ORM, SQL migrations |
| Jobs | pg-boss — transactional enqueue, no dual-write |
| UI | shadcn/ui + Radix + Tailwind v4, TanStack Table/Virtual |
| i18n | next-intl, `en` + `bn` |
| PDF | Headless Chromium with pinned Noto Bengali fonts |
| Files | Cloudflare R2, private buckets, signed URLs |
| Hosting | Hetzner/DO VPS, Singapore, Docker Compose |

Reasoning and rejected alternatives:
[technology review](docs/architecture/phase-1a/05-technology-review.md).

## Non-negotiables

These outrank every other consideration in this codebase, including performance
and elegance:

1. **Financial and examination records are correct.** Money is integer poisha,
   never a float. Receipt numbers are gapless per school per fiscal year.
   `ABSENT` is never coerced to zero. Nothing is hard-deleted.
2. **Cross-tenant leakage is structurally impossible**, not merely unlikely.
   Every tenant-owned table has RLS enabled *and forced*, verified in CI.
3. **Every mutation is audited** with actor, tenant, timestamp and reason.
4. **It runs on a teacher's low-end Android phone over 3G**, offline where it
   has to.

## Repository layout

```
docs/architecture/
  CONSTRAINTS.md        the §1 values, with assumptions marked
  phase-1a/             foundations — stack, tenancy, identity, data model
  adr/                  one file per decision, with a revisit trigger
scripts/check-docs.sh   link, ADR-index and secret-leak checks — runs in CI
.github/workflows/      CI
```

Application code arrives in Phase 3 and will follow the module map in
[§9](docs/architecture/phase-1a/09-domain-boundaries.md).

## Licence

Proprietary. © Codeware Ltd. All rights reserved.
