/**
 * Bulk promotion. §14.5, FR-4.6.
 *
 * "The riskiest bulk operation in the product — it rewrites a whole cohort's
 * enrolment." Everything decidable without a database is decided here, so the
 * plan can be shown to a head teacher for confirmation before anything moves.
 *
 * NOTHING HERE TOUCHES MONEY. Arrears carry forward through `finance`, which
 * reads enrolment history; promotion that also settled dues would make "undo
 * the promotion" mean "reverse the invoices", and those are different
 * decisions made by different people.
 */

export const OUTCOMES = ['promoted', 'retained', 'transferred', 'withdrawn'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface Candidate {
  enrolmentId: string;
  studentId: string;
  /** Current roll, used only to keep the new order stable and familiar. */
  rollNo: number | null;
  nameEn: string;
}

export interface PromotionPlan {
  /** Rows to write into the next year, in roll-number order. */
  entries: ReadonlyArray<{
    studentId: string;
    sourceEnrolmentId: string;
    outcome: Extract<Outcome, 'promoted' | 'retained'>;
    /** The section for the NEW enrolment. */
    sectionId: string;
    rollNo: number;
  }>;
  /** Students leaving the cohort: no new enrolment, and a status change. */
  exits: ReadonlyArray<{
    studentId: string;
    sourceEnrolmentId: string;
    outcome: Extract<Outcome, 'transferred' | 'withdrawn'>;
  }>;
  counts: Record<Outcome, number>;
}

export type PlanVerdict =
  | { kind: 'ok'; plan: PromotionPlan }
  | { kind: 'empty' }
  | { kind: 'unknown_students'; ids: readonly string[] };

/**
 * Builds the plan.
 *
 * `defaultOutcome` applies to everyone not named in `exceptions`, which is what
 * makes this usable: a head teacher promotes a section of forty and names the
 * three who are repeating.
 *
 * ROLL NUMBERS ARE REASSIGNED, not carried over (FR-4.3). They are an attribute
 * of the enrolment precisely so that last year's roll 7 stays roll 7 in last
 * year's records while becoming roll 5 in the new section. Ordering by previous
 * roll keeps the new list recognisable to the teacher who will read it; a
 * student with no previous roll sorts last, by name.
 */
export function buildPromotionPlan(input: {
  candidates: readonly Candidate[];
  targetSectionId: string;
  /** Where retained students stay — normally the section they are already in. */
  retainSectionId: string;
  defaultOutcome: Extract<Outcome, 'promoted' | 'retained'>;
  exceptions: Readonly<Record<string, Outcome>>;
}): PlanVerdict {
  const { candidates, targetSectionId, retainSectionId, defaultOutcome, exceptions } = input;

  if (candidates.length === 0) return { kind: 'empty' };

  const known = new Set(candidates.map((c) => c.studentId));
  const unknown = Object.keys(exceptions).filter((id) => !known.has(id));
  // A named exception that is not in the section almost always means the wrong
  // section was chosen, which is exactly the mistake undo exists for.
  if (unknown.length > 0) return { kind: 'unknown_students', ids: unknown };

  const ordered = [...candidates].sort((a, b) => {
    if (a.rollNo !== null && b.rollNo !== null) return a.rollNo - b.rollNo;
    if (a.rollNo !== null) return -1;
    if (b.rollNo !== null) return 1;
    return a.nameEn.localeCompare(b.nameEn);
  });

  const entries: Array<{
    studentId: string;
    sourceEnrolmentId: string;
    outcome: 'promoted' | 'retained';
    sectionId: string;
    rollNo: number;
  }> = [];
  const exits: Array<{
    studentId: string;
    sourceEnrolmentId: string;
    outcome: 'transferred' | 'withdrawn';
  }> = [];
  const counts: Record<Outcome, number> = {
    promoted: 0,
    retained: 0,
    transferred: 0,
    withdrawn: 0,
  };

  let roll = 0;
  for (const c of ordered) {
    const outcome = exceptions[c.studentId] ?? defaultOutcome;
    counts[outcome]++;

    if (outcome === 'transferred' || outcome === 'withdrawn') {
      exits.push({ studentId: c.studentId, sourceEnrolmentId: c.enrolmentId, outcome });
      continue;
    }

    roll += 1;
    entries.push({
      studentId: c.studentId,
      sourceEnrolmentId: c.enrolmentId,
      outcome,
      sectionId: outcome === 'retained' ? retainSectionId : targetSectionId,
      rollNo: roll,
    });
  }

  return { kind: 'ok', plan: { entries, exits, counts } };
}

/**
 * The status a leaving student ends up in.
 *
 * A transfer out of the school and a withdrawal are the same lifecycle event —
 * the child stops attending — and the enrolment `outcome` is what records which
 * of the two it was.
 */
export function statusForExit(outcome: 'transferred' | 'withdrawn'): 'withdrawn' {
  // A switch rather than a constant: adding a third way of leaving should be a
  // compile error here, not a silent reuse of 'withdrawn'.
  switch (outcome) {
    case 'transferred':
    case 'withdrawn':
      return 'withdrawn';
  }
}
