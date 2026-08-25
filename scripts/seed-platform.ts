/**
 * Platform reference data: the permission vocabulary and the role templates.
 *
 * Both are DERIVED from `src/shared/permissions.ts`, which is the single source
 * of truth (§9.1). Writing them as a SQL migration would mean transcribing the
 * closed union by hand into a file that then drifts from it silently — so they
 * are seeded from the union itself, idempotently, and a companion integration
 * test fails the build if the table and the union ever disagree.
 *
 * Safe to re-run: every statement is an upsert. Nothing is deleted, because
 * `role_permission.permission_key` has a foreign key to `permission(key)` and
 * a tenant may already have granted a key we no longer ship. Orphans are
 * REPORTED instead, for a human to retire deliberately.
 *
 *   pnpm db:migrate && pnpm seed
 */

import { Pool } from 'pg';
import { PERMISSIONS, DANGEROUS_PERMISSIONS, type Permission } from '../src/shared/permissions';

const url = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL_APP;
if (!url) {
  console.error('Set DATABASE_URL_MIGRATOR (or DATABASE_URL_APP) before seeding.');
  process.exit(1);
}

/**
 * Which module owns each permission. Grouped exactly as §9.1 groups them, and
 * checked below against PERMISSIONS — a permission added to the union without
 * a module here fails the seed rather than landing as 'unknown'.
 */
const MODULES = {
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
 * §9.6 — only permissions whose module EXISTS in 3a are granted in seeded
 * roles. The templates below declare their full long-term permission set, so
 * when 3b–3d ship this filter is the single thing that relaxes; the role
 * definitions themselves never need editing.
 */
const LIVE_IN_3A = new Set<Permission>([
  ...MODULES.tenant,
  ...MODULES.structure,
  ...MODULES.directory,
  ...MODULES.data,
]);

/** Every tenant-level permission — the operator console is not a tenant role. */
const ALL_TENANT: readonly Permission[] = PERMISSIONS.filter((p) => !p.startsWith('platform.'));

const without = (from: readonly Permission[], ...drop: Permission[]): readonly Permission[] =>
  from.filter((p) => !drop.includes(p));

/** §9.2. Guardian and Student are real roles, scoped by relationship not Scope. */
const ROLE_TEMPLATES: ReadonlyArray<{
  code: string;
  nameBn: string;
  nameEn: string;
  permissions: readonly Permission[];
}> = [
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

function moduleOf(): Map<Permission, string> {
  const map = new Map<Permission, string>();
  for (const [module, keys] of Object.entries(MODULES)) {
    for (const key of keys) {
      if (map.has(key)) throw new Error(`${key} is listed under two modules`);
      map.set(key, module);
    }
  }
  const missing = PERMISSIONS.filter((p) => !map.has(p));
  if (missing.length > 0) {
    throw new Error(`No module in seed-platform.ts for: ${missing.join(', ')}`);
  }
  return map;
}

const pool = new Pool({ connectionString: url, max: 1 });

async function main(): Promise<void> {
  const modules = moduleOf();
  const dangerous = new Set<string>(DANGEROUS_PERMISSIONS);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const key of PERMISSIONS) {
      await client.query(
        `INSERT INTO permission (key, module, is_dangerous)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE
           SET module = EXCLUDED.module, is_dangerous = EXCLUDED.is_dangerous`,
        [key, modules.get(key), dangerous.has(key)],
      );
    }

    for (const [i, t] of ROLE_TEMPLATES.entries()) {
      const granted = t.permissions.filter((p) => LIVE_IN_3A.has(p));
      await client.query(
        `INSERT INTO role_template (code, name_bn, name_en, permissions, sequence)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (code) DO UPDATE
           SET name_bn = EXCLUDED.name_bn,
               name_en = EXCLUDED.name_en,
               permissions = EXCLUDED.permissions,
               sequence = EXCLUDED.sequence`,
        [t.code, t.nameBn, t.nameEn, granted, i],
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('seed failed:', e instanceof Error ? e.message : e);
    process.exit(1);
  } finally {
    client.release();
  }

  const { rows } = await pool.query<{ key: string }>(
    `SELECT key FROM permission WHERE key <> ALL($1::text[])`,
    [PERMISSIONS as readonly string[]],
  );
  if (rows.length > 0) {
    // Not deleted: a tenant may already have granted these, and the foreign key
    // would refuse anyway. resolveAuthContext drops unknown keys, so they are
    // inert — but a human should retire them deliberately.
    console.warn(
      `warning: ${rows.length} permission row(s) are no longer in the union and were left in place: ` +
        rows.map((r) => r.key).join(', '),
    );
  }

  console.log(
    `seeded ${PERMISSIONS.length} permissions and ${ROLE_TEMPLATES.length} role templates`,
  );
  await pool.end();
}

await main();
