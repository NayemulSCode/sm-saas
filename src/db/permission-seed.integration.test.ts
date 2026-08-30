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

  // §9.6 — modules that do not ship yet are declared but not granted.
  // `fee.` moved out of this list when Phase 3b's first slice shipped
  // finance — LIVE_IN_3A is, per its own comment, "the single thing that
  // relaxes" when a phase ships, and this is that relaxation.
  it('does not grant permissions for modules that do not exist yet', async () => {
    const { rows } = await admin.query<{ code: string; permissions: string[] }>(
      'SELECT code, permissions FROM role_template',
    );
    for (const row of rows) {
      expect(row.permissions.filter((p) => p.startsWith('mark.')), row.code).toEqual([]);
      expect(row.permissions.filter((p) => p.startsWith('platform.')), row.code).toEqual([]);
    }
  });
});
