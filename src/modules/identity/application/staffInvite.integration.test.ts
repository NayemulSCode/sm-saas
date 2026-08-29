/**
 * Staff invitations, end to end.
 *
 * Two cases matter and pull in opposite directions:
 *
 *   1. A brand-new staff member sets a password from a single-use link, so no
 *      password is ever transmitted (§8.4).
 *   2. A teacher who ALREADY has an account at another school gets a second
 *      MEMBERSHIP and keeps their existing password (ADR-0006). Re-setting it
 *      from an emailed link would be a takeover vector.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { inviteStaff, revokeInvite, InviteErrors } from './inviteStaff';
import { acceptInvite, AcceptInviteErrors } from './acceptInvite';
import { authenticatePassword } from './authenticatePassword';
import { passwordHasher, tokenGenerator } from '../infrastructure/crypto';
import { Ids } from '../../../shared/ids';
import type { AuthContext } from '../../../shared/auth-context';
import type { MembershipId, PersonId, RoleId, TenantId } from '../../../shared/ids';
import { PERMISSIONS, type Permission } from '../../../shared/permissions';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

/*
 * Per-run natural keys: slugs, plan codes and phone numbers all carry unique
 * constraints, and every fixture insert here says `ON CONFLICT DO NOTHING`.
 * Hold them constant and run two silently skips the insert, leaving the
 * freshly generated id pointing at nothing — which surfaces later as a foreign
 * key violation on an unrelated table, or as NO_ACTIVE_CONTEXT once an account
 * has collected a membership per run. CI starts from an empty database and
 * never sees any of it.
 */
const STAMP = Date.now();

const PLAN = nid();
const TENANT_A = nid<'tenant'>();
const TENANT_B = nid<'tenant'>();
const ADMIN_PERSON = nid<'person'>();
const NEW_PERSON = nid<'person'>();
const EXISTING_PERSON_A = nid<'person'>();
const EXISTING_PERSON_B = nid<'person'>();
const EXISTING_ACCOUNT = nid();
/* Real, because audit_log.actor_account_id references account(id). */
const ADMIN_ACCOUNT = nid<'account'>();

const NEW_EMAIL = `newteacher-${STAMP}@invite-int.example.bd`;
const EXISTING_EMAIL = `veteran-${STAMP}@invite-int.example.bd`;
const EXISTING_PASSWORD = 'the password they already use';

let admin: Pool;
const deps = { tokens: tokenGenerator };
const acceptDeps = { hasher: passwordHasher, tokens: tokenGenerator };

/** An authenticated school administrator in tenant A. */
function adminCtx(tenantId: TenantId, personId: PersonId): AuthContext {
  return {
    accountId: ADMIN_ACCOUNT,
    sessionId: nid(),
    tenantIds: [tenantId],
    activeTenantId: tenantId,
    personId,
    membershipId: nid<'membership'>(),
    permissions: new Set<Permission>(PERMISSIONS),
    scope: {},
    locale: 'bn',
    requestId: 'test',
    readOnly: false,
  };
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
     VALUES ($1,$2,'পরীক্ষা','Test',0,'monthly') ON CONFLICT DO NOTHING`,
    [uuid(PLAN), `invite-int-${STAMP}`],
  );
  for (const [t, slug] of [
    [TENANT_A, `invite-a-${STAMP}`],
    [TENANT_B, `invite-b-${STAMP}`],
  ] as const) {
    await admin.query(
      `INSERT INTO tenant (id, slug, name_bn, name_en, plan_id, status)
       VALUES ($1,$2,'বিদ্যালয়','School',$3,'active') ON CONFLICT DO NOTHING`,
      [uuid(t), slug, uuid(PLAN)],
    );
  }
  for (const [p, t] of [
    [ADMIN_PERSON, TENANT_A],
    [NEW_PERSON, TENANT_A],
    [EXISTING_PERSON_A, TENANT_A],
    [EXISTING_PERSON_B, TENANT_B],
  ] as const) {
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'ফারহানা ইসলাম','Farhana Islam') ON CONFLICT DO NOTHING`,
      [uuid(p), uuid(t)],
    );
  }

  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn') ON CONFLICT DO NOTHING`,
    [uuid(ADMIN_ACCOUNT)],
  );

  // A teacher who already works at school B, with a password.
  const hash = await passwordHasher.hash(EXISTING_PASSWORD);
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn') ON CONFLICT DO NOTHING`,
    [uuid(EXISTING_ACCOUNT)],
  );
  await admin.query(
    `INSERT INTO credential (id, account_id, kind, value, password_hash, verified_at)
     VALUES ($1,$2,'email',$3,$4, now()) ON CONFLICT DO NOTHING`,
    [uuid(nid()), uuid(EXISTING_ACCOUNT), EXISTING_EMAIL, hash],
  );
  await admin.query(
    `INSERT INTO membership (id, tenant_id, account_id, person_id, status)
     VALUES ($1,$2,$3,$4,'active') ON CONFLICT DO NOTHING`,
    [uuid(nid()), uuid(TENANT_B), uuid(EXISTING_ACCOUNT), uuid(EXISTING_PERSON_B)],
  );
}, 60_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

describe('inviting a brand-new staff member', () => {
  let token: string;
  let membershipId: MembershipId;

  it('creates a login, a membership and a single-use link', async () => {
    const r = await inviteStaff(
      adminCtx(TENANT_A, ADMIN_PERSON),
      { personId: NEW_PERSON, identifier: NEW_EMAIL, roleIds: [] },
      deps,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.value.inviteToken).toBeTruthy();
    token = r.value.inviteToken!;
    membershipId = r.value.membershipId;

    // Only the HASH is stored — a leak of the table must not yield live links.
    const { rows } = await admin.query<{ token_hash: Buffer }>(
      `SELECT token_hash FROM staff_invite WHERE membership_id = $1`,
      [uuid(membershipId)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.toString('utf8')).not.toContain(token);

    // And no password exists yet: nothing was transmitted.
    const cred = await admin.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM credential WHERE value = $1`,
      [NEW_EMAIL],
    );
    expect(cred.rows[0]?.password_hash).toBeNull();
  }, 30_000);

  it('refuses to invite the same person twice', async () => {
    const r = await inviteStaff(
      adminCtx(TENANT_A, ADMIN_PERSON),
      { personId: NEW_PERSON, identifier: NEW_EMAIL, roleIds: [] },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(InviteErrors.ALREADY_A_MEMBER.code);
  }, 30_000);

  it('accepts the invite, sets a password and opens a session', async () => {
    const r = await acceptInvite({ token, password: 'a brand new password' }, acceptDeps);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    expect(r.value.sessionToken).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(r.value.contextCount).toBe(1);

    // The password now works on the normal login path.
    const login = await authenticatePassword(
      { identifier: NEW_EMAIL, password: 'a brand new password' },
      { hasher: passwordHasher, tokens: tokenGenerator },
    );
    expect(login.ok).toBe(true);
  }, 60_000);

  // Whoever holds the link can take the account, so it must die on first use.
  it('refuses the same link a second time', async () => {
    const r = await acceptInvite({ token, password: 'another password' }, acceptDeps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(AcceptInviteErrors.INVITE_INVALID.code);
  }, 30_000);
});

describe('inviting someone who already has an account', () => {
  it('grants a second membership and mints NO link', async () => {
    const r = await inviteStaff(
      adminCtx(TENANT_A, ADMIN_PERSON),
      { personId: EXISTING_PERSON_A, identifier: EXISTING_EMAIL, roleIds: [] },
      deps,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;

    // No link is minted, so there is nothing to leak — they sign in with the
    // credentials they already use (ADR-0006).
    expect(r.value.inviteToken).toBeNull();

    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM staff_invite WHERE membership_id = $1`,
      [uuid(r.value.membershipId)],
    );
    expect(rows[0]?.n).toBe('0');
  }, 30_000);

  it('their existing password still works, and now reaches TWO schools', async () => {
    const login = await authenticatePassword(
      { identifier: EXISTING_EMAIL, password: EXISTING_PASSWORD },
      { hasher: passwordHasher, tokens: tokenGenerator },
    );
    expect(login.ok, JSON.stringify(login)).toBe(true);
    if (!login.ok) return;

    // One login, two schools — the case the identity model exists for.
    expect(login.value.contextCount).toBe(2);
    expect(new Set(login.value.contexts.map((c) => c.tenantId)).size).toBe(2);
  }, 60_000);
});

describe('revocation', () => {
  it('a revoked link stops working immediately', async () => {
    const person = nid<'person'>();
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'রেভোক টেস্ট','Revoke Test')`,
      [uuid(person), uuid(TENANT_A)],
    );

    const invited = await inviteStaff(
      adminCtx(TENANT_A, ADMIN_PERSON),
      { personId: person, identifier: `revoke-${Date.now()}@invite-int.example.bd`, roleIds: [] },
      deps,
    );
    expect(invited.ok).toBe(true);
    if (!invited.ok) return;

    const revoked = await revokeInvite(
      adminCtx(TENANT_A, ADMIN_PERSON),
      invited.value.membershipId,
      'invited the wrong person',
    );
    expect(revoked.ok).toBe(true);

    const r = await acceptInvite(
      { token: invited.value.inviteToken!, password: 'does not matter' },
      acceptDeps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(AcceptInviteErrors.INVITE_INVALID.code);
  }, 60_000);

  it('an unknown token is refused with the same error as a revoked one', async () => {
    const r = await acceptInvite(
      { token: 'not-a-real-invite-token', password: 'does not matter' },
      acceptDeps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(AcceptInviteErrors.INVITE_INVALID.code);
  }, 30_000);
});

describe('authorization', () => {
  it('refuses an actor without membership.manage', async () => {
    const ctx: AuthContext = {
      ...adminCtx(TENANT_A, ADMIN_PERSON),
      permissions: new Set<Permission>(['student.read']),
    };
    await expect(
      inviteStaff(ctx, { personId: nid<'person'>(), identifier: 'x@y.bd', roleIds: [] as RoleId[] }, deps),
    ).rejects.toThrow(/membership.manage/);
  }, 30_000);
});
