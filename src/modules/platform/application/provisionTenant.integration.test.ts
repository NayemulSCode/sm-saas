/**
 * Provisioning, end to end.
 *
 * The test that matters is the last group: provision a school, then have the
 * owner actually LOG IN and hold real permissions. Until now the role templates
 * were seeded and nothing copied them, so every test built its tenant by hand
 * with raw SQL. This is the first time the system creates a usable school by
 * itself.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { provisionTenant, ProvisionErrors } from './provisionTenant';
import {
  requestOtp,
  verifyOtp,
  resolveAuthContext,
  inviteStaff,
} from '../../identity/index';
import { codeHasher, randomSource, tokenGenerator } from '../../identity/infrastructure/crypto';
import { Ids } from '../../../shared/ids';
import { LocalDate } from '../../../shared/date';
import type { PersonId, RoleId } from '../../../shared/ids';
import type { PlatformContext } from '../../../shared/auth-context';
import { PERMISSIONS, type Permission } from '../../../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const PLAN_CODE = `prov-${Date.now()}`;
const SLUG = `prov-${Date.now()}`;
const OWNER_PHONE = '+8801733000111';
/** Already has an account before provisioning — a guardian who opens a school. */
const REUSED_PHONE = '+8801733000222';

let admin: Pool;
let operator: PlatformContext;

/**
 * A REAL account row. audit_log.actor_account_id references account(id), so an
 * invented operator id fails the insert — the audit trail refusing to record an
 * actor who does not exist.
 */
const OPERATOR_ACCOUNT = nid<'account'>();

/** A fixed clock, so the academic year the test asserts is not the calendar's. */
const clock = { now: () => new Date('2027-03-14T06:00:00.000Z') };

function operatorCtx(permissions: Permission[] = [...PERMISSIONS]): PlatformContext {
  return {
    accountId: OPERATOR_ACCOUNT,
    permissions: new Set(permissions),
    requestId: 'prov-int-request',
    reason: 'provisioning a school for an integration test',
  };
}

const input = (over: Partial<Parameters<typeof provisionTenant>[1]> = {}) => ({
  slug: SLUG,
  nameBn: 'ঢাকা আদর্শ বিদ্যালয়',
  nameEn: 'Dhaka Model School',
  planCode: PLAN_CODE,
  owner: {
    nameBn: 'রেহানা পারভীন',
    nameEn: 'Rehana Parvin',
    phone: OWNER_PHONE,
  },
  ...over,
});

beforeAll(async () => {
  if (!ADMIN_URL || !PLATFORM_URL) {
    throw new Error('Integration tests need DATABASE_URL_MIGRATOR and DATABASE_URL_PLATFORM.');
  }
  vi.stubEnv('APP_URL', 'http://localhost:3000');
  vi.stubEnv('PLATFORM_HOST', 'admin.localhost');
  vi.stubEnv('SESSION_SECRET', 'x'.repeat(32));
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('TZ', 'Asia/Dhaka');

  admin = new Pool({ connectionString: ADMIN_URL, max: 4 });
  operator = operatorCtx();

  await admin.query(
    `INSERT INTO plan (id, code, name_bn, name_en, price_minor, billing_period)
     VALUES ($1,$2,'পরীক্ষা','Test',0,'monthly') ON CONFLICT DO NOTHING`,
    [uuid(nid()), PLAN_CODE],
  );

  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','en') ON CONFLICT DO NOTHING`,
    [uuid(OPERATOR_ACCOUNT)],
  );

  // The account that provisioning must REUSE rather than fork.
  const reused = nid();
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn') ON CONFLICT DO NOTHING`,
    [uuid(reused)],
  );
  await admin.query(
    `INSERT INTO credential (id, account_id, kind, value, verified_at)
     VALUES ($1,$2,'phone',$3, now()) ON CONFLICT DO NOTHING`,
    [uuid(nid()), uuid(reused), REUSED_PHONE],
  );
}, 60_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

const count = async (sql: string, params: unknown[]): Promise<number> => {
  const { rows } = await admin.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? '0');
};

describe('provisioning a school', () => {
  let tenantId: string;

  it('creates everything a school needs, in one transaction', async () => {
    const r = await provisionTenant(operator, input(), { clock });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    tenantId = r.value.tenantId;
    expect(r.value.slug).toBe(SLUG);
    expect(r.value.ownerAccountReused).toBe(false);
    // A fixed March clock, so this is the calendar year and not a surprise.
    expect(r.value.academicYearName).toBe('2027');

    const t = uuid(tenantId);
    expect(await count('SELECT count(*)::text n FROM tenant WHERE id=$1', [t])).toBe(1);
    expect(await count('SELECT count(*)::text n FROM organization WHERE tenant_id=$1', [t])).toBe(1);
    expect(await count('SELECT count(*)::text n FROM school WHERE tenant_id=$1', [t])).toBe(1);
    expect(await count('SELECT count(*)::text n FROM campus WHERE tenant_id=$1', [t])).toBe(1);
    expect(await count('SELECT count(*)::text n FROM shift WHERE tenant_id=$1', [t])).toBe(1);
    expect(await count('SELECT count(*)::text n FROM academic_year WHERE tenant_id=$1', [t])).toBe(1);
    expect(await count('SELECT count(*)::text n FROM person WHERE tenant_id=$1', [t])).toBe(1);
    expect(await count('SELECT count(*)::text n FROM membership WHERE tenant_id=$1', [t])).toBe(1);
    expect(
      await count('SELECT count(*)::text n FROM class_level WHERE tenant_id=$1', [t]),
    ).toBe(r.value.classLevelCount);
    expect(await count('SELECT count(*)::text n FROM role WHERE tenant_id=$1', [t])).toBe(
      r.value.roleCount,
    );
  }, 60_000);

  it('starts on trial, on the primary shard, with the organization linked back', async () => {
    const { rows } = await admin.query<{
      status: string;
      shard_id: string;
      organization_id: string | null;
    }>('SELECT status, shard_id, organization_id FROM tenant WHERE id=$1', [uuid(tenantId)]);

    expect(rows[0]?.status).toBe('trial');
    expect(rows[0]?.shard_id).toBe('primary');
    // The FK that could not be set at insert time — organization is
    // tenant-owned and so could not exist before the tenant did.
    expect(rows[0]?.organization_id).not.toBeNull();
  }, 30_000);

  it('gives the school one primary campus and one current, active year', async () => {
    const t = uuid(tenantId);
    expect(
      await count('SELECT count(*)::text n FROM campus WHERE tenant_id=$1 AND is_primary', [t]),
    ).toBe(1);

    const { rows } = await admin.query<{ name: string; status: string; start_date: string }>(
      'SELECT name, status, start_date FROM academic_year WHERE tenant_id=$1 AND is_current',
      [t],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('active');
    expect(rows[0]?.name).toBe('2027');
    expect(String(rows[0]?.start_date)).toContain('2027-01-01');
  }, 30_000);

  it('copies the role templates into the tenant, permissions and all', async () => {
    const t = uuid(tenantId);
    const { rows } = await admin.query<{ code: string; is_system: boolean; n: string }>(
      `SELECT r.code, r.is_system, count(rp.id)::text AS n
       FROM role r LEFT JOIN role_permission rp ON rp.role_id = r.id
       WHERE r.tenant_id = $1 GROUP BY r.code, r.is_system ORDER BY r.code`,
      [t],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.is_system)).toBe(true);

    const principal = rows.find((r) => r.code === 'Principal');
    expect(principal, 'a school with no Principal has nobody who can run it').toBeDefined();
    expect(Number(principal!.n)).toBeGreaterThan(0);

    // Copied, not referenced: editing one school's role must not touch another.
    expect(
      await count(
        `SELECT count(*)::text n FROM role_permission
         WHERE tenant_id=$1 AND permission_key='membership.manage'`,
        [t],
      ),
    ).toBeGreaterThan(0);
  }, 30_000);

  it('writes tenant.provisioned as the school’s first audit row', async () => {
    const { rows } = await admin.query<{
      action: string;
      reason: string;
      actor_person_id: string | null;
      actor_account_id: string;
      after: Record<string, unknown>;
    }>(
      `SELECT action, reason, actor_person_id, actor_account_id, after
       FROM audit_log WHERE tenant_id = $1 ORDER BY at LIMIT 1`,
      [uuid(tenantId)],
    );

    expect(rows[0]?.action).toBe('tenant.provisioned');
    expect(rows[0]?.reason).toBe(operator.reason);
    // An OPERATOR has no person row in this tenant — the account identifies
    // them, and actor_person_id is honestly null rather than invented.
    expect(rows[0]?.actor_person_id).toBeNull();
    expect(rows[0]?.actor_account_id).toBe(uuid(operator.accountId!));
    expect(rows[0]?.after?.['ownerAccountReused']).toBe(false);
  }, 30_000);
});

describe('the owner can actually use the school', () => {
  let tenantId: string;
  let ownerPersonId: PersonId;
  const slug = `prov-usable-${Date.now()}`;
  const phone = '+8801733000333';

  it('provisions, then logs the owner in by OTP with no password anywhere', async () => {
    const r = await provisionTenant(
      operator,
      input({
        slug,
        owner: { nameBn: 'শাহিদা খাতুন', nameEn: 'Shahida Khatun', phone },
      }),
      { clock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    tenantId = r.value.tenantId;
    ownerPersonId = r.value.ownerPersonId;

    let code: string | undefined;
    await requestOtp(
      { identifier: phone },
      {
        codeHasher,
        random: randomSource,
        dispatcher: { send: async (_to, c) => void (code = c) },
      },
    );
    expect(code, 'the owner must be reachable by OTP on day one').toMatch(/^\d{6}$/);

    const login = await verifyOtp(
      { identifier: phone, code: code! },
      { codeHasher, tokens: tokenGenerator },
    );
    expect(login.ok, JSON.stringify(login)).toBe(true);
    if (!login.ok) return;

    // One school, so the context activates immediately.
    expect(login.value.contextCount).toBe(1);
    expect(login.value.contexts[0]?.tenantId).toBe(tenantId);

    /*
     * The whole chain: provisioned roles → membership_role → role_permission →
     * a real AuthContext. Before this existed the permission set was always
     * empty and every authorised endpoint answered 403.
     */
    const ctx = await resolveAuthContext(login.value.sessionToken, { tokens: tokenGenerator });
    expect(ctx.ok, JSON.stringify(ctx)).toBe(true);
    if (!ctx.ok) return;

    expect(ctx.value.activeTenantId).toBe(tenantId);
    expect(ctx.value.personId).toBe(ownerPersonId);
    expect(ctx.value.readOnly).toBe(false);
    expect(ctx.value.permissions.has('membership.manage')).toBe(true);
    expect(ctx.value.permissions.has('student.write')).toBe(true);
    // §9.6 — modules that do not ship in 3a are declared but not granted.
    expect(ctx.value.permissions.has('fee.collect')).toBe(false);
    // The owner is not scoped to a campus.
    expect(ctx.value.scope).toEqual({});

    // And they can do the first thing a principal needs to do: hire someone.
    const person = nid<'person'>();
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'নতুন শিক্ষক','New Teacher')`,
      [uuid(person), uuid(tenantId)],
    );
    const invited = await inviteStaff(
      ctx.value,
      { personId: person, identifier: `first-hire-${Date.now()}@prov.example.bd`, roleIds: [] as RoleId[] },
      { tokens: tokenGenerator },
    );
    expect(invited.ok, JSON.stringify(invited)).toBe(true);
  }, 120_000);
});

describe('refusals', () => {
  it('refuses an operator without platform.tenant.provision', async () => {
    await expect(
      provisionTenant(operatorCtx(['student.read']), input({ slug: `nope-${Date.now()}` }), {
        clock,
      }),
    ).rejects.toThrow(/platform.tenant.provision/);
  }, 30_000);

  // The reason is audited, so it cannot be a shrug.
  it('refuses an operator with no substantive reason', async () => {
    await expect(
      provisionTenant(
        { ...operatorCtx(), reason: 'x' },
        input({ slug: `nope2-${Date.now()}` }),
        { clock },
      ),
    ).rejects.toThrow(/reason/);
  }, 30_000);

  it('refuses a slug the database CHECK would reject, before touching the database', async () => {
    const r = await provisionTenant(operator, input({ slug: 'Bad Slug' }), { clock });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ProvisionErrors.INVALID_SLUG.code);
  }, 30_000);

  it('refuses a duplicate slug rather than half-creating a second school', async () => {
    const before = await count('SELECT count(*)::text n FROM tenant WHERE slug=$1', [SLUG]);
    const r = await provisionTenant(operator, input(), { clock });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ProvisionErrors.SLUG_TAKEN.code);
    expect(await count('SELECT count(*)::text n FROM tenant WHERE slug=$1', [SLUG])).toBe(before);
  }, 30_000);

  it('refuses an unknown plan', async () => {
    const r = await provisionTenant(
      operator,
      input({ slug: `noplan-${Date.now()}`, planCode: 'does-not-exist' }),
      { clock },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(ProvisionErrors.PLAN_NOT_FOUND.code);
  }, 30_000);

  it('refuses an owner phone that is not E.164 Bangladesh', async () => {
    for (const bad of ['01733000111', '+8801033000111', '+447700900000', 'not a phone']) {
      const r = await provisionTenant(
        operator,
        input({ slug: `badphone-${Date.now()}`, owner: { nameBn: 'ক', nameEn: 'K', phone: bad } }),
        { clock },
      );
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(ProvisionErrors.INVALID_OWNER_PHONE.code);
    }
  }, 30_000);
});

/*
 * The case the identity model exists for, arriving from the other direction: a
 * guardian at one school opens their own. One human, one login, two schools.
 */
describe('an owner who already has an account', () => {
  it('reuses the login and adds a membership instead of forking the identity', async () => {
    const before = await count(
      `SELECT count(*)::text n FROM credential WHERE kind='phone' AND value=$1`,
      [REUSED_PHONE],
    );
    expect(before).toBe(1);

    const r = await provisionTenant(
      operator,
      input({
        slug: `reuse-${Date.now()}`,
        owner: { nameBn: 'কামরুল হাসান', nameEn: 'Kamrul Hasan', phone: REUSED_PHONE },
      }),
      { clock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.value.ownerAccountReused).toBe(true);

    // Still exactly one credential: a second would be a second identity for
    // one human, which is the bug ADR-0006 exists to prevent.
    expect(
      await count(`SELECT count(*)::text n FROM credential WHERE kind='phone' AND value=$1`, [
        REUSED_PHONE,
      ]),
    ).toBe(1);

    expect(
      await count('SELECT count(*)::text n FROM membership WHERE account_id=$1', [
        uuid(r.value.ownerAccountId),
      ]),
    ).toBe(1);

    // A distinct PERSON row in the new school, though: personal data is
    // per-tenant and lives behind RLS.
    const { rows } = await admin.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM person WHERE id=$1',
      [uuid(r.value.ownerPersonId)],
    );
    expect(rows[0]?.tenant_id).toBe(uuid(r.value.tenantId));
  }, 60_000);
});

/*
 * The CLI path. `pnpm provision` has no operator account behind it — only
 * whoever holds the platform database credentials — so the audit row records a
 * null actor rather than an invented one.
 */
describe('provisioning with no operator account', () => {
  it('records a null actor rather than inventing one', async () => {
    const { accountId: _drop, ...anonymous } = operatorCtx();
    const r = await provisionTenant(
      anonymous,
      input({ slug: `cli-${Date.now()}` }),
      { clock },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    const { rows } = await admin.query<{
      actor_account_id: string | null;
      actor_person_id: string | null;
      reason: string;
    }>(
      `SELECT actor_account_id, actor_person_id, reason FROM audit_log
       WHERE tenant_id = $1 AND action = 'tenant.provisioned'`,
      [uuid(r.value.tenantId)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_account_id).toBeNull();
    expect(rows[0]?.actor_person_id).toBeNull();
    // The reason is still mandatory: it is the only trace of who and why.
    expect(rows[0]?.reason).toBe(anonymous.reason);
  }, 60_000);
});

describe('the fixed clock', () => {
  it('rolls a November signup into next year', async () => {
    const november = { now: () => new Date('2027-11-20T06:00:00.000Z') };
    const r = await provisionTenant(operator, input({ slug: `nov-${Date.now()}` }), {
      clock: november,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    // Nobody sets up a school system to run the six weeks that are left.
    expect(r.value.academicYearName).toBe('2028');
    expect(LocalDate.toISO(LocalDate.of(2028, 1, 1))).toBe('2028-01-01');
  }, 60_000);
});
