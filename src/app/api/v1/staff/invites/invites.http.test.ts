/**
 * The staff invitation endpoints over real HTTP.
 *
 * The invite use cases are already covered by the integration suite. What is
 * proven ONLY here is the part no other layer touches: a real session cookie
 * resolving into a real AuthContext with real permissions read from the
 * database, and `authorize()` throwing across the transport boundary as a 403
 * rather than a 500.
 *
 * Until this file existed, `resolveAuthContext` was the one link in the tenancy
 * chain with nothing exercising it end to end.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startNextServer, type TestServer } from '../../../../../test/next-server';
import { Ids } from '../../../../../shared/ids';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const PLAN = nid();
const TENANT_A = nid();
const TENANT_B = nid();

/** The principal: has membership.manage, and exactly one membership so that
 *  logging in auto-activates it. */
/*
 * Per-run natural keys.
 *
 * The ids above are fresh every run, but slugs, plan codes and phone numbers
 * are NATURAL keys with unique constraints, and every fixture insert says
 * `ON CONFLICT DO NOTHING`. Hold them constant and the second run silently
 * skips the insert, leaving the freshly generated id pointing at nothing — the
 * failure surfaces later as a foreign-key violation on an unrelated table. CI
 * starts from an empty database and never sees it; a developer's machine sees
 * it on run two.
 */
const STAMP = String(Date.now()).slice(-8);

const ADMIN_PHONE = `+88013${STAMP}`;
const ADMIN_PERSON = nid();
const ADMIN_ACCOUNT = nid();
const ADMIN_CREDENTIAL = nid();
const ADMIN_MEMBERSHIP = nid();

/** A librarian: authenticated, in the same school, WITHOUT membership.manage. */
const CLERK_PHONE = `+88014${STAMP}`;
const CLERK_PERSON = nid();
const CLERK_ACCOUNT = nid();
const CLERK_CREDENTIAL = nid();
const CLERK_MEMBERSHIP = nid();

/**
 * A membership in the OTHER school, belonging to a DIFFERENT account — a real
 * stranger, not the principal wearing a second hat. Tenant A's principal must
 * not be able to reach it.
 *
 * It also matters that the principal has exactly ONE membership: verifyOtp only
 * auto-activates a context when there is a single one, and an unactivated
 * session resolves to NO_ACTIVE_CONTEXT rather than to a tenant.
 */
const FOREIGN_MEMBERSHIP = nid();
const FOREIGN_PERSON = nid();
const FOREIGN_ACCOUNT = nid();

const PRINCIPAL_ROLE = nid();
const LIBRARIAN_ROLE = nid();

let server: TestServer;
let admin: Pool;
let principal: string;
let clerk: string;

function sessionCookie(res: Response): string | undefined {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.find((c) => c.startsWith('sm_session='))?.split(';')[0];
}

const post = (path: string, body?: unknown, cookie?: string) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

/** A full OTP round trip, because the point is to exercise a REAL cookie. */
async function login(phone: string, credentialId: string): Promise<string> {
  // A live challenge would be reused and no new code sent — clear it first.
  await admin.query('DELETE FROM otp_challenge WHERE credential_id = $1', [uuid(credentialId)]);
  await post('/api/v1/auth/otp/request', { identifier: phone });

  const code = await server.waitForOtpCode();
  if (!code) throw new Error(`no OTP code was dispatched for ${phone}`);

  const res = await post('/api/v1/auth/otp/verify', { identifier: phone, code });
  const cookie = sessionCookie(res);
  if (!cookie) throw new Error(`login failed for ${phone}: ${res.status} ${await res.text()}`);
  return cookie;
}

/** A person in tenant A who can be invited. */
async function newPerson(tenant: string = TENANT_A): Promise<string> {
  const id = nid();
  await admin.query(
    `INSERT INTO person (id, tenant_id, name_bn, name_en)
     VALUES ($1,$2,'নতুন শিক্ষক','New Teacher')`,
    [uuid(id), uuid(tenant)],
  );
  return id;
}

beforeAll(async () => {
  if (!ADMIN_URL) throw new Error('HTTP tests need DATABASE_URL_MIGRATOR.');
  admin = new Pool({ connectionString: ADMIN_URL, max: 4 });

  await admin.query(
    `INSERT INTO plan (id, code, name_bn, name_en, price_minor, billing_period)
     VALUES ($1,$2,'পরীক্ষা','Test',0,'monthly') ON CONFLICT DO NOTHING`,
    [uuid(PLAN), `invite-http-${STAMP}`],
  );
  for (const [t, slug] of [
    [TENANT_A, `invite-http-a-${STAMP}`],
    [TENANT_B, `invite-http-b-${STAMP}`],
  ] as const) {
    await admin.query(
      `INSERT INTO tenant (id, slug, name_bn, name_en, plan_id, status)
       VALUES ($1,$2,'বিদ্যালয়','School',$3,'active') ON CONFLICT DO NOTHING`,
      [uuid(t), slug, uuid(PLAN)],
    );
  }
  for (const [p, t] of [
    [ADMIN_PERSON, TENANT_A],
    [CLERK_PERSON, TENANT_A],
    [FOREIGN_PERSON, TENANT_B],
  ] as const) {
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'রুমানা হক','Rumana Haque') ON CONFLICT DO NOTHING`,
      [uuid(p), uuid(t)],
    );
  }

  for (const [acc, cred, phone] of [
    [ADMIN_ACCOUNT, ADMIN_CREDENTIAL, ADMIN_PHONE],
    [CLERK_ACCOUNT, CLERK_CREDENTIAL, CLERK_PHONE],
  ] as const) {
    await admin.query(
      `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn') ON CONFLICT DO NOTHING`,
      [uuid(acc)],
    );
    await admin.query(
      `INSERT INTO credential (id, account_id, kind, value, verified_at)
       VALUES ($1,$2,'phone',$3, now()) ON CONFLICT DO NOTHING`,
      [uuid(cred), uuid(acc), phone],
    );
  }

  for (const [m, t, acc, p] of [
    [ADMIN_MEMBERSHIP, TENANT_A, ADMIN_ACCOUNT, ADMIN_PERSON],
    [CLERK_MEMBERSHIP, TENANT_A, CLERK_ACCOUNT, CLERK_PERSON],
  ] as const) {
    await admin.query(
      `INSERT INTO membership (id, tenant_id, account_id, person_id, status)
       VALUES ($1,$2,$3,$4,'active') ON CONFLICT DO NOTHING`,
      [uuid(m), uuid(t), uuid(acc), uuid(p)],
    );
  }
  // Belongs to tenant B and to nobody in tenant A.
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn') ON CONFLICT DO NOTHING`,
    [uuid(FOREIGN_ACCOUNT)],
  );
  await admin.query(
    `INSERT INTO membership (id, tenant_id, account_id, person_id, status)
     VALUES ($1,$2,$3,$4,'active') ON CONFLICT DO NOTHING`,
    [uuid(FOREIGN_MEMBERSHIP), uuid(TENANT_B), uuid(FOREIGN_ACCOUNT), uuid(FOREIGN_PERSON)],
  );

  /*
   * Roles built from the SEEDED vocabulary, not from literals: role_permission
   * has a foreign key to permission(key), so these inserts fail loudly if the
   * seed did not run. That is the intended coupling.
   */
  for (const [r, code, perms] of [
    [PRINCIPAL_ROLE, 'Principal', ['membership.manage', 'staff.read', 'student.read']],
    [LIBRARIAN_ROLE, 'Librarian', ['student.read']],
  ] as const) {
    await admin.query(
      `INSERT INTO role (id, tenant_id, code, name_bn, name_en, is_system)
       VALUES ($1,$2,$3,'ভূমিকা','Role',true) ON CONFLICT DO NOTHING`,
      [uuid(r), uuid(TENANT_A), code],
    );
    for (const key of perms) {
      await admin.query(
        `INSERT INTO role_permission (id, tenant_id, role_id, permission_key)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [uuid(nid()), uuid(TENANT_A), uuid(r), key],
      );
    }
  }
  for (const [m, r] of [
    [ADMIN_MEMBERSHIP, PRINCIPAL_ROLE],
    [CLERK_MEMBERSHIP, LIBRARIAN_ROLE],
  ] as const) {
    await admin.query(
      `INSERT INTO membership_role (id, tenant_id, membership_id, role_id)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [uuid(nid()), uuid(TENANT_A), uuid(m), uuid(r)],
    );
  }

  server = await startNextServer(3124);

  // Logged in ONCE and shared: every login burns an OTP request against the
  // per-identifier rate limit, which is live in this build.
  principal = await login(ADMIN_PHONE, ADMIN_CREDENTIAL);
  clerk = await login(CLERK_PHONE, CLERK_CREDENTIAL);
});

afterAll(async () => {
  await server?.stop();
  await admin?.end();
});

describe('POST /staff/invites', () => {
  it('mints a single-use link for a new staff member', async () => {
    const person = await newPerson();
    const res = await post(
      '/api/v1/staff/invites',
      { personId: person, identifier: `t${Date.now()}@invite-http.example.bd`, roleIds: [] },
      principal,
    );
    const body = (await res.json()) as {
      data: { membershipId: string; inviteToken: string; expiresAt: string };
    };

    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body.data.inviteToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(new Date(body.data.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Only the hash is stored: a dump of this table must not yield live links.
    const { rows } = await admin.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM staff_invite WHERE membership_id = $1',
      [uuid(body.data.membershipId)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash.toString('utf8')).not.toContain(body.data.inviteToken);
  });

  it('puts the invite in the tenant the SESSION names, not the request', async () => {
    const person = await newPerson();
    const res = await post(
      '/api/v1/staff/invites',
      { personId: person, identifier: `t${Date.now()}b@invite-http.example.bd` },
      principal,
    );
    const body = (await res.json()) as { data: { membershipId: string } };
    expect(res.status).toBe(201);

    // Nothing in the request said which school. The cookie did.
    const { rows } = await admin.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM membership WHERE id = $1',
      [uuid(body.data.membershipId)],
    );
    expect(rows[0]?.tenant_id).toBe(uuid(TENANT_A));
  });

  it('rejects a malformed personId as a validation failure', async () => {
    const res = await post(
      '/api/v1/staff/invites',
      { personId: 'not-a-ulid', identifier: 'someone@invite-http.example.bd' },
      principal,
    );
    const body = (await res.json()) as { error: { code: string; details: Array<{ field: string }> } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.map((d) => d.field)).toContain('personId');
  });

  it('refuses an unauthenticated caller', async () => {
    const person = await newPerson();
    const res = await post('/api/v1/staff/invites', {
      personId: person,
      identifier: 'nobody@invite-http.example.bd',
    });
    expect(res.status).toBe(403);

    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM membership WHERE person_id = $1',
      [uuid(person)],
    );
    expect(rows[0]?.n, 'an unauthenticated request must not create anything').toBe('0');
  });

  /*
   * The reason this file exists. authorize() THROWS rather than returning a
   * Result, so a handler that forgets to catch it would answer 500 — which
   * looks like a bug to fix rather than a boundary working.
   */
  it('refuses an authenticated caller without membership.manage — 403, not 500', async () => {
    // The clerk is genuinely signed in with an active context; the only thing
    // they lack is the permission. Without this the 403 below would also pass
    // for a session that failed to resolve at all.
    const me = await fetch(`${server.url}/api/v1/auth/me`, { headers: { cookie: clerk } });
    expect(me.status).toBe(200);

    const person = await newPerson();

    const res = await post(
      '/api/v1/staff/invites',
      { personId: person, identifier: 'nope@invite-http.example.bd' },
      clerk,
    );
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
  });
});

describe('the accept round trip', () => {
  let token: string;
  let membershipId: string;
  const email = `accept${Date.now()}@invite-http.example.bd`;

  beforeAll(async () => {
    const person = await newPerson();
    const res = await post(
      '/api/v1/staff/invites',
      { personId: person, identifier: email },
      principal,
    );
    const body = (await res.json()) as { data: { inviteToken: string; membershipId: string } };
    token = body.data.inviteToken;
    membershipId = body.data.membershipId;
  });

  it('sets a password and opens a session, with no cookie required', async () => {
    const res = await post('/api/v1/auth/invite/accept', {
      token,
      password: 'a password they chose themselves',
    });
    const body = (await res.json()) as { data: { contextCount: number } };

    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.data.contextCount).toBe(1);

    const setCookie = res.headers.getSetCookie?.() ?? [];
    const session = setCookie.find((c) => c.startsWith('sm_session='));
    expect(session, 'accepting must land the invitee signed in').toBeDefined();
    expect(session).toMatch(/HttpOnly/i);

    // The session token is never in the body.
    expect(JSON.stringify(body)).not.toContain(session!.split('=')[1]!.split(';')[0]!);
  });

  it('marks the invite consumed and refuses the link a second time', async () => {
    const { rows } = await admin.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM staff_invite WHERE membership_id = $1',
      [uuid(membershipId)],
    );
    expect(rows[0]?.consumed_at).not.toBeNull();

    // Whoever holds the link can take the account, so it must die on first use.
    const res = await post('/api/v1/auth/invite/accept', {
      token,
      password: 'someone else trying',
    });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVITE_INVALID');
  });

  it('rejects a short password before touching the token', async () => {
    const res = await post('/api/v1/auth/invite/accept', { token, password: 'short' });
    const body = (await res.json()) as { error: { code: string } };
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /staff/invites/:membershipId/revoke', () => {
  it('kills a live link immediately', async () => {
    const person = await newPerson();
    const invited = await post(
      '/api/v1/staff/invites',
      { personId: person, identifier: `rev${Date.now()}@invite-http.example.bd` },
      principal,
    );
    const body = (await invited.json()) as {
      data: { membershipId: string; inviteToken: string };
    };
    expect(invited.status).toBe(201);

    const revoked = await post(
      `/api/v1/staff/invites/${body.data.membershipId}/revoke`,
      { reason: 'invited the wrong person' },
      principal,
    );
    expect(revoked.status).toBe(200);

    const accepted = await post('/api/v1/auth/invite/accept', {
      token: body.data.inviteToken,
      password: 'too late to matter',
    });
    const after = (await accepted.json()) as { error: { code: string } };
    expect(accepted.status).toBe(400);
    expect(after.error.code).toBe('INVITE_INVALID');
  });

  it('requires a reason, because revocation is audited', async () => {
    const res = await post(
      `/api/v1/staff/invites/${nid()}/revoke`,
      { reason: 'x' },
      principal,
    );
    const body = (await res.json()) as { error: { code: string; details: Array<{ field: string }> } };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.map((d) => d.field)).toContain('reason');
  });

  /*
   * The membership id is real and the caller is a legitimate principal — of
   * ANOTHER school. RLS makes the row invisible, so this must read as "no such
   * invite" rather than as a permission problem.
   */
  it('cannot reach a membership in another tenant', async () => {
    const res = await post(
      `/api/v1/staff/invites/${FOREIGN_MEMBERSHIP}/revoke`,
      { reason: 'attempting to reach across tenants' },
      principal,
    );
    const body = (await res.json()) as { error: { code: string } };

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('INVITE_NOT_FOUND');
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await post(`/api/v1/staff/invites/${nid()}/revoke`, { reason: 'no cookie here' });
    expect(res.status).toBe(403);
  });
});
