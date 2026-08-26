/**
 * The student lifecycle. FR-4.1.
 *
 *   applicant → admitted → active → on_leave → withdrawn → alumni
 *
 * Pure, and exhaustive on purpose. The `CHECK` constraint on `student.status`
 * says which values exist; it says nothing about which moves between them are
 * legal, and "active → applicant" is representable in SQL while being nonsense
 * in a school.
 */

export const STUDENT_STATUSES = [
  'applicant',
  'admitted',
  'active',
  'on_leave',
  'withdrawn',
  'alumni',
] as const;

export type StudentStatus = (typeof STUDENT_STATUSES)[number];

/**
 * Where each status may go.
 *
 * The two that need explaining:
 *
 * `withdrawn → active` is READMISSION (FR-4.7). A family that leaves in March
 * and returns in July is common, and forcing a second person record would split
 * the child's history and their siblings' discount.
 *
 * `alumni` is TERMINAL. Someone who completed the school and comes back is a
 * new admission, not a resurrection — their old record is what a transfer
 * certificate is issued from a decade later (§10.8).
 */
const LEGAL: Record<StudentStatus, readonly StudentStatus[]> = {
  // A rejected or lapsed applicant is withdrawn, not deleted.
  applicant: ['admitted', 'withdrawn'],
  admitted: ['active', 'withdrawn'],
  active: ['on_leave', 'withdrawn', 'alumni'],
  on_leave: ['active', 'withdrawn', 'alumni'],
  withdrawn: ['active', 'alumni'],
  alumni: [],
};

export type TransitionVerdict =
  | { kind: 'ok' }
  | { kind: 'same_status' }
  | { kind: 'illegal'; from: StudentStatus; to: StudentStatus; legal: readonly StudentStatus[] };

export function evaluateTransition(
  from: StudentStatus,
  to: StudentStatus,
): TransitionVerdict {
  // Not an error worth failing a bulk run over, but not a no-op either: it must
  // not write a status event claiming a change that did not happen.
  if (from === to) return { kind: 'same_status' };

  const legal = LEGAL[from];
  if (!legal.includes(to)) return { kind: 'illegal', from, to, legal };
  return { kind: 'ok' };
}

export function legalNextStatuses(from: StudentStatus): readonly StudentStatus[] {
  return LEGAL[from];
}

export function isTerminal(status: StudentStatus): boolean {
  return LEGAL[status].length === 0;
}

/**
 * Which statuses count as being at the school right now.
 *
 * `on_leave` counts: the child is still enrolled, still occupies a place, and
 * still appears on the class list. Attendance treats them separately, which is
 * a different question from whether they are a student here.
 */
export function isEnrolledStatus(status: StudentStatus): boolean {
  return status === 'active' || status === 'on_leave';
}

/** Which date column a transition stamps, if any. */
export function dateColumnFor(to: StudentStatus): 'admitted_on' | 'withdrawn_on' | 'alumni_on' | null {
  switch (to) {
    case 'admitted':
      return 'admitted_on';
    case 'withdrawn':
      return 'withdrawn_on';
    case 'alumni':
      return 'alumni_on';
    default:
      return null;
  }
}

/**
 * Transitions that may not be recorded without a reason.
 *
 * Leaving is the one a family argues about later, and "why did you mark my
 * child withdrawn?" needs an answer that is not "the system did it".
 */
export function requiresReason(to: StudentStatus): boolean {
  return to === 'withdrawn' || to === 'on_leave';
}
