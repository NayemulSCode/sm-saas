/**
 * The permission matrix. §9.5.
 *
 * This is what makes the 55-key vocabulary trustworthy. The role definitions in
 * `role-templates.ts` are the implementation; `HOLDERS` below is a SEPARATE,
 * hand-written statement of who should hold each permission. The test compares
 * the two, in both directions.
 *
 * The deliberate redundancy is the point. Deriving the expectations from the
 * definitions would make the test pass no matter what the definitions said.
 *
 * The assertion that earns its keep is the last one in this file: every
 * `Permission` must appear here. A permission added to the union without an
 * answer to "who may do this?" fails the build, so the vocabulary cannot grow
 * silently.
 */

import { describe, it, expect } from 'vitest';
import { PERMISSIONS, DANGEROUS_PERMISSIONS, type Permission } from './permissions';
import {
  ROLE_TEMPLATES,
  LIVE_IN_3A,
  grantedPermissions,
  moduleOf,
  type RoleCode,
} from './role-templates';
import { authorize, AuthorizationError, type AuthContext, type Scope } from './auth-context';
import { Ids } from './ids';
import type { CampusId, ClassLevelId, SectionId, SubjectId } from './ids';

const ALL_ROLES: readonly RoleCode[] = ROLE_TEMPLATES.map((r) => r.code);

const TEACHERS: RoleCode[] = ['ClassTeacher', 'SubjectTeacher'];
const OFFICE: RoleCode[] = ['OfficeAssistant', 'AdmissionOfficer'];
const HEADS: RoleCode[] = ['Principal', 'VicePrincipal'];

/**
 * Who should hold each permission — EXHAUSTIVELY. Any role not listed for a
 * permission must not have it, and the test checks that too, so 10 roles ×
 * 55 permissions are all covered by these rows.
 *
 * `[]` means nobody: `platform.*` belongs to the operator console, which is not
 * a tenant role at all.
 */
const HOLDERS: Record<Permission, readonly RoleCode[]> = {
  // ── platform: operator console only, never a tenant role ──
  'platform.tenant.provision': [],
  'platform.tenant.suspend': [],
  'platform.plan.manage': [],
  'platform.impersonate': [],
  'platform.usage.read': [],

  // ── tenant settings ──
  'tenant.settings.manage': HEADS,
  'tenant.branding.manage': HEADS,
  // Only the Principal. Whoever can edit roles can grant themselves anything,
  // so the deputy does not get it.
  'role.manage': ['Principal'],
  'membership.manage': HEADS,

  // ── structure ──
  'structure.read': HEADS,
  'structure.manage': HEADS,
  'academicYear.manage': HEADS,
  // Closing a year freezes results and rolls enrolments. Principal alone.
  'academicYear.close': ['Principal'],

  // ── directory ──
  'student.read': [
    ...HEADS,
    ...TEACHERS,
    ...OFFICE,
    'Accountant',
    'Librarian',
    'Guardian',
  ],
  'student.write': [...HEADS, ...OFFICE],
  'student.transition': [...HEADS, 'AdmissionOfficer'],
  // Destructive and hard to undo — but §9.2 defines the Vice Principal by
  // subtraction and does not subtract this one. See the test below, which
  // exists because subtraction is how a new dangerous permission quietly
  // lands on the deputy.
  'student.merge': HEADS,
  'guardian.read': [...HEADS, ...OFFICE, 'ClassTeacher', 'Accountant'],
  'guardian.write': [...HEADS, ...OFFICE],
  'staff.read': HEADS,
  'staff.write': HEADS,
  'enrolment.manage': [...HEADS, 'OfficeAssistant'],
  'enrolment.promote': HEADS,
  'document.read': [...HEADS, ...OFFICE],
  'document.write': [...HEADS, ...OFFICE],

  // ── calendar (3c) ──
  'calendar.read': [...HEADS, ...TEACHERS],
  'calendar.manage': HEADS,
  'holiday.approve': HEADS,

  // ── attendance (3c) ──
  'attendance.read': [...HEADS, ...TEACHERS, 'Guardian', 'Student'],
  // A subject teacher reads attendance but does not take it: it is taken once
  // per day by the class teacher, and two sources would double-count.
  'attendance.write': [...HEADS, 'ClassTeacher'],
  'attendance.amend': HEADS,

  // ── assessment (3d) ──
  /*
   * §9.2 gives teachers mark.write but NOT scheme.read, which looks wrong: a
   * teacher entering marks needs the maximum mark to enter them against. It
   * grants nothing today — LIVE_IN_3A filters the whole assessment module — so
   * this follows the spec rather than guessing, and 3d has to settle it with
   * the mark-entry screen actually in front of it. Flagged, not silently fixed.
   */
  'scheme.read': HEADS,
  'scheme.manage': HEADS,
  'mark.read': [...HEADS, ...TEACHERS],
  'mark.write': [...HEADS, ...TEACHERS],
  'mark.lock': HEADS,
  'mark.moderate': HEADS,
  'result.read': [...HEADS, 'Guardian', 'Student'],
  'result.tabulate': HEADS,
  /*
   * Publishing makes results immutable and visible to every guardian, so the
   * instinct is Principal alone. §9.2 disagrees, and deliberately: the Vice
   * Principal is "Principal minus fee.waive, fee.refund, academicYear.close,
   * role.manage" — publishing is not on that list, because a vice principal
   * running the exams is the normal arrangement in a Bangladeshi school.
   * The spec wins over the instinct.
   */
  'result.publish': HEADS,
  'result.revise': HEADS,

  // ── finance (3b) ──
  // collect / waive / refund are SEPARATE. The office assistant takes money;
  // only the principal forgives it. Collapsing them is how a school loses money.
  'fee.structure.manage': [...HEADS, 'Accountant'],
  'fee.read': [...HEADS, 'Accountant', 'OfficeAssistant', 'Guardian'],
  'fee.collect': [...HEADS, 'Accountant', 'OfficeAssistant'],
  'fee.waive': ['Principal'],
  'fee.refund': ['Principal', 'Accountant'],
  'fee.backdate': [...HEADS, 'Accountant'],
  'fee.reconcile': [...HEADS, 'Accountant'],
  'report.financial.read': [...HEADS, 'Accountant'],

  // ── communication (3b) ──
  'sms.send': [...HEADS, 'OfficeAssistant'],
  'sms.budget.manage': HEADS,
  'notice.publish': HEADS,

  // ── data (3b) ──
  'import.run': [...HEADS, 'AdmissionOfficer'],
  'export.run': [...HEADS, 'Accountant'],
  'report.read': [...HEADS, 'ClassTeacher'],
};

function ctxFor(permissions: readonly Permission[], scope: Scope = {}): AuthContext {
  return {
    accountId: Ids.generate<'account'>(),
    sessionId: Ids.generate<'session'>(),
    tenantIds: [Ids.generate<'tenant'>()],
    activeTenantId: Ids.generate<'tenant'>(),
    personId: Ids.generate<'person'>(),
    membershipId: Ids.generate<'membership'>(),
    permissions: new Set(permissions),
    scope,
    locale: 'bn',
    requestId: 'matrix',
    readOnly: false,
  };
}

const allows = (ctx: AuthContext, p: Permission, target?: Parameters<typeof authorize>[2]) => {
  try {
    authorize(ctx, p, target);
    return true;
  } catch (e) {
    if (e instanceof AuthorizationError) return false;
    throw e;
  }
};

// ── the matrix ──────────────────────────────────────────────────────────────

describe('the permission matrix', () => {
  /*
   * THE assertion. Adding a permission to the union without deciding who may
   * use it fails the build here, which is the whole reason this file exists.
   */
  it('has an answer for every permission in the union', () => {
    expect(new Set(Object.keys(HOLDERS))).toEqual(new Set<string>(PERMISSIONS));
  });

  it('names only roles that exist', () => {
    for (const [permission, roles] of Object.entries(HOLDERS)) {
      for (const role of roles) {
        expect(ALL_ROLES, `${permission} names an unknown role ${role}`).toContain(role);
      }
    }
  });

  describe.each(ALL_ROLES)('%s', (code) => {
    // The DECLARED set, not the granted one: §9.6 filters what ships today,
    // and the matrix states long-term intent so it stays stable as 3b–3d land.
    const declared = new Set(ROLE_TEMPLATES.find((r) => r.code === code)!.permissions);

    it('holds exactly the permissions the matrix says it should', () => {
      const expected = PERMISSIONS.filter((p) => HOLDERS[p].includes(code));
      const actual = PERMISSIONS.filter((p) => declared.has(p));
      expect(new Set(actual)).toEqual(new Set(expected));
    });

    it('holds no platform permission — the operator console is not a role', () => {
      expect([...declared].filter((p) => p.startsWith('platform.'))).toEqual([]);
    });
  });
});

// ── the separations that money and marks depend on ──────────────────────────

describe('separations that must not collapse', () => {
  const holds = (code: RoleCode, p: Permission) =>
    ROLE_TEMPLATES.find((r) => r.code === code)!.permissions.includes(p);

  /*
   * §9.1: the office assistant takes money, only the principal forgives it.
   * These are the rows from §9.5's worked example, written out because they are
   * the ones a well-meaning refactor collapses.
   */
  it('lets the office assistant collect but never waive', () => {
    expect(holds('OfficeAssistant', 'fee.collect')).toBe(true);
    expect(holds('OfficeAssistant', 'fee.waive')).toBe(false);
  });

  it('lets the accountant do everything with money except forgive it', () => {
    expect(holds('Accountant', 'fee.reconcile')).toBe(true);
    expect(holds('Accountant', 'fee.waive')).toBe(false);
  });

  it('lets only the principal waive', () => {
    for (const code of ALL_ROLES) {
      expect(holds(code, 'fee.waive'), code).toBe(code === 'Principal');
    }
  });

  it('keeps a class teacher out of the cash box', () => {
    expect(holds('ClassTeacher', 'fee.collect')).toBe(false);
  });

  /*
   * Attendance is taken once per day by the class teacher. A subject teacher
   * writing it too would double-count against the working-day calendar.
   */
  it('lets the class teacher write attendance and the subject teacher only read it', () => {
    expect(holds('ClassTeacher', 'attendance.write')).toBe(true);
    expect(holds('SubjectTeacher', 'attendance.write')).toBe(false);
    expect(holds('SubjectTeacher', 'attendance.read')).toBe(true);
  });

  // Whoever edits roles can grant themselves anything.
  it('gives role.manage to the principal alone', () => {
    for (const code of ALL_ROLES) {
      expect(holds(code, 'role.manage'), code).toBe(code === 'Principal');
    }
  });

  it('gives guardians and students no write permission at all', () => {
    for (const code of ['Guardian', 'Student'] as const) {
      const writes = ROLE_TEMPLATES.find((r) => r.code === code)!.permissions.filter(
        (p) => !p.endsWith('.read'),
      );
      expect(writes, `${code} should be read-only`).toEqual([]);
    }
  });

  /*
   * §9.2 defines the Vice Principal by SUBTRACTION — "Principal minus
   * fee.waive, fee.refund, academicYear.close, role.manage". That is convenient
   * and quietly fragile: every dangerous permission added to the union in
   * future lands on the deputy automatically unless someone remembers to
   * subtract it.
   *
   * So the list is pinned here. Adding to DANGEROUS_PERMISSIONS fails this
   * test, which forces the decision to be made rather than inherited.
   */
  it('pins exactly which dangerous permissions the deputy inherits', () => {
    const inherited = DANGEROUS_PERMISSIONS.filter((p) => holds('VicePrincipal', p));
    expect(inherited).toEqual(['result.publish', 'result.revise', 'student.merge']);
  });

  // Every dangerous permission needs an owner, and a short list of them.
  it('confines the dangerous permissions to the heads', () => {
    for (const p of DANGEROUS_PERMISSIONS) {
      if (p === 'platform.impersonate') continue;
      const holders = ALL_ROLES.filter((c) => holds(c, p));
      expect(holders.length, `${p} is held by ${holders.join(', ')}`).toBeLessThanOrEqual(2);
      expect(holders, p).toContain('Principal');
    }
  });
});

// ── scope: the second axis (§9.3) ───────────────────────────────────────────

describe('scope', () => {
  const OWN_SECTION = Ids.generate<'section'>() as SectionId;
  const OTHER_SECTION = Ids.generate<'section'>() as SectionId;
  const MATHS = Ids.generate<'subject'>() as SubjectId;
  const ENGLISH = Ids.generate<'subject'>() as SubjectId;

  it('lets a class teacher write attendance for their own section only', () => {
    const ctx = ctxFor(['attendance.write'], { sectionIds: [OWN_SECTION] });
    expect(allows(ctx, 'attendance.write', { sectionId: OWN_SECTION })).toBe(true);
    expect(allows(ctx, 'attendance.write', { sectionId: OTHER_SECTION })).toBe(false);
  });

  it('lets a subject teacher mark their own (section, subject) pair', () => {
    const ctx = ctxFor(['mark.write'], {
      sectionIds: [OWN_SECTION],
      subjectIds: [MATHS],
    });
    expect(allows(ctx, 'mark.write', { sectionId: OWN_SECTION, subjectId: MATHS })).toBe(true);
    // Same section, different subject — the pair rule, not a cross product.
    expect(allows(ctx, 'mark.write', { sectionId: OWN_SECTION, subjectId: ENGLISH })).toBe(false);
    expect(allows(ctx, 'mark.write', { sectionId: OTHER_SECTION, subjectId: MATHS })).toBe(false);
  });

  it('treats an absent axis as unrestricted within the tenant', () => {
    const ctx = ctxFor(['mark.write'], {});
    expect(allows(ctx, 'mark.write', { sectionId: OTHER_SECTION })).toBe(true);
  });

  // A misconfigured role fails closed rather than open.
  it('treats a present but empty axis as denying everything', () => {
    const ctx = ctxFor(['mark.write'], { sectionIds: [] });
    expect(allows(ctx, 'mark.write', { sectionId: OWN_SECTION })).toBe(false);
  });

  it('denies a scoped role that supplies no target for a scoped axis', () => {
    const ctx = ctxFor(['attendance.write'], { sectionIds: [OWN_SECTION] });
    expect(allows(ctx, 'attendance.write', { campusId: Ids.generate<'campus'>() as CampusId })).toBe(
      false,
    );
  });

  it('unions the scopes of several roles on one membership', () => {
    // A class teacher who is also exam controller gets both, not the narrower.
    const ctx = ctxFor(['mark.write'], { sectionIds: [OWN_SECTION, OTHER_SECTION] });
    expect(allows(ctx, 'mark.write', { sectionId: OWN_SECTION })).toBe(true);
    expect(allows(ctx, 'mark.write', { sectionId: OTHER_SECTION })).toBe(true);
  });

  it('checks class scope independently of section scope', () => {
    const cls = Ids.generate<'classLevel'>() as ClassLevelId;
    const ctx = ctxFor(['student.read'], { classIds: [cls] });
    expect(allows(ctx, 'student.read', { classId: cls })).toBe(true);
    expect(allows(ctx, 'student.read', { classId: Ids.generate<'classLevel'>() as ClassLevelId })).toBe(
      false,
    );
  });
});

// ── invariant 14 ────────────────────────────────────────────────────────────

describe('a suspended tenant', () => {
  it('may still read but never write, whatever the role holds', () => {
    const ctx = { ...ctxFor([...PERMISSIONS]), readOnly: true };
    expect(allows(ctx, 'student.read')).toBe(true);
    expect(allows(ctx, 'student.write')).toBe(false);
    expect(allows(ctx, 'fee.collect')).toBe(false);
  });

  it('applies to every non-read permission in the vocabulary', () => {
    const ctx = { ...ctxFor([...PERMISSIONS]), readOnly: true };
    for (const p of PERMISSIONS) {
      expect(allows(ctx, p), p).toBe(p.endsWith('.read'));
    }
  });
});

// ── §9.6: what actually ships today ─────────────────────────────────────────

describe('the Phase 3a filter', () => {
  it('grants nothing from a module that does not exist yet', () => {
    for (const code of ALL_ROLES) {
      for (const p of grantedPermissions(code)) {
        expect(LIVE_IN_3A.has(p), `${code} is granted ${p}, which does not ship in 3a`).toBe(true);
      }
    }
  });

  it('still leaves the Principal able to run a school', () => {
    const granted = grantedPermissions('Principal');
    for (const p of ['membership.manage', 'student.write', 'structure.manage'] as const) {
      expect(granted).toContain(p);
    }
  });

  // The filter must shrink the set, not empty it.
  it('leaves every role except Student with something to do', () => {
    for (const code of ALL_ROLES) {
      if (code === 'Student') continue;
      expect(grantedPermissions(code).length, code).toBeGreaterThan(0);
    }
  });
});

describe('the module map', () => {
  it('covers every permission', () => {
    expect(() => moduleOf()).not.toThrow();
    expect(moduleOf().size).toBe(PERMISSIONS.length);
  });
});
