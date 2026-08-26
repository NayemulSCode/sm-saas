import { describe, it, expect } from 'vitest';
import { evaluateReorder, nextSequence, SEQUENCE_STEP } from './classLevel';

describe('reordering class levels', () => {
  const levels = [
    { id: 'a', nameEn: 'Class 1', sequence: 10 },
    { id: 'b', nameEn: 'Class 2', sequence: 20 },
    { id: 'c', nameEn: 'Class 3', sequence: 30 },
  ];

  it('renumbers to the requested order', () => {
    const v = evaluateReorder(levels, ['c', 'a', 'b']);
    expect(v.kind).toBe('ok');
    if (v.kind !== 'ok') return;
    expect(v.changes).toEqual([
      { id: 'c', sequence: 10 },
      { id: 'a', sequence: 20 },
      { id: 'b', sequence: 30 },
    ]);
  });

  it('emits only the rows that actually move', () => {
    // Swapping the last two leaves the first alone.
    const v = evaluateReorder(levels, ['a', 'c', 'b']);
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') expect(v.changes.map((c) => c.id)).toEqual(['c', 'b']);
  });

  it('reports no change when the order already matches', () => {
    expect(evaluateReorder(levels, ['a', 'b', 'c']).kind).toBe('no_change');
  });

  // Re-spacing from scratch repairs a squeezed ordering as a side effect.
  it('re-spaces levels that were crammed together', () => {
    const crammed = [
      { id: 'a', nameEn: 'x', sequence: 1 },
      { id: 'b', nameEn: 'y', sequence: 2 },
    ];
    const v = evaluateReorder(crammed, ['a', 'b']);
    expect(v.kind).toBe('ok');
    if (v.kind === 'ok') {
      expect(v.changes).toEqual([
        { id: 'a', sequence: 10 },
        { id: 'b', sequence: 20 },
      ]);
    }
  });

  /*
   * The request is the COMPLETE order, not a diff. Two clients sending
   * overlapping partial moves cannot be reconciled silently, and the cost of
   * getting it wrong is a cohort promoted into the wrong class.
   */
  it('refuses a partial order', () => {
    const v = evaluateReorder(levels, ['b', 'a']);
    expect(v.kind).toBe('incomplete');
    if (v.kind === 'incomplete') expect(v.missing).toEqual(['c']);
  });

  it('refuses an unknown id', () => {
    const v = evaluateReorder(levels, ['a', 'b', 'c', 'zz']);
    expect(v.kind).toBe('unknown');
    if (v.kind === 'unknown') expect(v.ids).toEqual(['zz']);
  });

  it('refuses a repeated id', () => {
    const v = evaluateReorder(levels, ['a', 'a', 'b']);
    expect(v.kind).toBe('duplicate_id');
    if (v.kind === 'duplicate_id') expect(v.ids).toEqual(['a']);
  });

  it('reports a duplicate before an unknown, so the clearer error wins', () => {
    expect(evaluateReorder(levels, ['a', 'a', 'zz']).kind).toBe('duplicate_id');
  });
});

describe('nextSequence', () => {
  it('starts at the step for an empty school', () => {
    expect(nextSequence([])).toBe(SEQUENCE_STEP);
  });

  /*
   * The END, not the beginning. A school adding a class is almost always
   * extending upward, and inserting at the top would demote every existing
   * class by one rung.
   */
  it('goes past the highest existing level', () => {
    expect(nextSequence([{ id: 'a', nameEn: 'x', sequence: 500 }])).toBe(510);
  });

  it('ignores gaps and uses the maximum, not the count', () => {
    expect(
      nextSequence([
        { id: 'a', nameEn: 'x', sequence: 10 },
        { id: 'b', nameEn: 'y', sequence: 1000 },
      ]),
    ).toBe(1010);
  });
});
