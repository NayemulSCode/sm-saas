# ADR-0031 — Pin to latest stable at scaffold time, with a documented upgrade policy

**Status:** Accepted
**Date:** 2026-08-25
**Deciders:** Phase 3a scaffold, at the project owner's direction

## Context

Phase 1 and Phase 2 were written between August 2026 and now, and they name
versions — "Next.js 15", "PostgreSQL 16+". Those numbers were current when the
prose was written and are already behind.

Starting a greenfield codebase on a stale major is the worst of both worlds: the
migration cost is paid anyway, later, with more code to migrate, and the project
spends its first year on a version approaching end of life.

Several current majors are **ahead of what the Phase 2 documents assumed** —
TypeScript 7, Zod 4, ESLint 10, TanStack Table v9, pg-boss 12 — so this is not
a cosmetic bump.

## Options

### A. Build on the versions named in the Phase 2 documents
Consistent with the prose. Starts a four-month build on a deliberately old base
and guarantees a migration inside year one.

### B. Pin latest stable at scaffold time, verified by actually installing
Current for the whole of Phase 3. Costs: the Phase 2 code idioms written against
older majors need adjusting, and some ecosystem packages may lag a very new major.

### C. Latest stable except where a major is less than N months old
Safer on paper. In practice it means an arbitrary cutoff and a mixed baseline
that is harder to reason about than either extreme.

## Decision

**B — pin the latest stable release of every dependency at scaffold time**, taken
from the registry rather than from memory, and **verified by installing and
running typecheck, lint and tests** before the baseline is committed.

Version numbers appearing in Phase 1 and Phase 2 prose are **indicative of the
technology choice, not the version**. This ADR is the authority for versions.
Those documents are not rewritten — the decisions they record (Next.js over
NestJS, Drizzle over Prisma, Postgres, pg-boss) are unchanged.

### Baseline — resolved 2026-08-25 from the npm registry

| Layer | Package | Version |
|---|---|---|
| Runtime | Node.js | **24 LTS** ("Krypton", 24.19.0) |
| Package manager | pnpm | 10.32.1 |
| Framework | `next` | **16.3.2** |
| UI | `react` / `react-dom` | 19.2.8 |
| Language | `typescript` | **6.0.3** — see the exception below |
| ORM | `drizzle-orm` / `drizzle-kit` | 0.45.2 / 0.31.10 |
| Driver | `pg` | 8.23.0 |
| Validation | `zod` | **4.4.3** |
| Jobs | `pg-boss` | **12.28.0** |
| i18n | `next-intl` | 4.13.7 |
| Styling | `tailwindcss` | 4.3.3 |
| Tables | `@tanstack/react-table` / `react-virtual` | **9.1.2** / 3.14.10 |
| Forms | `react-hook-form` | 7.86.0 |
| Tests | `vitest` / `@playwright/test` | 4.1.11 / 1.62.1 |
| Lint | `eslint` / `typescript-eslint` | **10.9.1** / 8.68.0 |
| Hashing | `@node-rs/argon2` | 2.1.0 |
| Ids | `ulidx` | 2.4.1 |
| Storage | `@aws-sdk/client-s3` | 3.1117.0 |
| Errors | `@sentry/nextjs` | 10.71.0 |
| Database | PostgreSQL | **18-alpine** |

Bold entries are majors **ahead of what the Phase 2 documents assumed**. Their
code idioms are adjusted in the scaffold.

### Exception: TypeScript pinned back to 6.0.3

`typescript` 7.0.2 is the current `latest`, and it was tried first. It
**typechecks the codebase cleanly** under full strict mode — but
`typescript-eslint@8.68.0` refuses to load against it:

```
Error: typescript-eslint does not support TS 7.0.
```

It points at running TS 6 side by side, and at an open issue tracking support
for TS >= 7.1.

The lint boundary rules **are** the architecture
([ADR-0001](0001-modular-monolith.md)) — they are the mechanism that keeps the
domain layer pure and stops `app/*` reaching into `db/*`. Compiler speed is a
convenience. So lint wins: TypeScript is pinned to **6.0.3**, the latest stable
6.x, which typechecks identically and keeps the linter working.

A side-by-side install (TS 7 for `tsc`, TS 6 for the linter) was rejected: two
TypeScript versions in one repository is precisely the kind of thing that is
baffling at 02:00 to a team of two.

**Revisit** when `typescript-eslint` ships TS 7 support — then move to 7.x in a
single deliberate commit and delete this exception.

Discovered by *running* the install rather than asserting the baseline, which is
the reason this ADR requires verification.

### Node 24 LTS, not 26 current

Production runs an **LTS** line. Node 26 is the current release and will become
LTS later; running current in production means tracking a moving target with no
long-term security window, which a team of one or two cannot absorb.

### Upgrade policy from here

| Change | Policy |
|---|---|
| Patch | Automatic, weekly, merged if CI is green |
| Minor | Batched monthly, merged if CI is green |
| **Major** | Deliberate, one at a time, on its own branch, with the changelog read |
| Security advisory | Immediately, at any level |
| Node LTS line | Move within one quarter of a new LTS becoming active |
| PostgreSQL major | Move within one year, rehearsed against a restored dump first |

Exact versions are pinned in `package.json` (no `^`, no `~`) and enforced by the
lockfile. Reproducible builds matter more than automatic drift when the same two
people are also the on-call rotation.

## Consequences

**Makes easy:** the whole of Phase 3 on a current base; no forced migration in
year one; security patches on supported lines; a single documented source of
truth for versions.

**Makes hard:** several Phase 2 code idioms need adjusting (Zod 4 API, ESLint 10
flat config, TanStack Table v9, pg-boss 12). Very new majors carry a thinner
body of community answers when something breaks — accepted, and the reason the
baseline is *verified by running it* rather than asserted.

**Forecloses:** nothing. Any individual package can be pinned back a major with a
recorded reason.

## Revisit when

- A pinned major proves unworkable during Phase 3a — pin back one major, record
  the reason here, and open an issue to retry.
- A new Node LTS line becomes active (move within one quarter).
- Annually, as a deliberate dependency-health review rather than a drift.
