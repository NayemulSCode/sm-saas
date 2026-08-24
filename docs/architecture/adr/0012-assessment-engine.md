# ADR-0012 — Assessment as a versioned declarative rules engine

**Status:** Accepted
**Date:** 2026-08-24
**Deciders:** Architecture, Phase 1A

## Context

The highest-risk module in the system. Every school believes its grading rules
are standard, and every school's differ: component weights, separate pass marks
for CQ and MCQ, GPA versus letter versus pass/fail, optional-subject
contribution thresholds, tie-break rules for merit position, promotion rules
with carry-forward, and — within one platform — marks-based and competency-based
assessment side by side.

If this becomes screens and branching logic, the business stops scaling: every
new school is a code change, and the team is 1–2 people.

There is a second, sharper risk. Results are published to parents. A result that
changes after publication without explanation, or an absent student recorded as
scoring zero, is a reputational failure for the school and therefore for the
platform.

## Options

### A. Marks tables plus per-school branching in application code
Fast for school one. Unmaintainable by school ten. Rejected outright.

### B. A general expression language, evaluated at runtime
Maximum flexibility. Introduces a sandbox, an authoring UI nobody can use, and
an evaluation path that cannot be exhaustively tested. Over-engineered for the
actual variation, which is broad but shallow.

### C. Declarative configuration over a fixed vocabulary of rule types,
evaluated by a versioned pure function
Schemes, components, grade scales, aggregation, optional-subject, ranking and
promotion rules are all data with known shapes. The engine is
`evaluate(scheme, marks, context) → SubjectResult[]` with no IO.

## Decision

**C.**

| Element | Representation |
|---|---|
| Grade scale | `grade_scale` + `grade_band` rows |
| Subject components | `assessment_component` rows: full marks, weight, own pass mark, required-to-pass flag |
| Aggregation | `assessment_scheme.aggregation_rule` jsonb over a fixed vocabulary: `weighted_sum`, `best_of_n`, `average` |
| Optional subject | `optional_subject_rule` jsonb: threshold, contribution, cap |
| Ranking | `ranking_rule` jsonb: scope and an ordered tie-break list |
| Promotion | `promotion_rule` jsonb: minimum attendance, maximum carry-forward subjects |
| Competency | `competency` + `competency_assessment`, running **parallel** to marks, not instead of them |

Three properties are non-negotiable and are enforced structurally:

**1. `ABSENT` is never zero.** `mark.state` is one of `entered`, `absent`,
`exempt`, `incomplete`, and a `CHECK` constraint makes it impossible to store a
score alongside a non-entered state or a state of `entered` without a score
([§10.11](../phase-1a/10-database-architecture.md)). An absent student cannot be
*represented* as a zero, so no code path can produce one.

**2. The engine is a pure function.** No database access, no clock, no
randomness. Given the same scheme version and the same marks it returns the same
result, which makes it exhaustively unit-testable against real school
configurations — the only way a two-person team can trust it.

**3. Published results are immutable snapshots.** `result_snapshot` stores the
computed output with `scheme_version` and a `computation_hash` over the inputs.
A revision writes version 2 and points version 1 at it. Both remain retrievable,
so a parent who screenshotted the original can always be shown what changed and
why.

## Consequences

**Makes easy:** onboarding a school with unusual rules — configuration, not
code. Testing. Explaining a result. Reversible publication. Supporting
kindergarten descriptive reporting and Class 5 marks in one tenant.

**Makes hard:** the configuration UI is genuinely difficult, and it is where
most of this module's effort will go. A school with a rule outside the
vocabulary needs a vocabulary extension — a deliberate, reviewed change rather
than a quick branch. Storing snapshots duplicates data, which is the correct
trade.

**Forecloses:** arbitrary per-school formulas. Deliberate — that is the failure
mode being designed out.

## Revisit when

- Three or more schools need a rule the vocabulary cannot express. Extend the
  vocabulary; do not add branching. Option B returns only if extensions become
  routine rather than rare.
- Result computation for a 400-student, 12-subject exam exceeds a few seconds
  ([OQ-14](../phase-1a/13-open-questions.md)).
