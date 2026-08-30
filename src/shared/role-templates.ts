/**
 * Role templates and the permission→module map.
 *
 * These live in `shared/` rather than inside the seed script because three
 * things need them and they must agree:
 *
 *   1. `pnpm seed`, which writes them into `permission` and `role_template`.
 *   2. The §9.5 permission matrix test, which states independently who should
 *      hold what and fails the build when a permission is added without an
 *      answer.
 *   3. `grantRole`, which cannot let anyone grant beyond their own permissions.
 *
 * A matrix test that imported the seed script would be testing the seed against
 * itself. The definitions are the implementation; the matrix is a separate,
 * hand-written statement of intent, and the test compares the two.
 */

import { PERMISSIONS, type Permission } from './permissions';

export type RoleCode =
  | 'Principal'
  | 'VicePrincipal'
  | 'ClassTeacher'
  | 'SubjectTeacher'
  | 'Accountant'
  | 'OfficeAssistant'
  | 'AdmissionOfficer'
  | 'Librarian'
  | 'Guardian'
  | 'Student';

export interface RoleTemplate {
  code: RoleCode;
  nameBn: string;
  nameEn: string;
  /** The LONG-TERM set. `LIVE_IN_3A` filters it at seed time (§9.6). */
  permissions: readonly Permission[];
}


/**
 * Which module owns each permission. Grouped exactly as §9.1 groups them, and
 * checked below against PERMISSIONS — a permission added to the union without
 * a module here fails the seed rather than landing as 'unknown'.
 */
export const MODULES = {
  platform: [
    'platform.tenant.provision',
    'platform.tenant.suspend',
    'platform.plan.manage',
    'platform.impersonate',
    'platform.usage.read',
  ],
  tenant: ['tenant.settings.manage', 'tenant.branding.manage', 'role.manage', 'membership.manage'],
  structure: ['structure.read', 'structure.manage', 'academicYear.manage', 'academicYear.close'],
  directory: [
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
  ],
  calendar: ['calendar.read', 'calendar.manage', 'holiday.approve'],
  attendance: ['attendance.read', 'attendance.write', 'attendance.amend'],
  assessment: [
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
  ],
  finance: [
    'fee.structure.manage',
    'fee.read',
    'fee.collect',
    'fee.waive',
    'fee.refund',
    'fee.backdate',
    'fee.reconcile',
    'report.financial.read',
  ],
  communication: ['sms.send', 'sms.budget.manage', 'notice.publish'],
  data: ['import.run', 'export.run', 'report.read'],
} as const satisfies Record<string, readonly Permission[]>;

/**
 * §9.6 — only permissions whose module EXISTS are granted in seeded roles.
 * The templates below declare their full long-term permission set, so when a
 * module ships this filter is the single thing that relaxes; the role
 * definitions themselves never need editing.
 *
 * `finance` joined this set once fee heads and fee structures had real use
 * cases behind them (Phase 3b) — `mark.*` (assessment) and `platform.*`
 * (the operator console, never a tenant role) have not shipped yet and stay
 * out. The name is legacy from when 3a was the only phase this filter had
 * ever been asked to gate; it is not literally "3a-only" any more.
 */
export const LIVE_IN_3A = new Set<Permission>([
  ...MODULES.tenant,
  ...MODULES.structure,
  ...MODULES.directory,
  ...MODULES.data,
  ...MODULES.finance,
]);

/** Every tenant-level permission — the operator console is not a tenant role. */
export const ALL_TENANT: readonly Permission[] = PERMISSIONS.filter((p) => !p.startsWith('platform.'));

const without = (from: readonly Permission[], ...drop: Permission[]): readonly Permission[] =>
  from.filter((p) => !drop.includes(p));

/** §9.2. Guardian and Student are real roles, scoped by relationship not Scope. */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    code: 'Principal',
    nameBn: 'প্রধান শিক্ষক',
    nameEn: 'Principal',
    permissions: ALL_TENANT,
  },
  {
    code: 'VicePrincipal',
    nameBn: 'সহকারী প্রধান শিক্ষক',
    nameEn: 'Vice Principal',
    permissions: without(ALL_TENANT, 'fee.waive', 'fee.refund', 'academicYear.close', 'role.manage'),
  },
  {
    code: 'ClassTeacher',
    nameBn: 'শ্রেণি শিক্ষক',
    nameEn: 'Class Teacher',
    permissions: [
      'student.read',
      'guardian.read',
      'attendance.read',
      'attendance.write',
      'mark.read',
      'mark.write',
      'calendar.read',
      'report.read',
    ],
  },
  {
    code: 'SubjectTeacher',
    nameBn: 'বিষয় শিক্ষক',
    nameEn: 'Subject Teacher',
    permissions: ['student.read', 'mark.read', 'mark.write', 'attendance.read', 'calendar.read'],
  },
  {
    code: 'Accountant',
    nameBn: 'হিসাবরক্ষক',
    nameEn: 'Accountant',
    permissions: [
      ...without(MODULES.finance, 'fee.waive'),
      'student.read',
      'guardian.read',
      'export.run',
    ],
  },
  {
    code: 'OfficeAssistant',
    nameBn: 'অফিস সহকারী',
    nameEn: 'Office Assistant',
    permissions: [
      'student.read',
      'student.write',
      'guardian.read',
      'guardian.write',
      'enrolment.manage',
      'fee.read',
      'fee.collect',
      'document.read',
      'document.write',
      'sms.send',
    ],
  },
  {
    code: 'AdmissionOfficer',
    nameBn: 'ভর্তি কর্মকর্তা',
    nameEn: 'Admission Officer',
    permissions: [
      'student.read',
      'student.write',
      'student.transition',
      'guardian.read',
      'guardian.write',
      'document.read',
      'document.write',
      'import.run',
    ],
  },
  {
    code: 'Librarian',
    nameBn: 'গ্রন্থাগারিক',
    nameEn: 'Librarian',
    permissions: ['student.read'],
  },
  {
    code: 'Guardian',
    nameBn: 'অভিভাবক',
    nameEn: 'Guardian',
    permissions: ['student.read', 'fee.read', 'attendance.read', 'result.read'],
  },
  {
    code: 'Student',
    nameBn: 'শিক্ষার্থী',
    nameEn: 'Student',
    permissions: ['attendance.read', 'result.read'],
  },
];

/** What a role actually GRANTS today, after the §9.6 filter. */
export function grantedPermissions(code: RoleCode): readonly Permission[] {
  const t = ROLE_TEMPLATES.find((r) => r.code === code);
  if (!t) throw new Error(`Unknown role template: ${code}`);
  return t.permissions.filter((p) => LIVE_IN_3A.has(p));
}

/** Which module owns each permission, checked against the closed union. */
export function moduleOf(): Map<Permission, string> {
  const map = new Map<Permission, string>();
  for (const [module, keys] of Object.entries(MODULES)) {
    for (const key of keys) {
      if (map.has(key)) throw new Error(`${key} is listed under two modules`);
      map.set(key, module);
    }
  }
  const missing = PERMISSIONS.filter((p) => !map.has(p));
  if (missing.length > 0) {
    throw new Error(`No module in shared/role-templates.ts for: ${missing.join(', ')}`);
  }
  return map;
}

/**
 * Subscription plans. §7.3 tier 1.
 *
 * PRICES ARE PROVISIONAL. §42 assumes an ARPU of ৳6,000 (~US$50) per school
 * per month, and [OQ-2](../../docs/EXTERNAL-ACTIONS.md) — "validate ARPU with
 * five pricing conversations" — is still open. The three-tier split below is a
 * placeholder that lets a tenant be provisioned; it is not a commercial
 * decision and must not be quoted to a school.
 *
 * Money is bigint minor units (poisha). Never a float, never `numeric` at the
 * language boundary.
 */
export interface PlanSeed {
  code: string;
  nameBn: string;
  nameEn: string;
  /** Poisha per month. ৳6,000 = 600_000. */
  priceMinor: bigint;
  features: ReadonlyArray<{ key: string; limit?: number | undefined }>;
}

export const PLANS: readonly PlanSeed[] = [
  {
    code: 'starter',
    nameBn: 'প্রারম্ভিক',
    nameEn: 'Starter',
    priceMinor: 300_000n,
    features: [
      { key: 'students', limit: 300 },
      { key: 'campuses', limit: 1 },
      { key: 'sms', limit: 1_000 },
    ],
  },
  {
    code: 'standard',
    nameBn: 'সাধারণ',
    nameEn: 'Standard',
    // The §42 ARPU figure. Provisional until OQ-2 comes back.
    priceMinor: 600_000n,
    features: [
      { key: 'students', limit: 1_500 },
      { key: 'campuses', limit: 1 },
      { key: 'sms', limit: 5_000 },
    ],
  },
  {
    code: 'multi-campus',
    nameBn: 'বহু-ক্যাম্পাস',
    nameEn: 'Multi-campus',
    priceMinor: 1_200_000n,
    features: [
      // NULL limit = unlimited.
      { key: 'students' },
      { key: 'campuses' },
      { key: 'sms', limit: 20_000 },
    ],
  },
];
