/**
 * The audit trail, written by real use cases against a real database.
 *
 * The unit tests prove redaction is correct in isolation. These prove it is
 * actually WIRED — that a login leaves a row, that a revocation carries its
 * reason, and that nothing anybody typed ends up stored in either table.
 *
 * The last one is the assertion that matters: a redaction function nobody
 * calls is worth nothing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { requestOtp } from './requestOtp';
import { authenticatePassword } from './authenticatePassword';
import { inviteStaff, revokeInvite } from './inviteStaff';
import { acceptInvite } from './acceptInvite';
import { codeHasher, passwordHasher, randomSource, tokenGenerator } from '../infrastructure/crypto';
import { Ids } from '../../../shared/ids';
import { hashIdentifier, REDACTED } from '../../../db/audit';
import type { AuthContext } from '../../../shared/auth-context';
import type { RoleId } from '../../../shared/ids';
import { PERMISSIONS, type Permission } from '../../../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const PLAN = nid();
const TENANT = nid<'tenant'>();
const ADMIN_PERSON = nid<'person'>();
const STAFF_PERSON = nid<'person'>();
/*
 * A REAL account row, not an invented id. audit_log.actor_account_id has a
 * foreign key to account(id), so a context carrying a fictional account now
 * fails the insert — which is the audit trail refusing to record an actor who
 * does not exist.
 */
const ADMIN_ACCOUNT = nid<'account'>();

/** Real-looking, and therefore exactly what must not appear in the tables. */
const KNOWN_PHONE = '+8801912345678';
const UNKNOWN_PHONE = '+8801987654321';
const STAFF_EMAIL = 'audit-subject@audit-int.example.bd';
const CHOSEN_PASSWORD = 'the password nobody should be able to read';

let admin: Pool;

function adminCtx(): AuthContext {
  return {
    accountId: ADMIN_ACCOUNT,
    sessionId: nid(),
    tenantIds: [TENANT],
    activeTenantId: TENANT,
    personId: ADMIN_PERSON,
    membershipId: nid<'membership'>(),
    permissions: new Set<Permission>(PERMISSIONS),
    scope: {},
    locale: 'bn',
    requestId: 'audit-int-request',
    readOnly: false,
  };
}

const otpDeps = {
  codeHasher,
  random: randomSource,
  dispatcher: { send: async () => undefined },
};

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

  await admin.query(
    `INSERT INTO plan (id, code, name_bn, name_en, price_minor, billing_period)
     VALUES ($1,'audit-int','পরীক্ষা','Test',0,'monthly') ON CONFLICT DO NOTHING`,
    [uuid(PLAN)],
  );
  await admin.query(
    `INSERT INTO tenant (id, slug, name_bn, name_en, plan_id, status)
     VALUES ($1,'audit-int','বিদ্যালয়','School',$2,'active') ON CONFLICT DO NOTHING`,
    [uuid(TENANT), uuid(PLAN)],
  );
  for (const p of [ADMIN_PERSON, STAFF_PERSON]) {
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'নাজমুল হক','Nazmul Haque') ON CONFLICT DO NOTHING`,
      [uuid(p), uuid(TENANT)],
    );
  }

  // The administrator's account: it can receive an OTP, and it is the actor
  // every audit_log row below points at.
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn') ON CONFLICT DO NOTHING`,
    [uuid(ADMIN_ACCOUNT)],
  );
  await admin.query(
    `INSERT INTO credential (id, account_id, kind, value, verified_at)
     VALUES ($1,$2,'phone',$3, now()) ON CONFLICT DO NOTHING`,
    [uuid(nid()), uuid(ADMIN_ACCOUNT), KNOWN_PHONE],
  );
  await admin.query(
    `INSERT INTO membership (id, tenant_id, account_id, person_id, status)
     VALUES ($1,$2,$3,$4,'active') ON CONFLICT DO NOTHING`,
    [uuid(nid()), uuid(TENANT), uuid(ADMIN_ACCOUNT), uuid(ADMIN_PERSON)],
  );
}, 60_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

const authEvents = async (type: string, identifier?: string) => {
  const { rows } = await admin.query<{
    type: string;
    outcome: string;
    reason: string | null;
    detail: Record<string, unknown>;
    request_id: string;
  }>(
    identifier
      ? `SELECT type, outcome, reason, detail, request_id FROM auth_event
         WHERE type = $1 AND identifier_hash = $2 ORDER BY at DESC`
      : `SELECT type, outcome, reason, detail, request_id FROM auth_event
         WHERE type = $1 ORDER BY at DESC`,
    identifier ? [type, hashIdentifier(identifier)] : [type],
  );
  return rows;
};

describe('authentication leaves a trail', () => {
  it('records a dispatched OTP against the identifier', async () => {
    await admin.query('DELETE FROM auth_event');
    await requestOtp({ identifier: KNOWN_PHONE, requestId: 'req-otp-ok' }, otpDeps);

    const rows = await authEvents('otp.requested', KNOWN_PHONE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('success');
    expect(rows[0]?.detail).toEqual({ dispatched: true });
    expect(rows[0]?.request_id).toBe('req-otp-ok');
  }, 30_000);

  /*
   * The endpoint answers identically for a known and an unknown number, on
   * purpose. The audit trail is where that difference has to survive, or a
   * number-sweeping attack is invisible.
   */
  it('records a request for an unknown number, which the response hides', async () => {
    await requestOtp({ identifier: UNKNOWN_PHONE, requestId: 'req-otp-unknown' }, otpDeps);

    const rows = await authEvents('otp.requested', UNKNOWN_PHONE);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('failure');
    expect(rows[0]?.reason).toBe('unknown_identifier');
  }, 30_000);

  it('records a failed password attempt with the reason the caller never sees', async () => {
    await authenticatePassword(
      { identifier: KNOWN_PHONE, password: 'not the password', requestId: 'req-pw' },
      { hasher: passwordHasher, tokens: tokenGenerator },
    );

    const rows = await authEvents('password.attempted', KNOWN_PHONE);
    expect(rows[0]?.outcome).toBe('failure');
    // The caller got INVALID_CREDENTIALS; the trail knows it was OTP-only.
    expect(rows[0]?.reason).toBe('no_password_set');
  }, 30_000);

  // The identifier is PII. Only its hash may be stored.
  it('stores the identifier hashed, never in the clear', async () => {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM auth_event
       WHERE identifier_hash::text LIKE '%8801912345678%'
          OR reason LIKE '%8801912345678%'
          OR detail::text LIKE '%8801912345678%'`,
    );
    expect(rows[0]?.n).toBe('0');

    // And the hash we can compute does find the row, so it is genuinely there.
    expect((await authEvents('otp.requested', KNOWN_PHONE)).length).toBeGreaterThan(0);
  }, 30_000);
});

describe('tenant mutations leave a trail', () => {
  let membershipId: string;
  let inviteToken: string;

  it('records invite.created with the actor and the tenant', async () => {
    const r = await inviteStaff(
      adminCtx(),
      { personId: STAFF_PERSON, identifier: STAFF_EMAIL, roleIds: [] as RoleId[] },
      { tokens: tokenGenerator },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    membershipId = r.value.membershipId;
    inviteToken = r.value.inviteToken!;

    const { rows } = await admin.query<{
      action: string;
      actor_person_id: string;
      tenant_id: string;
      request_id: string;
      after: Record<string, unknown>;
      reason: string | null;
    }>(
      `SELECT action, actor_person_id, tenant_id, request_id, after, reason
       FROM audit_log WHERE entity_id = $1 ORDER BY at`,
      [uuid(membershipId)],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('invite.created');
    expect(rows[0]?.actor_person_id).toBe(uuid(ADMIN_PERSON));
    expect(rows[0]?.tenant_id).toBe(uuid(TENANT));
    expect(rows[0]?.request_id).toBe('audit-int-request');
    // Ids survive redaction; the count is a number, so it does not.
    expect(rows[0]?.after?.['inviteLinkIssued']).toBe(true);
    expect(rows[0]?.after?.['roleCount']).toBe(REDACTED);
  }, 30_000);

  it('records the accepted invite globally, because acceptance has no tenant session', async () => {
    const r = await acceptInvite(
      { token: inviteToken, password: CHOSEN_PASSWORD, requestId: 'req-accept' },
      { hasher: passwordHasher, tokens: tokenGenerator },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const rows = await authEvents('invite.accepted');
    expect(rows[0]?.outcome).toBe('success');
    expect(rows[0]?.detail?.['passwordSet']).toBe(true);
    // `detail` is jsonb: it holds the ULID the application passed, not the
    // uuid representation the id COLUMNS are stored in.
    expect(rows[0]?.detail?.['membershipId']).toBe(membershipId);
  }, 60_000);

  it('carries the reason on a revocation, and refuses to record one without', async () => {
    const person = nid<'person'>();
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'রেভোক','Revoke')`,
      [uuid(person), uuid(TENANT)],
    );
    const invited = await inviteStaff(
      adminCtx(),
      { personId: person, identifier: `rev-${Date.now()}@audit-int.example.bd`, roleIds: [] },
      { tokens: tokenGenerator },
    );
    expect(invited.ok).toBe(true);
    if (!invited.ok) return;

    const reason = 'invited the wrong person';
    await revokeInvite(adminCtx(), invited.value.membershipId, reason);

    const { rows } = await admin.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_log
       WHERE entity_id = $1 AND action = 'invite.revoked'`,
      [uuid(invited.value.membershipId)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe(reason);

    /*
     * A blank reason must be refused by audit() itself, not merely by the DTO,
     * so a future caller reaching the use case directly cannot skip it. It
     * needs a FRESH invite: the one above is already revoked, so the use case
     * would return INVITE_NOT_FOUND before ever reaching audit().
     */
    const second = nid<'person'>();
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'রেভোক দুই','Revoke Two')`,
      [uuid(second), uuid(TENANT)],
    );
    const live = await inviteStaff(
      adminCtx(),
      { personId: second, identifier: `rev2-${Date.now()}@audit-int.example.bd`, roleIds: [] },
      { tokens: tokenGenerator },
    );
    expect(live.ok).toBe(true);
    if (!live.ok) return;

    await expect(
      revokeInvite(adminCtx(), live.value.membershipId, '   '),
    ).rejects.toThrow(/may not be recorded without a reason/);

    /*
     * And the revocation ROLLED BACK with it. audit() runs inside the same
     * transaction as the change it describes, so a mutation that cannot be
     * audited does not happen at all — which is what "every mutation is
     * audited" has to mean to be worth anything.
     */
    const { rows: still } = await admin.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM staff_invite WHERE membership_id = $1`,
      [uuid(live.value.membershipId)],
    );
    expect(still[0]?.revoked_at).toBeNull();
  }, 60_000);
});

/*
 * The end-to-end statement of invariant 12 and non-negotiable 4. Everything
 * above wrote real rows from real input; this asserts that none of that input
 * survived into either table.
 */
describe('no personal data reaches the audit tables', () => {
  it('holds no phone number, email, name or password anywhere', async () => {
    const needles = [
      '8801912345678',
      '8801987654321',
      STAFF_EMAIL,
      CHOSEN_PASSWORD,
      'Nazmul Haque',
      'নাজমুল হক',
    ];

    for (const needle of needles) {
      const audit = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log
         WHERE before::text LIKE '%' || $1 || '%'
            OR after::text  LIKE '%' || $1 || '%'
            OR reason       LIKE '%' || $1 || '%'
            OR entity_type  LIKE '%' || $1 || '%'`,
        [needle],
      );
      expect(audit.rows[0]?.n, `audit_log contains "${needle}"`).toBe('0');

      const auth = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM auth_event
         WHERE detail::text LIKE '%' || $1 || '%'
            OR reason       LIKE '%' || $1 || '%'
            OR user_agent   LIKE '%' || $1 || '%'`,
        [needle],
      );
      expect(auth.rows[0]?.n, `auth_event contains "${needle}"`).toBe('0');
    }
  }, 30_000);
});
