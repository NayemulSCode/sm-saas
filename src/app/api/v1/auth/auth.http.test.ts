/**
 * The auth endpoints over real HTTP.
 *
 * Everything beneath these routes is already covered by the integration suite.
 * What is proven ONLY here: the response envelope, the domain-error → status
 * mapping, the HttpOnly session cookie surviving a round trip, and the rate
 * limiter actually being wired in.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { startNextServer, type TestServer } from '../../../../test/next-server';
import { Ids } from '../../../../shared/ids';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;

const nid = <T extends string = 'x'>() => Ids.generate<T>();
const uuid = (v: string) => Ids.toUuid(v as never);

const PHONE = '+8801911223344';
const PHONE_NATIONAL = '01911223344';
const UNKNOWN_PHONE = '+8801955667788';

const PLAN = nid();
const TENANT_A = nid();
const TENANT_B = nid();
const PERSON_A = nid();
const PERSON_B = nid();
const ACCOUNT = nid();
const CREDENTIAL = nid();

let server: TestServer;
let admin: Pool;

/** Extracts the session cookie from a Set-Cookie header for manual replay. */
function sessionCookie(res: Response): string | undefined {
  const raw = res.headers.getSetCookie?.() ?? [];
  const found = raw.find((c) => c.startsWith('sm_session='));
  return found?.split(';')[0];
}

const post = (path: string, body?: unknown, cookie?: string) =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

const get = (path: string, cookie?: string) =>
  fetch(`${server.url}${path}`, { headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  if (!ADMIN_URL) throw new Error('HTTP tests need DATABASE_URL_MIGRATOR.');
  admin = new Pool({ connectionString: ADMIN_URL, max: 4 });

  await admin.query(
    `INSERT INTO plan (id, code, name_bn, name_en, price_minor, billing_period)
     VALUES ($1,'http-int','পরীক্ষা','Test',0,'monthly') ON CONFLICT DO NOTHING`,
    [uuid(PLAN)],
  );
  for (const [t, slug] of [
    [TENANT_A, 'http-a'],
    [TENANT_B, 'http-b'],
  ] as const) {
    await admin.query(
      `INSERT INTO tenant (id, slug, name_bn, name_en, plan_id, status)
       VALUES ($1,$2,'বিদ্যালয়','School',$3,'active') ON CONFLICT DO NOTHING`,
      [uuid(t), slug, uuid(PLAN)],
    );
  }
  for (const [p, t] of [
    [PERSON_A, TENANT_A],
    [PERSON_B, TENANT_B],
  ] as const) {
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'সালমা বেগম','Salma Begum') ON CONFLICT DO NOTHING`,
      [uuid(p), uuid(t)],
    );
  }
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn')
     ON CONFLICT DO NOTHING`,
    [uuid(ACCOUNT)],
  );
  await admin.query(
    `INSERT INTO credential (id, account_id, kind, value, verified_at)
     VALUES ($1,$2,'phone',$3, now()) ON CONFLICT DO NOTHING`,
    [uuid(CREDENTIAL), uuid(ACCOUNT), PHONE],
  );
  for (const [t, p] of [
    [TENANT_A, PERSON_A],
    [TENANT_B, PERSON_B],
  ] as const) {
    await admin.query(
      `INSERT INTO membership (id, tenant_id, account_id, person_id, status)
       VALUES ($1,$2,$3,$4,'active') ON CONFLICT DO NOTHING`,
      [uuid(nid()), uuid(t), uuid(ACCOUNT), uuid(p)],
    );
  }

  server = await startNextServer();
});

afterAll(async () => {
  await server?.stop();
  await admin?.end();
});

describe('the response envelope', () => {
  it('wraps success as { data, meta.requestId }', async () => {
    const res = await get('/api/v1/health');
    const body = (await res.json()) as { data: unknown; meta: { requestId: string } };

    expect(res.status).toBe(200);
    expect(body.data).toBeDefined();
    expect(body.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('wraps a validation failure as { error } with per-field details', async () => {
    const res = await post('/api/v1/auth/otp/request', { identifier: 'nonsense' });
    const body = (await res.json()) as {
      error: { code: string; requestId: string; details: Array<{ field: string }> };
    };

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // A form needs to know WHICH field to mark.
    expect(body.error.details[0]?.field).toBe('identifier');
  });

  it('rejects a malformed JSON body as a validation failure, not a 500', async () => {
    const res = await fetch(`${server.url}/api/v1/auth/otp/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/otp/request', () => {
  it('accepts a national-format number and normalises it', async () => {
    const res = await post('/api/v1/auth/otp/request', { identifier: PHONE_NATIONAL });
    const body = (await res.json()) as { data: { accepted: boolean } };

    expect(res.status).toBe(200);
    expect(body.data.accepted).toBe(true);
    // The code went to the E.164 record, so normalisation happened in the DTO.
    expect(server.output()).toContain(PHONE);
  });

  // The endpoint must not be usable to discover who is enrolled at a school.
  it('answers identically for an unknown number', async () => {
    const known = await post('/api/v1/auth/otp/request', { identifier: PHONE });
    const unknown = await post('/api/v1/auth/otp/request', { identifier: UNKNOWN_PHONE });

    expect(unknown.status).toBe(known.status);
    const a = (await known.json()) as { data: unknown };
    const b = (await unknown.json()) as { data: unknown };
    expect(b.data).toEqual(a.data);
  });
});

describe('the full login round trip', () => {
  let cookie: string;

  it('verifies the code, sets an HttpOnly cookie, and returns two contexts', async () => {
    await admin.query('DELETE FROM otp_challenge WHERE credential_id = $1', [
      uuid(CREDENTIAL),
    ]);
    await post('/api/v1/auth/otp/request', { identifier: PHONE });

    const code = server.lastOtpCode();
    expect(code, 'the mock dispatcher should have logged a code').toMatch(/^\d{6}$/);

    const res = await post('/api/v1/auth/otp/verify', { identifier: PHONE, code });
    const body = (await res.json()) as { data: { contextCount: number } };

    expect(res.status).toBe(200);
    expect(body.data.contextCount).toBe(2);

    const setCookie = res.headers.getSetCookie?.() ?? [];
    const session = setCookie.find((c) => c.startsWith('sm_session='));
    expect(session).toBeDefined();
    // The token must not be reachable from page scripts.
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=lax/i);
    // Lax, not Strict: guardians arrive by following an SMS link.
    expect(session).not.toMatch(/SameSite=strict/i);

    // And never in the body.
    expect(JSON.stringify(body)).not.toContain(session!.split('=')[1]!.split(';')[0]!);

    cookie = sessionCookie(res)!;
  });

  it('the cookie authenticates /auth/me', async () => {
    const res = await get('/api/v1/auth/me', cookie);
    const body = (await res.json()) as { data: { readOnly: boolean } };

    expect(res.status).toBe(200);
    expect(body.data.readOnly).toBe(false);
  });

  it('lists both contexts, and activating one persists', async () => {
    const listed = await get('/api/v1/auth/contexts', cookie);
    const list = (await listed.json()) as {
      data: { contexts: Array<{ membershipId: string; tenantSlug: string }> };
    };
    expect(listed.status).toBe(200);
    expect(list.data.contexts).toHaveLength(2);

    const target = list.data.contexts.find((c) => c.tenantSlug === 'http-b');
    expect(target).toBeDefined();

    const activated = await post(
      `/api/v1/auth/contexts/${target!.membershipId}/activate`,
      undefined,
      cookie,
    );
    expect(activated.status).toBe(200);

    const after = await get('/api/v1/auth/contexts', cookie);
    const list2 = (await after.json()) as {
      data: { contexts: Array<{ tenantSlug: string; isActive: boolean }> };
    };
    expect(list2.data.contexts.find((c) => c.isActive)?.tenantSlug).toBe('http-b');
  });

  it('logout revokes the session, and the cookie stops working', async () => {
    const out = await post('/api/v1/auth/logout', undefined, cookie);
    expect(out.status).toBe(200);

    // Revocation is server-side state, so it takes effect on the very next
    // request — the whole reason for not using JWTs.
    const after = await get('/api/v1/auth/me', cookie);
    expect(after.status).toBe(401);
  });
});

describe('authentication is required', () => {
  it('refuses /auth/me without a cookie', async () => {
    expect((await get('/api/v1/auth/me')).status).toBe(403);
  });

  it('refuses /auth/contexts without a cookie', async () => {
    expect((await get('/api/v1/auth/contexts')).status).toBe(403);
  });

  it('refuses a forged cookie', async () => {
    const res = await get('/api/v1/auth/me', 'sm_session=totally-made-up');
    expect(res.status).toBe(401);
  });
});

describe('rate limiting is actually wired in', () => {
  it('returns 429 with Retry-After once the per-identifier limit is passed', async () => {
    const phone = '+88017' + String(Date.now()).slice(-8);

    let limited: Response | undefined;
    for (let i = 0; i < 8; i++) {
      const res = await post('/api/v1/auth/otp/request', { identifier: phone });
      if (res.status === 429) {
        limited = res;
        break;
      }
    }

    expect(limited, 'expected a 429 within 8 requests').toBeDefined();
    expect(limited!.headers.get('retry-after')).toMatch(/^\d+$/);

    const body = (await limited!.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
  });
});
