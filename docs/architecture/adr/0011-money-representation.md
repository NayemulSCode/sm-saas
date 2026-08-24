# ADR-0011 — Money as integer minor units in `bigint`

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

The brief ranks correctness of financial records above every other property.
Fees, discounts, waivers, partial allocations, late fees, refunds and arrears
crossing academic years all involve arithmetic, and some involve division —
sibling discounts split across children, a payment allocated across four heads.

## Options

### A. `double precision` / JavaScript `number`
৳0.1 + ৳0.2 ≠ ৳0.3. Disqualifying, and not a theoretical concern: a school's
annual collection total drifting by a few poisha destroys trust in every report.

### B. `numeric(14,2)`
Exact in PostgreSQL and entirely defensible. The weakness is the boundary: it
arrives in JavaScript as a string or a `number`, and the first careless
`Number(row.amount)` reintroduces float arithmetic silently, in code that looks
correct.

### C. `bigint` minor units — poisha, where ৳1 = 100 poisha
Exact, compact, and — the actual reason — impossible to misuse accidentally. A
`bigint` cannot be treated as a rupee amount without a deliberate conversion,
because the number is 100× too large to look right.

## Decision

**C.** All amounts stored as `amount_minor bigint`, with a `currency char(3)`
column defaulting to `BDT`.

At the application boundary, a `Money` value object in the shared kernel is the
only permitted representation. It is constructed from integer minor units, has
no implicit conversion to `number`, and owns all arithmetic including rounding.

The deciding reason is the failure mode, not the precision. Option B is exact in
the database and fails at the language boundary in code that reviews cleanly.
Option C fails loudly and immediately.

Division rules live in `Money` and are unit-tested: banker's rounding, with the
remainder assigned to the first allocation so the parts always sum to the whole.
A ৳1,000 sibling discount split three ways is 33333 + 33333 + 33334 poisha, never
333.33 × 3.

## Consequences

**Makes easy:** exact arithmetic; safe JSON transport as a string; guaranteed
allocation sums; formatting in Bangla or Latin numerals from one place.

**Makes hard:** every amount needs formatting at the display boundary — mitigated
by `Money.format(locale)`. Percentage discounts require an explicit rounding
decision at each site, which is a feature: it forces the question to be answered
rather than defaulted.

**Forecloses:** currencies with other than two decimal places, and non-BDT
currencies generally, until the `currency` column is actually used. Acceptable —
the column exists so the change is additive.

## Revisit when

- A second currency is genuinely needed, which requires exchange-rate handling
  and a decision about the reporting currency — a larger change than the storage
  type.
- `bigint` range becomes a concern. It will not: ৳92 trillion is the ceiling.
