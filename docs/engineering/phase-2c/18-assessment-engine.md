# 18. Assessment — the engine (Phase 3d)

Everything in this document is a **pure function**: no database, no clock, no
randomness. Given the same scheme version and the same marks it returns the same
result. That is what makes it exhaustively testable against real school
configurations, which is the only way a two-person team can trust it
([ADR-0012](../../architecture/adr/0012-assessment-engine.md)).

Lives in `modules/assessment/domain/rules/`. Imports nothing but `shared/`.

## 18.1 The pipeline

```
scheme(version) ─┐
marks ───────────┼─→ evaluate()  → SubjectResult[]
context ─────────┘        │
                          ├─→ aggregate() → StudentResult
                          ├─→ rank()      → positions
                          └─→ promote()   → PromotionDecision
                                   ↓
                          result_snapshot (immutable, hashed)
```

Four functions, four files, each independently testable.

## 18.2 The rule vocabulary

Closed unions. A school needing something outside them gets a **reviewed
vocabulary extension**, not a branch in application code.

```ts
// modules/assessment/domain/rules/vocabulary.ts

export type AggregationRule =
  | { kind: 'weighted_sum' }                              // Σ(score/full × weight)
  | { kind: 'average' }
  | { kind: 'best_of_n'; n: number }                      // best n of m exams
  | { kind: 'weighted_terms'; weights: Record<TermId, number> };

export interface OptionalSubjectRule {
  /** Marks above this percentage of full marks may contribute. */
  thresholdPercent: number;
  /** …but only the part above this grade point. */
  contributesAbovePoints: number;
  /** …capped at this many points added to the aggregate. */
  maxContributionPoints: number;
  /** Whether a failed optional subject can fail the whole result. */
  canCauseOverallFail: boolean;
}

export type TieBreak =
  | { by: 'total' }
  | { by: 'subject'; subjectId: SubjectId }               // e.g. Maths decides
  | { by: 'dateOfBirth'; order: 'older_first' }
  | { by: 'shared' };                                     // joint positions

export interface RankingRule {
  scope: 'section' | 'class' | 'campus' | 'school';
  tieBreak: TieBreak[];
  excludeFailing: boolean;
}

export interface PromotionRule {
  mode: 'automatic' | 'manual';
  minAttendancePercent?: number;
  maxCarryForwardSubjects: number;
  requiresApprovalRole?: Permission;
}
```

`{ by: 'shared' }` as a terminal rule matters: some schools genuinely award joint
positions, and forcing a strict total order invents a distinction the school did
not make — which a parent will notice.

Every rule object is validated by a Zod schema on write, so a malformed rule
cannot reach the engine.

## 18.3 `evaluate` — one subject, one student

```
evaluate(scheme, subject, marks, ctx) -> SubjectResult:

    components = scheme.componentsFor(subject)

    if any component mark has state 'incomplete':
        return SubjectResult(status = INCOMPLETE)      # blocks publication

    effectiveFullWeighted = 0
    earnedWeighted        = 0
    failedComponents      = []

    for c in components:
        m = marks[c.id]

        if m.state == 'exempt':
            continue                    # OUT OF THE DENOMINATOR — the student is
                                        # graded on the remaining components, not
                                        # penalised for the missing one

        effectiveFullWeighted += c.fullMarks × c.weightPercent

        # An ABSENT mark contributes zero TO THE ARITHMETIC, here, at computation
        # time — while the stored record stays 'absent' forever. The report card
        # prints AB, and the tabulation sheet can tell "scored nothing" from
        # "was not there". Systems that collapse these are unrecoverable.
        score = (m.state == 'entered') ? m.score + adjustmentsFor(m) : 0

        earnedWeighted += score × c.weightPercent

        if c.isRequiredToPass:
            if m.state != 'entered' or m.score < c.passMark:
                failedComponents.append(c)

    if effectiveFullWeighted == 0:                     # everything exempt
        return SubjectResult(status = FULLY_EXEMPT)

    percent = earnedWeighted / effectiveFullWeighted × 100
    band    = scheme.gradeScale.bandFor(percent)
    passed  = not band.isFailing and failedComponents.isEmpty()

    return SubjectResult(percent, band, passed, failedComponents,
                         wasAbsent = any(m.state == 'absent'))
```

Three lines carry the whole design:

- **`continue` on exempt** removes the component from the denominator.
- **`score = 0` on absent** applies only inside the arithmetic, never to storage.
- **`failedComponents`** is what makes an independent CQ/MCQ pass mark real.

`FULLY_EXEMPT` is a distinct outcome, not a 0% fail. A student exempt from every
component of a subject has no result for it, and the report card must say so.

## 18.4 `aggregate` — all subjects, one student

```
aggregate(scheme, subjectResults, ctx) -> StudentResult:

    if any result is INCOMPLETE:
        return StudentResult(status = INCOMPLETE)

    mandatory = results where subject.isMandatory
    optional  = results where subject.isFourthSubject

    total   = Σ mandatory.totalMarks
    percent = weighted by scheme.aggregationRule

    gpa = mean(mandatory.gradePoint)              # for kind = 'gpa'

    if scheme.optionalSubjectRule and optional exists:
        r = scheme.optionalSubjectRule
        if optional.percent >= r.thresholdPercent:
            bonus = min(optional.gradePoint - r.contributesAbovePoints,
                        r.maxContributionPoints)
            gpa += max(bonus, 0)

    failedSubjects = mandatory where not passed
    if r?.canCauseOverallFail and optional exists and not optional.passed:
        failedSubjects.append(optional)

    isPassed = failedSubjects.isEmpty()
    if not isPassed: gpa = scheme.gradeScale.failingPoint     # usually 0.00

    return StudentResult(total, percent, gpa, grade, isPassed, failedSubjects)
```

The last clause is a real convention and easy to miss: under a GPA scale, failing
any mandatory subject usually forces the aggregate to the failing point
regardless of the average. It is expressed as scale data (`failingPoint`), not
hardcoded.

## 18.5 `rank`

```
rank(studentResults, rule) -> Map<StudentId, position>:

    eligible = rule.excludeFailing ? results where isPassed : results
    # INCOMPLETE results are always excluded — not ranked last.

    sort eligible by rule.tieBreak, in order:
        'total'       → descending total
        'subject'     → descending that subject's marks
        'dateOfBirth' → older first
        'shared'      → stop; remaining ties share a position

    assign positions 1..n; tied groups under 'shared' share the lowest position
    and the next position skips (1, 2, 2, 4)
```

Ranking runs **after every snapshot in the scope exists**, because a position
depends on every other student. It is therefore a second pass over the tabulation
job, not part of `evaluate`.

## 18.6 `promote`

```
promote(studentResult, attendancePercent, rule) -> PromotionDecision:

    if rule.mode == 'manual':
        return PENDING_MANUAL

    if rule.minAttendancePercent and attendancePercent < rule.minAttendancePercent:
        return RETAINED(reason = 'attendance')

    if studentResult.failedSubjects.length == 0:
        return PROMOTED(carryForward = [])

    if studentResult.failedSubjects.length <= rule.maxCarryForwardSubjects:
        return PROMOTED(carryForward = studentResult.failedSubjects)

    return RETAINED(reason = 'failed_subjects')
```

`attendancePercent` comes from `calendar.workingDayCount()` as its denominator
([§14.4](../phase-2b/14-calendar-attendance.md)). The engine **refuses to compute
an automatic promotion** if the working-day table is not materialised for the
year — a promotion decided against a wrong denominator is worse than no decision.

## 18.7 The computation hash

```ts
computationHash = sha256(canonicalJson({
  schemeVersion,
  rules:      { aggregation, optionalSubject, ranking },
  gradeBands: [...],
  components: [{ id, fullMarksMinor, weightPercent, passMarkMinor, required }],
  marks:      [{ componentId, state, scoreMinor }].sorted(),
  adjustments:[{ markId, kind, deltaMinor }].sorted(),
}))
```

Stored on `result_snapshot`. Two uses, both operational:

1. **Recompute detection.** Re-running tabulation and getting a different hash
   means an input changed. That is either legitimate (an adjustment) or a bug —
   either way it is surfaced, not silent.
2. **Dispute settlement.** A parent challenging a result gets the exact inputs
   the number came from.

Canonical JSON — sorted keys, no whitespace, `bigint` as decimal strings — so the
hash is stable across Node versions and machines.

## 18.8 Tabulation as a job

```
tabulate(examId):
  guard: exam.status == 'marks_locked'          # locking is a precondition
  guard: no marks with state 'incomplete'

  chunk by section (≈50 students):
    for each student:
      subjectResults = subjects.map(s => evaluate(scheme, s, marks, ctx))
      studentResult  = aggregate(scheme, subjectResults, ctx)
      write result_snapshot (version = next, hash, payload)

  second pass: rank() over the configured scope, update positions
  exam.status → 'tabulated'
  emit ResultsTabulated
```

Chunked and re-enqueued with a per-tenant concurrency cap, like every other bulk
job ([§7.4](../../architecture/phase-1a/07-multi-tenancy.md)).

Sizing: 400 students × 12 subjects × 5 components = 24,000 marks and 4,800
subject results. Small, pure and parallelisable —
[OQ-14](../../architecture/phase-1a/13-open-questions.md) measures it rather than
assuming.

## 18.9 Revision after publication

```
reviseResults(examId, reason):
  authorize('result.revise')                    # dangerous: reason required
  recompute → write snapshots at version n+1
  set version n .superseded_by_id = version n+1
  exam.status → 'revised'
  emit ResultRevised → notification + re-render documents
```

Version *n* is **never edited**. Both remain retrievable, so a guardian who
screenshotted the original can be shown exactly what changed and why — which is
the entire reason for invariant 5.

## 18.10 Testing

This module's tests are the deliverable as much as the code.

| Suite | Content |
|---|---|
| **Golden configurations** | Two or three **real pilot school schemes**, with real mark sets and their known-correct outputs. The highest-value tests in the project |
| Component pass rules | 70 total with CQ below its pass mark ⇒ **fail** |
| Absent handling | Absent contributes 0 to arithmetic; stored state stays `absent`; report card renders `AB`; never 0 anywhere |
| Exempt handling | Denominator reduced, not penalised; all-exempt ⇒ `FULLY_EXEMPT` |
| Incomplete handling | Blocks tabulation and publication; excluded from ranking |
| Optional subject | At threshold, above it, below it, capped |
| Ranking | Ties under each tie-break; `shared` produces 1, 2, 2, 4 |
| Promotion | At the attendance boundary; at `maxCarryForwardSubjects` and one over |
| Hash stability | Same inputs ⇒ same hash across runs; any input change ⇒ different hash |
| **Property** | `Σ component contributions == total`; percent ∈ [0,100]; a passed student has no failed mandatory subject |

Row 1 cannot be written until the pilot supplies the configurations. That is the
concrete meaning of [§17.9](17-assessment-schema.md) — the *engine* is
specifiable now, its *validation fixtures* are not.

## 18.11 What the engine refuses to do

| Not supported | Instead |
|---|---|
| Per-school formula scripting | Extend the vocabulary, reviewed and versioned |
| Computing while marks are unlocked | Locking is a precondition |
| Publishing with `incomplete` marks | Resolve them first |
| Ranking students with incomplete results | Excluded, not ranked last |
| Editing a published snapshot | Revision creates version n+1 |
| Auto-promotion without a working-day denominator | Refuses and says why |
| Deriving a score from an absent mark | Structurally impossible ([§17.4](17-assessment-schema.md)) |
