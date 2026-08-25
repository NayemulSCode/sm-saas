import { describe, it, expect } from 'vitest';
import { Ids, type StudentId, type EnrolmentId } from './ids.js';

describe('Ids', () => {
  it('generates a 26-character Crockford base32 ULID', () => {
    const id = Ids.generate<'student'>();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('generates unique ids', () => {
    const set = new Set(Array.from({ length: 1000 }, () => Ids.generate<'student'>()));
    expect(set.size).toBe(1000);
  });

  // ULIDs are time-ordered, which is what keeps inserts at the right edge of
  // the B-tree on attendance and audit_log (ADR-0016). The MONOTONIC factory
  // makes this strict even within a single millisecond — a bulk import creates
  // thousands of ids per millisecond, and plain ulid() would not order them.
  it('sorts lexicographically in creation order, strictly', () => {
    const ids = Array.from({ length: 5000 }, () => Ids.generate<'student'>());
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('stays strictly increasing WITHIN a millisecond', () => {
    // Generating 5000 ids always produces many same-millisecond pairs; asserting
    // that two specific calls share a millisecond would be flaky, because they
    // can straddle the boundary. Instead: prove same-ms pairs actually occurred
    // (so the monotonic path is exercised) and that every pair is ordered.
    const ids = Array.from({ length: 5000 }, () => Ids.generate<'student'>());

    let sameMsPairs = 0;
    for (let i = 1; i < ids.length; i++) {
      const prev = ids[i - 1]!;
      const cur = ids[i]!;
      expect(prev < cur).toBe(true);
      if (Ids.timeOf(prev).getTime() === Ids.timeOf(cur).getTime()) sameMsPairs++;
    }

    expect(sameMsPairs).toBeGreaterThan(0);
  });

  it('round-trips through the uuid representation losslessly', () => {
    for (let i = 0; i < 200; i++) {
      const id = Ids.generate<'student'>();
      const uuid = Ids.toUuid(id);
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(Ids.fromUuid<'student'>(uuid)).toBe(id);
    }
  });

  it('parses a valid ULID and rejects an invalid one', () => {
    const id = Ids.generate<'student'>();
    expect(Ids.parse(id).ok).toBe(true);
    // I, L, O and U are excluded from the alphabet.
    expect(Ids.parse('OOOOOOOOOOOOOOOOOOOOOOOOOO').ok).toBe(false);
    expect(Ids.parse('too-short').ok).toBe(false);
  });

  it('rejects a malformed uuid', () => {
    expect(() => Ids.fromUuid('not-a-uuid')).toThrow();
  });

  it('decodes the creation time', () => {
    const before = Date.now();
    const id = Ids.generate<'student'>();
    const t = Ids.timeOf(id).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('keeps branded ids apart at compile time', () => {
    const studentId = Ids.generate<'student'>();
    const takesEnrolment = (_id: EnrolmentId) => true;
    // @ts-expect-error a StudentId is not an EnrolmentId — this is the point
    takesEnrolment(studentId);

    const takesStudent = (id: StudentId) => id;
    expect(takesStudent(studentId)).toBe(studentId);
  });
});
