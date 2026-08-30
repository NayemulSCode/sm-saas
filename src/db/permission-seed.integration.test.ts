/**
 * The permission vocabulary in the database must equal the closed union in
 * TypeScript.
 *
 * `role_permission.permission_key` has a foreign key to `permission(key)`, so a
 * permission missing from the table is not a cosmetic gap — it is a permission
 * that CANNOT BE GRANTED. The failure mode is silent and total: the role saves,
 * the grant is refused by the FK or the key never resolves, and every endpoint
 * guarded by it returns 403 forever.
 *
 * That is why this is a test and not a comment.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PERMISSIONS, DANGEROUS_PERMISSIONS, isPermission } from '../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;

let admin: Pool;

beforeAll(() => {
  if (!ADMIN_URL) throw new Error('Integration tests need DATABASE_URL_MIGRATOR.');
  admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
});

afterAll(async () => {
  await admin?.end();
});

describe('the seeded permission vocabulary', () => {
  it('contains every permission in the union', async () => {
    const { rows } = await admin.query<{ key: string }>('SELECT key FROM permission');
    const seeded = new Set(rows.map((r) => r.key));

    const missing = PERMISSIONS.filter((p) => !seeded.has(p));
    expect(
      missing,
      `Run "pnpm seed". These permissions cannot be granted until they are in the table.`,
    ).toEqual([]);
  });

  it('contains nothing the union does not declare', async () => {
    const { rows } = await admin.query<{ key: string }>('SELECT key FROM permission');
    // A stale row is inert — resolveAuthContext drops unknown keys — but it
    // means someone removed a permission without retiring its grants.
    expect(rows.map((r) => r.key).filter((k) => !isPermission(k))).toEqual([]);
  });

  it('flags exactly the dangerous permissions', async () => {
    const { rows } = await admin.query<{ key: string }>(
      'SELECT key FROM permission WHERE is_dangerous',
    );
    expect(new Set(rows.map((r) => r.key))).toEqual(new Set<string>(DANGEROUS_PERMISSIONS));
  });

  it('gives every permission a module', async () => {
    const { rows } = await admin.query<{ key: string }>(
      `SELECT key FROM permission WHERE module IS NULL OR module = ''`,
    );
    expect(rows.map((r) => r.key)).toEqual([]);
  });
});

describe('the seeded role templates', () => {
  it('grants only permissions that exist', async () => {
    const { rows } = await admin.query<{ code: string; permissions: string[] }>(
      'SELECT code, permissions FROM role_template',
    );
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const unknown = row.permissions.filter((p) => !isPermission(p));
      expect(unknown, `role_template ${row.code} grants unknown permissions`).toEqual([]);
    }
  });

  // The whole identity chain is unreachable without it: nobody could invite the
  // second staff member of a school.
  it('gives Principal membership.manage', async () => {
    const { rows } = await admin.query<{ permissions: string[] }>(
      `SELECT permissions FROM role_template WHERE code = 'Principal'`,
    );
    expect(rows[0]?.permissions).toContain('membership.manage');
  });

  // §9.6 — modules that do not ship yet are declared but not granted. Finance
  // moved off this list once fee heads and fee structures had real use cases
  // behind them (Phase 3b) — see the assertions below instead.
  it('does not grant permissions for modules that still do not exist', async () => {
    const { rows } = await admin.query<{ code: string; permissions: string[] }>(
      'SELECT code, permissions FROM role_template',
    );
    for (const row of rows) {
      expect(row.permissions.filter((p) => p.startsWith('mark.')), row.code).toEqual([]);
      expect(row.permissions.filter((p) => p.startsWith('platform.')), row.code).toEqual([]);
    }
  });

  /*
   * The flip itself. §9.6's filter is the ONE thing that changes when a module
   * ships — the specific assertion the previous test used to make (no `fee.*`
   * anywhere) would now be silently wrong, so this is the replacement: the
   * separations §9.5 cares about most (collect vs waive, read vs write) must
   * survive the trip through `pnpm seed` into the actual table, not just hold
   * in `role-templates.ts`.
   */
  it('grants finance permissions now that the module has use cases', async () => {
    const { rows } = await admin.query<{ code: string; permissions: string[] }>(
      `SELECT code, permissions FROM role_template
       WHERE code IN ('Principal', 'Accountant', 'OfficeAssistant', 'Guardian')`,
    );
    const by = new Map(rows.map((r) => [r.code, r.permissions]));

    expect(by.get('Principal')).toEqual(expect.arrayContaining(['fee.structure.manage', 'fee.waive']));
    // The office assistant takes money; only the principal forgives it.
    expect(by.get('Accountant')).toEqual(expect.arrayContaining(['fee.collect', 'fee.reconcile']));
    expect(by.get('Accountant')).not.toContain('fee.waive');
    expect(by.get('OfficeAssistant')).toContain('fee.collect');
    expect(by.get('OfficeAssistant')).not.toContain('fee.waive');
    // A guardian reads their own child's fees. `attendance.read` and
    // `result.read` are also DECLARED for Guardian (§9.2) but not granted —
    // calendar/attendance and assessment have not shipped yet, so only the
    // directory and finance permissions actually land in the table.
    expect(new Set(by.get('Guardian'))).toEqual(new Set(['fee.read', 'student.read']));
  });
});
