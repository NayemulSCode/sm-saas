# ADR-0001 — Modular monolith with a framework-free domain layer

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

Fourteen substantial modules (§5 of the brief), a team of **1–2 developers with
no dedicated DevOps**, and an ARPU around US$50/school/month. The system must
plausibly reach thousands of tenants without being rewritten, but must be
operable by one person tonight.

## Options

### A. Microservices per bounded context
Independent scaling and clear boundaries. Costs *n* deploy pipelines, *n*
on-call surfaces, and distributed transactions across the fee ledger — where
correctness is the top-ranked requirement. Unstaffable at this team size.

### B. Single-tier monolith
Fastest to write. Boundaries erode within months; the assessment engine ends up
coupled to route handlers and the seams in §6.6 never exist.

### C. Modular monolith, domain layer independent of the framework
One deployable, one database, explicit module boundaries enforced by lint. The
domain imports nothing from Next.js, Drizzle or any SDK.

## Decision

**C.** One Next.js application plus one worker process, with `modules/*/domain`
kept free of framework and infrastructure imports, and `modules/*/index.ts` as
each module's only public surface.

The deciding reason: it is the only option that keeps *both* the cost of a
monolith and the option value of a split. Extracting a module later becomes a
packaging change rather than a rewrite, and that option costs nothing today
beyond discipline.

## Consequences

**Makes easy:** local development, one deploy, one transaction across modules,
refactoring across boundaries, unit-testing the assessment and calendar engines
with no database.

**Makes hard:** independent scaling of one module; enforcing boundaries when
someone is in a hurry — which is why the lint rule is a build failure and not a
convention.

**Forecloses:** nothing structurally. Per-module technology choice is
foreclosed in practice, which is acceptable and arguably desirable at this size.

## Revisit when

- Team exceeds **6 developers** and merge contention becomes routine, **or**
- A single module's resource profile destabilises the host — Chromium PDF
  rendering is the likely first case, and it is already an extractable process,
  **or**
- A module needs an independent release cadence for a customer commitment.

The extraction order and difficulty are in
[§6.6](../phase-1a/06-architecture-overview.md).
