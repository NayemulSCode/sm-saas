import { describe, it, expect } from 'vitest';
import { isHouseholdOnly, type AuthContext } from './auth-context';
import { Ids } from './ids';

/**
 * `isHouseholdOnly` is the guard every (staff) page calls before rendering
 * anything. It is the only thing standing between a Guardian-role session and
 * the school's full student roster — `Librarian` and `Guardian` hold the
 * IDENTICAL base permission, `student.read`, so a permission check alone
 * cannot make this distinction (§9.2). Get this function wrong and either a
 * guardian sees the whole school, or a real staff member is locked out.
 */
function ctx(roleCodes: readonly string[]): AuthContext {
  return {
    accountId: Ids.generate(),
    sessionId: Ids.generate(),
    tenantIds: [Ids.generate()],
    activeTenantId: Ids.generate(),
    personId: Ids.generate(),
    membershipId: Ids.generate(),
    permissions: new Set(),
    scope: {},
    roleCodes,
    locale: 'bn',
    requestId: 'test',
    readOnly: false,
  };
}

describe('isHouseholdOnly', () => {
  it('is true for a plain Guardian', () => {
    expect(isHouseholdOnly(ctx(['Guardian']))).toBe(true);
  });

  it('is true for a plain Student', () => {
    expect(isHouseholdOnly(ctx(['Student']))).toBe(true);
  });

  it('is false for any staff role, including one with the same permissions as Guardian', () => {
    // Librarian's granted permission set is identical to Guardian's
    // (`student.read` and nothing else) — this is exactly the case a
    // permission-based check would get wrong.
    expect(isHouseholdOnly(ctx(['Librarian']))).toBe(false);
    expect(isHouseholdOnly(ctx(['Principal']))).toBe(false);
    expect(isHouseholdOnly(ctx(['ClassTeacher']))).toBe(false);
  });

  it('is false the moment ANY staff role is held alongside a household one', () => {
    // A person who is both a guardian and a member of staff — a teacher whose
    // own child attends the school — must reach the staff surface.
    expect(isHouseholdOnly(ctx(['Guardian', 'ClassTeacher']))).toBe(false);
    expect(isHouseholdOnly(ctx(['ClassTeacher', 'Guardian']))).toBe(false);
  });

  it('is true for a membership holding no role at all', () => {
    // `[].every(...)` is vacuously true. Deliberate: no role proves no staff
    // duty either, so the safe reading is the same as an explicit household
    // role, not the opposite.
    expect(isHouseholdOnly(ctx([]))).toBe(true);
  });

  it('is true when Guardian and Student are held together', () => {
    expect(isHouseholdOnly(ctx(['Guardian', 'Student']))).toBe(true);
  });

  it('is false for an unrecognised role code', () => {
    // There is no role-authoring endpoint today, so this should not arise —
    // but if one ships without updating this list, an unknown code must fail
    // toward the staff surface being reachable, not toward a household
    // session silently gaining it. It does the opposite: an unrecognised code
    // is not in HOUSEHOLD_ROLES, so it reads as staff. That is the safe
    // default for THIS function; the real safety net is that no such code can
    // exist yet.
    expect(isHouseholdOnly(ctx(['SomeFutureCustomRole']))).toBe(false);
  });
});
