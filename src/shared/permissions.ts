/**
 * The permission vocabulary — a CLOSED union, so a typo is a compile error
 * rather than a silent grant (§9.1).
 *
 * The full vocabulary is declared now, across all phases, so the `permission`
 * table is complete and role templates never need editing when 3b–3d ship.
 * Permissions for modules that do not exist yet simply become reachable when
 * their module lands.
 */

export const PERMISSIONS = [
  // ── platform (operator console only) ──
  'platform.tenant.provision',
  'platform.tenant.suspend',
  'platform.plan.manage',
  'platform.impersonate',
  'platform.usage.read',

  // ── tenant settings ──
  'tenant.settings.manage',
  'tenant.branding.manage',
  'role.manage',
  'membership.manage',

  // ── structure ──
  'structure.read',
  'structure.manage',
  'academicYear.manage',
  'academicYear.close',

  // ── directory ──
  'student.read',
  'student.write',
  'student.transition',
  'student.merge',
  'guardian.read',
  'guardian.write',
  'staff.read',
  'staff.write',
  'enrolment.manage',
  'enrolment.promote',
  'document.read',
  'document.write',

  // ── calendar (3c) ──
  'calendar.read',
  'calendar.manage',
  'holiday.approve',

  // ── attendance (3c) ──
  'attendance.read',
  'attendance.write',
  'attendance.amend',

  // ── assessment (3d) ──
  'scheme.read',
  'scheme.manage',
  'mark.read',
  'mark.write',
  'mark.lock',
  'mark.moderate',
  'result.read',
  'result.tabulate',
  'result.publish',
  'result.revise',

  // ── finance (3b) ──
  // collect / waive / refund are SEPARATE. The office assistant takes money;
  // only the principal forgives it. Collapsing them is how a school loses money.
  'fee.structure.manage',
  'fee.read',
  'fee.collect',
  'fee.waive',
  'fee.refund',
  'fee.backdate',
  'fee.reconcile',
  'report.financial.read',

  // ── communication (3b) ──
  'sms.send',
  'sms.budget.manage',
  'notice.publish',

  // ── data (3b) ──
  'import.run',
  'export.run',
  'report.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Require a confirm step and always record a reason. */
export const DANGEROUS_PERMISSIONS = [
  'fee.waive',
  'fee.refund',
  'result.publish',
  'result.revise',
  'student.merge',
  'academicYear.close',
  'platform.impersonate',
] as const satisfies readonly Permission[];

/** Write permissions are refused for a suspended tenant (invariant 14). */
const READ_SUFFIXES = ['.read'] as const;

export function isWritePermission(p: Permission): boolean {
  return !READ_SUFFIXES.some((s) => p.endsWith(s));
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}
