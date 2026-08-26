import { describe, it, expect } from 'vitest';
import {
  STUDENT_STATUSES,
  evaluateTransition,
  legalNextStatuses,
  isTerminal,
  isEnrolledStatus,
  dateColumnFor,
  requiresReason,
  type StudentStatus,
} from './studentStatus';

const ok = (from: StudentStatus, to: StudentStatus) => evaluateTransition(from, to).kind === 'ok';

describe('the student lifecycle', () => {
  it('walks the happy path end to end', () => {
    expect(ok('applicant', 'admitted')).toBe(true);
    expect(ok('admitted', 'active')).toBe(true);
    expect(ok('active', 'on_leave')).toBe(true);
    expect(ok('on_leave', 'active')).toBe(true);
    expect(ok('active', 'alumni')).toBe(true);
  });

  // FR-4.7: a family that leaves in March and returns in July keeps one record,
  // or the child's history and their siblings' discount both split.
  it('allows readmission from withdrawn', () => {
    expect(ok('withdrawn', 'active')).toBe(true);
  });

  it('lets anyone leave from anywhere except alumni', () => {
    for (const s of STUDENT_STATUSES) {
      if (s === 'withdrawn' || s === 'alumni') continue;
      expect(ok(s, 'withdrawn'), `${s} → withdrawn`).toBe(true);
    }
  });

  // Someone who completed the school and returns is a new admission. Their old
  // record is what a transfer certificate is issued from a decade later.
  it('makes alumni terminal', () => {
    expect(isTerminal('alumni')).toBe(true);
    expect(legalNextStatuses('alumni')).toEqual([]);
    for (const s of STUDENT_STATUSES) {
      if (s === 'alumni') continue;
      expect(ok('alumni', s), `alumni → ${s}`).toBe(false);
    }
  });

  /*
   * The CHECK constraint says these values exist; it says nothing about which
   * moves are legal, and "active → applicant" is representable in SQL while
   * being nonsense in a school.
   */
  it('refuses to walk the lifecycle backwards', () => {
    expect(ok('active', 'applicant')).toBe(false);
    expect(ok('active', 'admitted')).toBe(false);
    expect(ok('admitted', 'applicant')).toBe(false);
    expect(ok('on_leave', 'admitted')).toBe(false);
  });

  it('refuses to skip admission', () => {
    expect(ok('applicant', 'active')).toBe(false);
    expect(ok('applicant', 'alumni')).toBe(false);
  });

  it('reports an illegal move with the legal alternatives', () => {
    const v = evaluateTransition('applicant', 'alumni');
    expect(v.kind).toBe('illegal');
    if (v.kind === 'illegal') {
      expect(v.from).toBe('applicant');
      expect(v.to).toBe('alumni');
      expect(v.legal).toEqual(['admitted', 'withdrawn']);
    }
  });

  // Not an error worth failing a bulk promotion over, but it must not write a
  // status event claiming a change that did not happen.
  it('treats a no-op as its own outcome, not as legal or illegal', () => {
    for (const s of STUDENT_STATUSES) {
      expect(evaluateTransition(s, s).kind, s).toBe('same_status');
    }
  });

  it('has an entry for every status, so the map cannot fall behind the union', () => {
    for (const s of STUDENT_STATUSES) {
      expect(Array.isArray(legalNextStatuses(s)), s).toBe(true);
    }
  });

  it('never names a status that is not in the union', () => {
    for (const s of STUDENT_STATUSES) {
      for (const next of legalNextStatuses(s)) {
        expect(STUDENT_STATUSES).toContain(next);
      }
    }
  });
});

describe('isEnrolledStatus', () => {
  /*
   * on_leave counts. The child still occupies a place and still appears on the
   * class list; whether they were present today is a different question that
   * attendance answers.
   */
  it('counts active and on_leave, nothing else', () => {
    expect(isEnrolledStatus('active')).toBe(true);
    expect(isEnrolledStatus('on_leave')).toBe(true);
    expect(isEnrolledStatus('applicant')).toBe(false);
    expect(isEnrolledStatus('admitted')).toBe(false);
    expect(isEnrolledStatus('withdrawn')).toBe(false);
    expect(isEnrolledStatus('alumni')).toBe(false);
  });
});

describe('dateColumnFor', () => {
  it('stamps the three dates the student table carries', () => {
    expect(dateColumnFor('admitted')).toBe('admitted_on');
    expect(dateColumnFor('withdrawn')).toBe('withdrawn_on');
    expect(dateColumnFor('alumni')).toBe('alumni_on');
  });

  it('stamps nothing for the transitions with no column', () => {
    expect(dateColumnFor('applicant')).toBeNull();
    expect(dateColumnFor('active')).toBeNull();
    expect(dateColumnFor('on_leave')).toBeNull();
  });
});

describe('requiresReason', () => {
  // "Why did you mark my child withdrawn?" needs an answer that is not
  // "the system did it".
  it('demands one for leaving and for going on leave', () => {
    expect(requiresReason('withdrawn')).toBe(true);
    expect(requiresReason('on_leave')).toBe(true);
  });

  it('does not demand one for ordinary progress', () => {
    expect(requiresReason('admitted')).toBe(false);
    expect(requiresReason('active')).toBe(false);
    expect(requiresReason('alumni')).toBe(false);
  });
});
