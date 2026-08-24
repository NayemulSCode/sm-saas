# ADR-0024 — Three-phase import: stage, validate, all-or-nothing commit

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1B

## Context

Schools switch software in November–January or not at all, and they arrive with
Excel files ([§2.3](../phase-1a/02-domain-analysis.md)). Import quality decides
whether onboarding takes two days or three weeks — which, at 1–2 people, decides
how many schools can be onboarded per season. It is a **sales requirement**, not
a feature.

## Options

### A. Direct import — parse and write
Simple. A file with 43 problems produces a half-populated tenant and no way back.

### B. Validate then write, in one pass
Better, but validation and commit see different states, and partial failure
mid-write still leaves a mess.

### C. Stage → validate (dry run) → all-or-nothing commit

## Decision

**C.**

| Phase | Writes | Reversible |
|---|---|---|
| Stage | `import_row` only | Delete the batch |
| Validate | Nothing | n/a |
| Commit | Real entities, one transaction per batch | Compensating batch action |

Staging is not an optimisation. It is what lets an operator sit with a school's
office manager, run the file, show them everything wrong, fix it together and
re-run — without ever having written a partial record into the live system.

Supporting decisions:

- **Errors are reported per cell**, localised, with row number and original
  value, and downloadable as an annotated copy of the original spreadsheet —
  because the person fixing it works in Excel, not in the app.
- **Three tiers**: error blocks commit; warning requires acknowledgement;
  info is reported. All surfaced together so problems are fixed in one pass.
- **ULIDs are generated during staging**, so the entire object graph — student,
  guardians, enrolment, opening dues — is built and cross-referenced before any
  write ([ADR-0016](0016-identifier-strategy.md)). This is a concrete payoff of
  application-generated ids.
- **Duplicate detection produces a review queue, never an automatic merge.**
  Merging two students merges their dues.
- **Opening dues is a first-class import kind.** It is the row everyone forgets
  and the one that blocks go-live: without it, every fee report is wrong from day
  one. Imported as carry-forward invoices, structurally identical to
  system-generated arrears.
- **Export uses the same code path** as tenant offboarding and single-tenant
  restore ([§7.5](../phase-1a/07-multi-tenancy.md)), so the emergency path is
  exercised continuously rather than only in emergencies.

## Consequences

**Makes easy:** confident onboarding sessions; re-runnable imports; a complete
audit trail from row to entity; undo of a committed batch where nothing has been
built on top of it.

**Makes hard:** two representations of the same data during staging; a batch size
ceiling (5,000 rows) with larger files split; per-tenant concurrency caps so an
import cannot starve interactive work.

**Forecloses:** partial commit of a validated batch. Half-imported cohorts are
worse than none — fix the file and re-run.

## Revisit when

- A tenant genuinely needs a batch beyond the size ceiling in one atomic unit.
- Duplicate-detection precision proves poor enough that the review queue becomes
  the onboarding bottleneck — then invest in transliteration normalisation, not
  in automatic merging.
