/**
 * Context switching, end to end, against real PostgreSQL.
 *
 * The security test that matters is `refuses a membership belonging to ANOTHER
 * account`. The client sends a membership id; if the server trusted it, one
 * user could name another user's membership and be handed their school. That
 * is the whole reason the lookup is by (id AND account_id).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { requestOtp } from './requestOtp';
import { verifyOtp } from './verifyOtp';
import {
  listContexts,
  resolveSession,
  switchContext,
  SessionErrors,
} from './switchContext';
import { codeHasher, tokenGenerator, randomSource } from '../infrastructure/crypto';
import type { OtpDispatcher } from '../domain/ports';
import { Ids } from '../../../shared/ids';


const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const PHONE = '+8801811223344';
const OTHER_PHONE = '+8801822334455';

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const PLAN = nid();
const TENANT_A = nid();
const TENANT_B = nid();
const TENANT_SUSPENDED = nid();
const PERSON_A = nid();
const PERSON_B = nid();
const PERSON_S = nid();
const ACCOUNT = nid();
const CREDENTIAL = nid();
const MEMBERSHIP_A = nid<'membership'>();
const MEMBERSHIP_B = nid<'membership'>();
const MEMBERSHIP_SUSPENDED = nid<'membership'>();

// A second, unrelated account — the one whose membership must stay unreachable.
const OTHER_ACCOUNT = nid();
const OTHER_CREDENTIAL = nid();
const OTHER_PERSON = nid();
const OTHER_MEMBERSHIP = nid<'membership'>();

let admin: Pool;
let token: string;

class CapturingDispatcher implements OtpDispatcher {
  public codes: string[] = [];
  async send(_to: { kind: string; value: string }, code: string): Promise<void> {
    this.codes.push(code);
  }
  last(): string {
    const c = this.codes.at(-1);
    if (!c) throw new Error('no code dispatched');
    return c;
  }
}

const dispatcher = new CapturingDispatcher();
const otpDeps = { codeHasher, random: randomSource, dispatcher };
const sessionDeps = { tokens: tokenGenerator };

async function seedTenant(t: string, slug: string, status: string): Promise<void> {
  await admin.query(
    `INSERT INTO tenant (id, slug, name_bn, name_en, plan_id, status)
     VALUES ($1,$2,'বিদ্যালয়','School',$3,$4) ON CONFLICT DO NOTHING`,
    [uuid(t), slug, uuid(PLAN), status],
  );
}

async function seedPerson(p: string, t: string): Promise<void> {
  await admin.query(
    `INSERT INTO person (id, tenant_id, name_bn, name_en)
     VALUES ($1,$2,'করিম উদ্দিন','Karim Uddin') ON CONFLICT DO NOTHING`,
    [uuid(p), uuid(t)],
  );
}

async function seedMembership(m: string, t: string, a: string, p: string): Promise<void> {
  await admin.query(
    `INSERT INTO membership (id, tenant_id, account_id, person_id, status)
     VALUES ($1,$2,$3,$4,'active') ON CONFLICT DO NOTHING`,
    [uuid(m), uuid(t), uuid(a), uuid(p)],
  );
}

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
     VALUES ($1,'switch-int','পরীক্ষা','Test',0,'monthly') ON CONFLICT DO NOTHING`,
    [uuid(PLAN)],
  );

  await seedTenant(TENANT_A, 'switch-a', 'active');
  await seedTenant(TENANT_B, 'switch-b', 'active');
  await seedTenant(TENANT_SUSPENDED, 'switch-susp', 'suspended');

  await seedPerson(PERSON_A, TENANT_A);
  await seedPerson(PERSON_B, TENANT_B);
  await seedPerson(PERSON_S, TENANT_SUSPENDED);
  await seedPerson(OTHER_PERSON, TENANT_A);

  for (const [acct, cred, phone] of [
    [ACCOUNT, CREDENTIAL, PHONE],
    [OTHER_ACCOUNT, OTHER_CREDENTIAL, OTHER_PHONE],
  ] as const) {
    await admin.query(
      `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn')
       ON CONFLICT DO NOTHING`,
      [uuid(acct)],
    );
    await admin.query(
      `INSERT INTO credential (id, account_id, kind, value, verified_at)
       VALUES ($1,$2,'phone',$3, now()) ON CONFLICT DO NOTHING`,
      [uuid(cred), uuid(acct), phone],
    );
  }

  await seedMembership(MEMBERSHIP_A, TENANT_A, ACCOUNT, PERSON_A);
  await seedMembership(MEMBERSHIP_B, TENANT_B, ACCOUNT, PERSON_B);
  await seedMembership(MEMBERSHIP_SUSPENDED, TENANT_SUSPENDED, ACCOUNT, PERSON_S);
  // Belongs to the OTHER account entirely.
  await seedMembership(OTHER_MEMBERSHIP, TENANT_A, OTHER_ACCOUNT, OTHER_PERSON);

  // Log in once; every test below reuses the session.
  await admin.query('DELETE FROM otp_challenge WHERE credential_id = $1', [uuid(CREDENTIAL)]);
  await requestOtp({ identifier: PHONE }, otpDeps);
  const login = await verifyOtp(
    { identifier: PHONE, code: dispatcher.last() },
    { codeHasher, tokens: tokenGenerator },
  );
  if (!login.ok) throw new Error(`login failed: ${JSON.stringify(login.error)}`);
  token = login.value.sessionToken;
});

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

describe('resolveSession', () => {
  it('resolves a live token to its account', async () => {
    const r = await resolveSession(token, sessionDeps);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.accountId).toBe(ACCOUNT);
  });

  // Absent, revoked, expired and idle-timed-out must be indistinguishable.
  it('refuses an unknown token', async () => {
    const r = await resolveSession('not-a-real-token', sessionDeps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SessionErrors.SESSION_INVALID.code);
  });
});

describe('listContexts', () => {
  it('lists every tenant the account belongs to, with names', async () => {
    const r = await listContexts(token, sessionDeps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const slugs = r.value.map((c) => c.tenantSlug).sort();
    // The suspended tenant IS listed: a suspended tenant keeps read access and
    // export (invariant 14). Only purged and cancelled disappear.
    expect(slugs).toEqual(['switch-a', 'switch-b', 'switch-susp']);
    expect(r.value.every((c) => c.personNameBn.length > 0)).toBe(true);
  });

  it('never lists another account’s membership', async () => {
    const r = await listContexts(token, sessionDeps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((c) => c.membershipId)).not.toContain(OTHER_MEMBERSHIP);
  });
});

describe('switchContext', () => {
  it('activates a legitimate context and persists it on the session', async () => {
    const r = await switchContext(token, MEMBERSHIP_B, sessionDeps);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.tenantSlug).toBe('switch-b');

    const { rows } = await admin.query<{ active_membership_id: string }>(
      `SELECT active_membership_id FROM session
        WHERE account_id = $1 ORDER BY issued_at DESC LIMIT 1`,
      [uuid(ACCOUNT)],
    );
    expect(rows[0]?.active_membership_id).toBe(uuid(MEMBERSHIP_B));
  });

  it('switches back, and the listing marks the active one', async () => {
    await switchContext(token, MEMBERSHIP_A, sessionDeps);
    const r = await listContexts(token, sessionDeps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const active = r.value.filter((c) => c.isActive);
    expect(active).toHaveLength(1);
    expect(active[0]?.tenantSlug).toBe('switch-a');
  });

  /**
   * THE security test.
   *
   * OTHER_MEMBERSHIP is a real, active membership in a real, active tenant —
   * it simply belongs to a different account. If the server looked it up by id
   * alone, this call would succeed and hand one user another user's school.
   */
  it('refuses a membership belonging to ANOTHER account', async () => {
    const r = await switchContext(token, OTHER_MEMBERSHIP, sessionDeps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SessionErrors.CONTEXT_NOT_FOUND.code);

    // And the session was not moved.
    const { rows } = await admin.query<{ active_membership_id: string }>(
      `SELECT active_membership_id FROM session
        WHERE account_id = $1 ORDER BY issued_at DESC LIMIT 1`,
      [uuid(ACCOUNT)],
    );
    expect(rows[0]?.active_membership_id).toBe(uuid(MEMBERSHIP_A));
  });

  // 404 rather than 403: a 403 confirms the membership exists.
  it('returns the same error for a membership that does not exist at all', async () => {
    const r = await switchContext(token, nid<'membership'>(), sessionDeps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SessionErrors.CONTEXT_NOT_FOUND.code);
  });

  it('refuses an unknown session token', async () => {
    const r = await switchContext('bogus', MEMBERSHIP_A, sessionDeps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SessionErrors.SESSION_INVALID.code);
  });

  // A suspended tenant keeps read access and export — it is switchable, and
  // the session comes back read-only (invariant 14).
  it('allows switching into a suspended tenant, read-only', async () => {
    const r = await switchContext(token, MEMBERSHIP_SUSPENDED, sessionDeps);
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const resolved = await resolveSession(token, sessionDeps);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.readOnly).toBe(true);

    // Leave the session somewhere sane for any later test.
    await switchContext(token, MEMBERSHIP_A, sessionDeps);
  });

  it('a revoked session can no longer switch', async () => {
    const login = await (async () => {
      await admin.query('DELETE FROM otp_challenge WHERE credential_id = $1', [
        uuid(CREDENTIAL),
      ]);
      await requestOtp({ identifier: PHONE }, otpDeps);
      return verifyOtp(
        { identifier: PHONE, code: dispatcher.last() },
        { codeHasher, tokens: tokenGenerator },
      );
    })();
    expect(login.ok).toBe(true);
    if (!login.ok) return;

    await admin.query(
      `UPDATE session SET revoked_at = now()
        WHERE token_hash = $1`,
      [tokenGenerator.hashToken(login.value.sessionToken)],
    );

    const r = await switchContext(
      login.value.sessionToken,
      MEMBERSHIP_A,
      sessionDeps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(SessionErrors.SESSION_INVALID.code);
  });
});
