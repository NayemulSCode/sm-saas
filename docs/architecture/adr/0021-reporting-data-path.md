# ADR-0021 — Staged reporting path: primary → replica → rollups → warehouse

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1B

## Context

§5.26 asks where reports read from and, critically, for the **trigger metric**
that moves between stages. Reporting is where a small team most easily
over-builds: a warehouse feels responsible and is, in practice, an ETL pipeline
that breaks silently with nobody rostered to notice.

## Options

### A. Read the primary forever
Simplest. Eventually a heavy report competes with the fee-collection counter for
CPU during office hours.

### B. Build an analytical store now
Answers questions nobody is asking yet, at the cost of a pipeline to operate.

### C. Staged path with explicit trigger metrics

## Decision

**C.**

| Stage | Read from | Move on when |
|---|---|---|
| **1 — MVP** | Primary, with `statement_timeout` and keyset pagination | Report queries exceed **10% of primary CPU**, or interactive p95 degrades during report runs |
| **2** | The streaming replica that already exists for financial durability | Replica lag during reports exceeds **30 s**, or one report exceeds **60 s** |
| **3** | Nightly materialised rollups: daily collection, monthly attendance, exam aggregates | Rollup maintenance exceeds ~**2 h** nightly, or ad-hoc analytical questions become routine |
| **4** | Separate analytical store (ClickHouse/DuckDB), CDC or nightly export | — |

Stage 2 is nearly free: the replica was already justified by per-transaction
synchronous commit for money
([§4.5](../phase-1a/04-non-functional-requirements.md)), so reporting is a second
return on the same US$5–8/month. It is the expected home for most of year one.

Supporting decisions:

- Reports are **declarative definitions** with a declared permission, a Zod
  parameter schema and a parameterised query — so a report cannot exist without
  an access rule, and scope narrowing happens in SQL rather than in the UI.
- RLS applies underneath regardless, so even a buggy report cannot cross tenants.
- A report whose estimated rows exceed the interactive limit is **promoted to a
  background job** rather than allowed to run and time out.

## Consequences

**Makes easy:** no new infrastructure at launch; a clear, measurable path when
load arrives; reporting isolated from transactional load by a connection string
change.

**Makes hard:** stage 3 rollups introduce staleness that must be communicated in
the UI ("as of 02:00"). Ad-hoc analytical questions are awkward until stage 3.

**Forecloses:** nothing. Each stage is additive.

## Revisit when

Any trigger metric in the table above is hit. They are deliberately expressed as
numbers so the decision is made by a dashboard rather than by an opinion in a
planning meeting.
