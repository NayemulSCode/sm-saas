import { describe, it, expect } from 'vitest';
import { mergeScopes } from './scope';
import type { Scope } from '../../../shared/auth-context';

const s = (o: Record<string, string[]>) => o as unknown as Scope;

describe('mergeScopes', () => {
  it('unions the same axis across roles', () => {
    const merged = mergeScopes([s({ sectionIds: ['a'] }), s({ sectionIds: ['b'] })]);
    expect([...(merged.sectionIds ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('de-duplicates', () => {
    const merged = mergeScopes([s({ sectionIds: ['a'] }), s({ sectionIds: ['a'] })]);
    expect(merged.sectionIds).toEqual(['a']);
  });

  // A narrower role must not take away access a broader one grants.
  it('an unrestricted role makes the axis unrestricted', () => {
    const merged = mergeScopes([s({ sectionIds: ['a'] }), {}]);
    expect(merged.sectionIds).toBeUndefined();
  });

  it('merges axes independently', () => {
    const merged = mergeScopes([
      s({ sectionIds: ['a'] }),
      s({ sectionIds: ['b'], subjectIds: ['maths'] }),
    ]);
    expect([...(merged.sectionIds ?? [])].sort()).toEqual(['a', 'b']);
    // subjectIds was absent on the first role → unrestricted overall.
    expect(merged.subjectIds).toBeUndefined();
  });

  // Present-but-empty denies. Two denying roles still deny.
  it('keeps an empty array as a denial', () => {
    const merged = mergeScopes([s({ sectionIds: [] }), s({ sectionIds: [] })]);
    expect(merged.sectionIds).toEqual([]);
  });

  it('an empty array unions with a populated one', () => {
    const merged = mergeScopes([s({ sectionIds: [] }), s({ sectionIds: ['a'] })]);
    expect(merged.sectionIds).toEqual(['a']);
  });

  it('no roles is unrestricted — there are no permissions either', () => {
    expect(mergeScopes([])).toEqual({});
  });

  it('a single role passes through unchanged', () => {
    const merged = mergeScopes([s({ campusIds: ['c1'], sectionIds: ['s1'] })]);
    expect(merged.campusIds).toEqual(['c1']);
    expect(merged.sectionIds).toEqual(['s1']);
  });
});
