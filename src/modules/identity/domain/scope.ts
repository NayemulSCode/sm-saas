/**
 * Scope merging — pure. §9.3.
 *
 * A membership may carry several roles, and their scopes UNION: a class
 * teacher who is also exam controller gets both sets, not the intersection.
 *
 * The subtle rule is what an ABSENT key means. Absent is "unrestricted within
 * the tenant", so if any single role is unrestricted on an axis, the merged
 * scope is unrestricted on that axis — a narrower role cannot take away access
 * a broader one grants.
 *
 * A PRESENT but empty array denies everything on that axis, so a misconfigured
 * role fails closed rather than open.
 */

import type { Scope } from '../../../shared/auth-context';

type ScopeKey = 'campusIds' | 'classIds' | 'sectionIds' | 'subjectIds';
const KEYS: ScopeKey[] = ['campusIds', 'classIds', 'sectionIds', 'subjectIds'];

export function mergeScopes(scopes: readonly Scope[]): Scope {
  // No roles at all: no permissions either, so the value is moot. Unrestricted
  // is the honest representation of "no restriction was expressed".
  if (scopes.length === 0) return {};

  const merged: Record<string, readonly string[]> = {};

  for (const key of KEYS) {
    // Any role unrestricted on this axis makes the union unrestricted.
    if (scopes.some((s) => s[key] === undefined)) continue;

    const values = new Set<string>();
    for (const scope of scopes) {
      for (const value of scope[key] ?? []) values.add(value);
    }
    merged[key] = [...values];
  }

  return merged as Scope;
}
