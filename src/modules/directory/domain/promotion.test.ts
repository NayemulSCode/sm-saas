import { describe, it, expect } from 'vitest';
import { buildPromotionPlan, statusForExit, type Candidate } from './promotion';

const c = (studentId: string, rollNo: number | null, nameEn = studentId): Candidate => ({
  enrolmentId: `e-${studentId}`,
  studentId,
  rollNo,
  nameEn,
});

const TARGET = 'section-7a';
const RETAIN = 'section-6a';

const plan = (candidates: Candidate[], exceptions: Record<string, never | string> = {}) =>
  buildPromotionPlan({
    candidates,
    targetSectionId: TARGET,
    retainSectionId: RETAIN,
    defaultOutcome: 'promoted',
    exceptions: exceptions as Record<string, 'promoted' | 'retained' | 'transferred' | 'withdrawn'>,
  });

describe('building a promotion plan', () => {
  it('promotes a whole section into the target', () => {
    const v = plan([c('a', 1), c('b', 2), c('c', 3)]);
    expect(v.kind).toBe('ok');
    if (v.kind !== 'ok') return;

    expect(v.plan.entries).toHaveLength(3);
    expect(v.plan.entries.every((e) => e.sectionId === TARGET)).toBe(true);
    expect(v.plan.counts.promoted).toBe(3);
  });

  /*
   * FR-4.3. Roll numbers live on the enrolment precisely so last year's roll 7
   * stays roll 7 in last year's records while becoming roll 5 in the new
   * section.
   */
  it('reassigns roll numbers from 1, without gaps', () => {
    const v = plan([c('a', 4), c('b', 9), c('c', 11)]);
    if (v.kind !== 'ok') throw new Error('expected a plan');
    expect(v.plan.entries.map((e) => e.rollNo)).toEqual([1, 2, 3]);
  });

  // The new list has to be recognisable to the teacher who will read it.
  it('keeps the previous roll order', () => {
    const v = plan([c('c', 30), c('a', 10), c('b', 20)]);
    if (v.kind !== 'ok') throw new Error('expected a plan');
    expect(v.plan.entries.map((e) => e.studentId)).toEqual(['a', 'b', 'c']);
  });

  it('sorts a student with no previous roll last, by name', () => {
    const v = plan([c('z', null, 'Zubair'), c('a', 5, 'Anwar'), c('m', null, 'Mizan')]);
    if (v.kind !== 'ok') throw new Error('expected a plan');
    expect(v.plan.entries.map((e) => e.studentId)).toEqual(['a', 'm', 'z']);
  });

  describe('per-student exceptions', () => {
    it('keeps a retained student in their current section', () => {
      const v = plan([c('a', 1), c('b', 2)], { b: 'retained' });
      if (v.kind !== 'ok') throw new Error('expected a plan');

      expect(v.plan.entries.find((e) => e.studentId === 'b')?.sectionId).toBe(RETAIN);
      expect(v.plan.entries.find((e) => e.studentId === 'a')?.sectionId).toBe(TARGET);
      expect(v.plan.counts).toMatchObject({ promoted: 1, retained: 1 });
    });

    it('gives a leaver no new enrolment at all', () => {
      const v = plan([c('a', 1), c('b', 2), c('d', 3)], { b: 'withdrawn', d: 'transferred' });
      if (v.kind !== 'ok') throw new Error('expected a plan');

      expect(v.plan.entries.map((e) => e.studentId)).toEqual(['a']);
      expect(v.plan.exits.map((e) => e.studentId).sort()).toEqual(['b', 'd']);
      expect(v.plan.counts).toEqual({
        promoted: 1,
        retained: 0,
        transferred: 1,
        withdrawn: 1,
      });
    });

    // Roll numbers count the students who stay, not the ones who were there.
    it('does not leave a gap where a leaver was', () => {
      const v = plan([c('a', 1), c('b', 2), c('d', 3)], { b: 'withdrawn' });
      if (v.kind !== 'ok') throw new Error('expected a plan');
      expect(v.plan.entries.map((e) => [e.studentId, e.rollNo])).toEqual([
        ['a', 1],
        ['d', 2],
      ]);
    });

    /*
     * A named exception who is not in the section almost always means the wrong
     * section was chosen — which is exactly the mistake undo exists for, and
     * catching it before anything moves is cheaper.
     */
    it('refuses an exception naming a student who is not here', () => {
      const v = plan([c('a', 1)], { ghost: 'retained' });
      expect(v.kind).toBe('unknown_students');
      if (v.kind === 'unknown_students') expect(v.ids).toEqual(['ghost']);
    });
  });

  it('reports an empty section rather than producing an empty plan', () => {
    expect(plan([]).kind).toBe('empty');
  });

  it('can retain everybody, which is a whole year repeating', () => {
    const v = buildPromotionPlan({
      candidates: [c('a', 1), c('b', 2)],
      targetSectionId: TARGET,
      retainSectionId: RETAIN,
      defaultOutcome: 'retained',
      exceptions: {},
    });
    if (v.kind !== 'ok') throw new Error('expected a plan');
    expect(v.plan.entries.every((e) => e.sectionId === RETAIN)).toBe(true);
    expect(v.plan.counts.retained).toBe(2);
  });

  it('carries the source enrolment on every row, so the old one can be closed', () => {
    const v = plan([c('a', 1), c('b', 2)], { b: 'withdrawn' });
    if (v.kind !== 'ok') throw new Error('expected a plan');
    expect(v.plan.entries[0]?.sourceEnrolmentId).toBe('e-a');
    expect(v.plan.exits[0]?.sourceEnrolmentId).toBe('e-b');
  });

  it('counts every candidate exactly once', () => {
    const v = plan([c('a', 1), c('b', 2), c('d', 3), c('e', 4)], {
      b: 'retained',
      d: 'withdrawn',
    });
    if (v.kind !== 'ok') throw new Error('expected a plan');
    const total = Object.values(v.plan.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(4);
    expect(v.plan.entries.length + v.plan.exits.length).toBe(4);
  });
});

describe('statusForExit', () => {
  // A transfer out and a withdrawal are the same lifecycle event — the child
  // stops attending. The enrolment outcome records which of the two it was.
  it('sends both kinds of leaver to withdrawn', () => {
    expect(statusForExit('transferred')).toBe('withdrawn');
    expect(statusForExit('withdrawn')).toBe('withdrawn');
  });
});
