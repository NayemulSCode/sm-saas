/**
 * The generated isolation suite. Invariant 1, proven rather than asserted.
 *
 * Both checks are GENERATED FROM pg_catalog rather than written per table.
 * That is the property that makes them survive a Friday afternoon: a developer
 * who adds a table cannot forget to add its test, because the test appears by
 * itself and fails until the policy exists.
 *
 * Runs as its own CI step, BEFORE the main suite, so a tenancy regression is
 * the first thing that fails and is unmistakable in the log rather than one red
 * dot among four hundred.
 *
 * Requires a real PostgreSQL. Set DATABASE_URL_APP / DATABASE_URL_MIGRATOR.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const MIGRATOR_URL = process.env.DATABASE_URL_MIGRATOR ?? process.env.DATABASE_URL_APP;
const APP_URL = process.env.DATABASE_URL_APP;

const TENANT_A = '01930000-0000-7000-8000-00000000000a';
const TENANT_B = '01930000-0000-7000-8000-00000000000b';
const PERSON_A = '01930000-0000-7000-8000-0000000000a1';
const PERSON_B = '01930000-0000-7000-8000-0000000000b1';
const SCHOOL_A = '01930000-0000-7000-8000-0000000000a2';
const SCHOOL_B = '01930000-0000-7000-8000-0000000000b2';
const PLAN_ID = '01930000-0000-7000-8000-0000000000c1';

let admin: Pool;
let app: Pool;
let tenantTables: string[] = [];

/**
 * Two tenants, always. A single-tenant fixture makes cross-tenant bugs
 * invisible — the suite needs a second tenant to leak INTO, or every
 * assertion below passes trivially while proving nothing.
 *
 * Seeded as the superuser, which bypasses RLS by design. Everything the suite
 * then asserts runs as sm_app.
 */
async function seedTwoTenants(): Promise<void> {
  await admin.query(
    `INSERT INTO plan (id, code, name_bn, name_en, price_minor, billing_period)
     VALUES ($1,'isolation-test','পরীক্ষা','Test',0,'monthly')
     ON CONFLICT (id) DO NOTHING`,
    [PLAN_ID],
  );
  for (const [tid, slug] of [
    [TENANT_A, 'isolation-a'],
    [TENANT_B, 'isolation-b'],
  ] as const) {
    await admin.query(
      `INSERT INTO tenant (id, slug, name_bn, name_en, plan_id)
       VALUES ($1,$2,'পরীক্ষা','Test',$3) ON CONFLICT (id) DO NOTHING`,
      [tid, slug, PLAN_ID],
    );
  }
  for (const [pid, tid] of [
    [PERSON_A, TENANT_A],
    [PERSON_B, TENANT_B],
  ] as const) {
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'মোহাম্মদ করিম','Mohammad Karim') ON CONFLICT (id) DO NOTHING`,
      [pid, tid],
    );
  }

  // Seed a second table once structure lands, so the cross-tenant assertions
  // cover more than one table's policy rather than proving `person` alone.
  if (tenantTables.includes('school')) {
    for (const [sid, tid] of [
      [SCHOOL_A, TENANT_A],
      [SCHOOL_B, TENANT_B],
    ] as const) {
      await admin.query(
        `INSERT INTO school (id, tenant_id, name_bn, name_en)
         VALUES ($1,$2,'পরীক্ষা বিদ্যালয়','Test School') ON CONFLICT (id) DO NOTHING`,
        [sid, tid],
      );
    }
  }
}

beforeAll(async () => {
  if (!MIGRATOR_URL || !APP_URL) {
    throw new Error(
      'The isolation suite needs a real PostgreSQL. Set DATABASE_URL_APP (and ' +
        'DATABASE_URL_MIGRATOR). It runs in CI against a postgres service.',
    );
  }
  admin = new Pool({ connectionString: MIGRATOR_URL, max: 4 });
  app = new Pool({ connectionString: APP_URL, max: 4 });

  const { rows } = await admin.query<{ relname: string }>(`
    SELECT c.relname
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    JOIN   pg_attribute a ON a.attrelid = c.oid
                         AND a.attname = 'tenant_id'
                         AND NOT a.attisdropped
    WHERE  n.nspname = 'public' AND c.relkind = 'r'
    ORDER  BY c.relname
  `);
  tenantTables = rows.map((r) => r.relname);

  if (tenantTables.includes('person')) await seedTwoTenants();
});

afterAll(async () => {
  await admin?.end();
  await app?.end();
});

// ── 1. Structural ───────────────────────────────────────────────────────────

describe('structural: every tenant-owned table is protected', () => {
  it('has RLS enabled AND forced AND at least one policy — no exceptions list', async () => {
    const { rows } = await admin.query<{
      relname: string;
      enabled: boolean;
      forced: boolean;
      policies: string;
    }>(`
      SELECT c.relname,
             c.relrowsecurity      AS enabled,
             c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
      FROM   pg_class c
      JOIN   pg_namespace n ON n.oid = c.relnamespace
      JOIN   pg_attribute a ON a.attrelid = c.oid
                           AND a.attname = 'tenant_id'
                           AND NOT a.attisdropped
      WHERE  n.nspname = 'public' AND c.relkind = 'r'
        AND (NOT c.relrowsecurity
             OR NOT c.relforcerowsecurity
             OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid))
    `);

    expect(
      rows,
      `Unprotected tenant tables: ${rows.map((r) => r.relname).join(', ')}. ` +
        'Call app.enable_tenant_rls() in the same migration that creates the table.',
    ).toEqual([]);
  });

  it('has a WITH CHECK clause, not only USING', async () => {
    // USING alone filters reads but still permits writing a row INTO another
    // tenant. polwithcheck being null on a permissive ALL policy is the bug.
    const { rows } = await admin.query<{ relname: string }>(`
      SELECT c.relname
      FROM   pg_policy p
      JOIN   pg_class c ON c.oid = p.polrelid
      JOIN   pg_namespace n ON n.oid = c.relnamespace
      JOIN   pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                           AND NOT a.attisdropped
      WHERE  n.nspname = 'public'
        AND  p.polcmd = '*'
        AND  p.polwithcheck IS NULL
    `);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

// ── 2. Role attributes ──────────────────────────────────────────────────────

describe('roles', () => {
  it('sm_app can never bypass RLS', async () => {
    const { rows } = await admin.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'sm_app'`,
    );
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.rolsuper).toBe(false);
  });

  it('sm_readonly can never bypass RLS', async () => {
    const { rows } = await admin.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'sm_readonly'`,
    );
    expect(rows[0]?.rolbypassrls).toBe(false);
    expect(rows[0]?.rolsuper).toBe(false);
  });
});

// ── 3. The tenancy primitives fail closed ───────────────────────────────────

describe('session primitives', () => {
  it('returns an empty array when the GUC is unset', async () => {
    const c = await app.connect();
    try {
      const { rows } = await c.query<{ ids: string[] }>(
        'SELECT app.current_tenant_ids() AS ids',
      );
      expect(rows[0]?.ids).toEqual([]);
    } finally {
      c.release();
    }
  });

  it('parses a comma-separated list set transaction-locally', async () => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_ids', $1, true)`, [
        `${TENANT_A},${TENANT_B}`,
      ]);
      const { rows } = await c.query<{ n: number }>(
        'SELECT array_length(app.current_tenant_ids(), 1)::int AS n',
      );
      expect(rows[0]?.n).toBe(2);
      await c.query('COMMIT');

      // Transaction-local: it must NOT survive into the next transaction on
      // the same pooled connection.
      const after = await c.query<{ ids: string[] }>('SELECT app.current_tenant_ids() AS ids');
      expect(after.rows[0]?.ids).toEqual([]);
    } finally {
      c.release();
    }
  });
});

// ── 4. Behavioural leakage, per table ───────────────────────────────────────

describe('behavioural: no tenant table leaks', () => {
  it('enumerates tenant-owned tables from the catalogue', () => {
    // Before the first tenant table (migration 0005) this is legitimately
    // empty — the harness must work before it has anything to protect (§11.7).
    expect(Array.isArray(tenantTables)).toBe(true);
  });

  it('returns zero rows for every tenant table when no context is set', async () => {
    const c = await app.connect();
    try {
      for (const table of tenantTables) {
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM public."${table}"`,
        );
        expect(rows[0]?.n, `${table} leaked without a tenant context`).toBe('0');
      }
    } finally {
      c.release();
    }
  });

  it('shows tenant A nothing belonging to tenant B', async () => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_ids', $1, true)`, [TENANT_A]);
      for (const table of tenantTables) {
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM public."${table}" WHERE tenant_id = $1`,
          [TENANT_B],
        );
        expect(rows[0]?.n, `${table} leaked tenant B rows to tenant A`).toBe('0');
      }
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  // The assertion above is only meaningful if tenant B's rows actually exist
  // and are actually invisible. This proves the fixture is real.
  it('shows tenant A its OWN row while tenant B holds one too', async () => {
    const seen = async (tenant: string): Promise<string | undefined> => {
      const c = await app.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.tenant_ids', $1, true)`, [tenant]);
        const { rows } = await c.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM person',
        );
        await c.query('ROLLBACK');
        return rows[0]?.n;
      } finally {
        c.release();
      }
    };

    expect(await seen(TENANT_A)).toBe('1');
    expect(await seen(TENANT_B)).toBe('1');

    // And the superuser, bypassing RLS, sees both — so the rows are genuinely
    // there and RLS is what is hiding them.
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM person WHERE tenant_id = ANY($1::uuid[])',
      [[TENANT_A, TENANT_B]],
    );
    expect(rows[0]?.n).toBe('2');
  });

  // USING alone filters reads but still permits writing a row INTO another
  // tenant. This is what WITH CHECK is for.
  it('refuses to write a row into another tenant', async () => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_ids', $1, true)`, [TENANT_A]);
      await expect(
        c.query(
          `INSERT INTO person (id, tenant_id, name_bn, name_en)
           VALUES (gen_random_uuid(), $1, 'অনুপ্রবেশ', 'Intruder')`,
          [TENANT_B],
        ),
      ).rejects.toThrow(/row-level security/i);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  // Forgetting withTenant() must be harmless, not catastrophic.
  it('cannot insert at all with no tenant context', async () => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await expect(
        c.query(
          `INSERT INTO person (id, tenant_id, name_bn, name_en)
           VALUES (gen_random_uuid(), $1, 'অনুপ্রবেশ', 'Intruder')`,
          [TENANT_A],
        ),
      ).rejects.toThrow(/row-level security/i);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });
});
