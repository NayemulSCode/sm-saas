# ADR-0028 — Bottom-heavy tests, with five non-negotiable suites

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1C

## Context

Two people cannot maintain a large test suite **and** ship fourteen modules.
Meanwhile, at 1–2 developers there is rarely a second reviewer — so **CI is the
code review**, and anything that must not regress has to be a failing build
rather than a reviewer's memory.

## Options

### A. High coverage everywhere
Uniform effort across code of wildly different consequence. Unaffordable, and it
spends the most effort where the least is at stake.

### B. E2E-heavy
Tempting for a small team — a few tests covering whole journeys. Slow, flaky, and
flaky tests get disabled, which is worse than not having them.

### C. Bottom-heavy, with a named set of suites that may never be skipped

## Decision

**C.**

The pyramid is deliberately bottom-heavy because the design made it possible: the
assessment engine, the calendar resolver and money arithmetic are **pure
functions** ([ADR-0012](0012-assessment-engine.md),
[ADR-0013](0013-calendar-as-infrastructure.md)) that can be tested exhaustively in
milliseconds with no database.

Five suites are non-negotiable. Everything else is negotiable under deadline
pressure; these are not:

| # | Suite | Why |
|---|---|---|
| 1 | **Tenant isolation — generated from `pg_class`** | The most valuable test in the repository. A developer cannot add a table and forget its test: the test appears automatically and fails until the policy exists |
| 2 | **Money arithmetic** | Including a **concurrent** gapless-receipt test — the only way to prove the `FOR UPDATE` serialisation holds |
| 3 | **Assessment correctness** | `ABSENT` never becomes 0; `EXEMPT` reduces the denominator; determinism via `computation_hash` |
| 4 | **Calendar resolution** | Suppression before precedence; effective dating; retroactive holiday recompute |
| 5 | **Authorization matrix** | Table-driven over role × permission × scope; scope narrowed in SQL, not the UI |

Supporting decisions:

- **Every integration test seeds two tenants.** A test that passes with one tenant
  proves nothing about isolation.
- **Fixtures use real school configurations and real Bangla names**, never
  `foo`/`bar` — layout and shaping bugs only appear with real text.
- **≤ 10 minutes in CI**, or the suite stops being run.
- Coverage gates: 90% on `domain`, 70% overall — as a smoke detector, not a goal.
  A 95%-covered module without a concurrency test on receipt numbering is worse
  tested than a 70%-covered one that has it.

## Consequences

**Makes easy:** confidence in the parts that are unrecoverable when wrong; fast
feedback; refactoring the domain layer freely.

**Makes hard:** CRUD paths and UI states are thinly covered — accepted, because
types, Zod schemas, database constraints and the audit trail carry that risk.
Generated tests need a generator to maintain. E2E stays deliberately small (~15
journeys), so some regressions will reach staging rather than being caught in CI.

**Forecloses:** nothing.

## Revisit when

- A production defect class appears that none of the five suites would have
  caught — add a sixth rather than raising coverage everywhere.
- CI exceeds 10 minutes and people start bypassing it.
- The team grows enough that a second reviewer exists, which changes what CI has
  to substitute for.
