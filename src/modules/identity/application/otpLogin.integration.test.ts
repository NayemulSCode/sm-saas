/**
 * OTP login, end to end, against a real PostgreSQL.
 *
 * The case this whole module exists for is `logs one account into TWO tenants`
 * below: a teacher at School A whose child attends School B. If the
 * account → membership → person model is wrong, that is where it shows
 * (ADR-0006).
 *
 * Runs as its own CI step with a Postgres service. Never in the unit suite —
 * `pnpm test` must stay runnable with no database.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { requestOtp } from './requestOtp.js';
import { verifyOtp, IdentityErrors } from './verifyOtp.js';
import { codeHasher, tokenGenerator, randomSource } from '../infrastructure/crypto.js';
import type { OtpDispatcher } from '../domain/ports.js';
import { Ids } from '../../../shared/ids.js';
import { OTP } from '../domain/otp.js';

const ADMIN_URL = process.env.DATABASE_URL_MIGRATOR;
const PLATFORM_URL = process.env.DATABASE_URL_PLATFORM;

const PHONE = '+8801711223344';
const UNKNOWN_PHONE = '+8801799999999';

const id = () => Ids.generate<'x'>();
const PLAN = id();
const TENANT_A = id();
const TENANT_B = id();
const PERSON_A = id();
const PERSON_B = id();
const ACCOUNT = id();
const CREDENTIAL = id();

let admin: Pool;

/** Captures the code instead of sending an SMS. No test ever sends a real one. */
class CapturingDispatcher implements OtpDispatcher {
  public sent: Array<{ to: string; code: string }> = [];
  async send(to: { kind: string; value: string }, code: string): Promise<void> {
    this.sent.push({ to: to.value, code });
  }
  get lastCode(): string | undefined {
    return this.sent.at(-1)?.code;
  }
  clear(): void {
    this.sent = [];
  }
}

const dispatcher = new CapturingDispatcher();
const deps = { codeHasher, random: randomSource, dispatcher };
const verifyDeps = { codeHasher, tokens: tokenGenerator };

const uuid = (v: string) => Ids.toUuid(v as never);

beforeAll(async () => {
  if (!ADMIN_URL || !PLATFORM_URL) {
    throw new Error(
      'Integration tests need DATABASE_URL_MIGRATOR and DATABASE_URL_PLATFORM. ' +
        'They run in CI against a postgres service.',
    );
  }
  vi.stubEnv('APP_URL', 'http://localhost:3000');
  vi.stubEnv('PLATFORM_HOST', 'admin.localhost');
  vi.stubEnv('SESSION_SECRET', 'x'.repeat(32));
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('TZ', 'Asia/Dhaka');

  admin = new Pool({ connectionString: ADMIN_URL, max: 4 });

  // Seeded as the superuser, which bypasses RLS by design. Everything the test
  // then exercises runs through the module's own connections.
  await admin.query(
    `INSERT INTO plan (id, code, name_bn, name_en, price_minor, billing_period)
     VALUES ($1,'otp-int','পরীক্ষা','Test',0,'monthly') ON CONFLICT DO NOTHING`,
    [uuid(PLAN)],
  );

  for (const [t, slug] of [
    [TENANT_A, 'otp-int-a'],
    [TENANT_B, 'otp-int-b'],
  ] as const) {
    await admin.query(
      `INSERT INTO tenant (id, slug, name_bn, name_en, plan_id, status)
       VALUES ($1,$2,'বিদ্যালয়','School',$3,'active') ON CONFLICT DO NOTHING`,
      [uuid(t), slug, uuid(PLAN)],
    );
  }

  // The SAME human, known separately to each school — two person rows, because
  // a person record is owned by one tenant and sits behind RLS (§7.7).
  for (const [p, t] of [
    [PERSON_A, TENANT_A],
    [PERSON_B, TENANT_B],
  ] as const) {
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'রহিমা খাতুন','Rahima Khatun') ON CONFLICT DO NOTHING`,
      [uuid(p), uuid(t)],
    );
  }

  // ONE account, ONE credential — one login for both schools.
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
      [uuid(id()), uuid(t), uuid(ACCOUNT), uuid(p)],
    );
  }
});

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index.js');
  await closeAllPools();
  await admin?.end();
});

describe('OTP login', () => {
  it('issues a challenge and dispatches a six-digit code', async () => {
    dispatcher.clear();
    const result = await requestOtp({ identifier: '01711223344' }, deps);

    expect(result.ok).toBe(true);
    expect(dispatcher.sent).toHaveLength(1);
    expect(dispatcher.lastCode).toMatch(/^\d{6}$/);
    // Normalisation happened: the raw national form reached the E.164 record.
    expect(dispatcher.sent[0]?.to).toBe(PHONE);
  });

  it('answers identically for an unknown number, and sends nothing', async () => {
    dispatcher.clear();
    const known = await requestOtp({ identifier: PHONE }, deps);
    const knownSent = dispatcher.sent.length;

    dispatcher.clear();
    const unknown = await requestOtp({ identifier: UNKNOWN_PHONE }, deps);

    // Same response shape and value — the endpoint reveals nothing about who
    // is enrolled — but no SMS is spent on a number that does not exist.
    expect(unknown).toEqual(known);
    expect(knownSent).toBe(1);
    expect(dispatcher.sent).toHaveLength(0);
  });

  it('THE case the model exists for: logs one account into TWO tenants', async () => {
    await admin.query('DELETE FROM otp_challenge WHERE credential_id = $1', [
      uuid(CREDENTIAL),
    ]);
    dispatcher.clear();

    await requestOtp({ identifier: PHONE }, deps);
    const code = dispatcher.lastCode;
    expect(code).toBeDefined();

    const result = await verifyOtp({ identifier: PHONE, code: code! }, verifyDeps);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // A teacher at School A whose child attends School B: one login, two
    // contexts, a switcher rather than two accounts (ADR-0006).
    expect(result.value.contextCount).toBe(2);
    expect(new Set(result.value.contexts.map((c) => c.tenantId)).size).toBe(2);
    expect(result.value.sessionToken).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(result.value.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The session row exists and stores sha256(token), never the token.
    const { rows } = await admin.query<{ n: string; token_hash: Buffer }>(
      `SELECT count(*)::text AS n, min(token_hash) AS token_hash
         FROM session WHERE account_id = $1 AND revoked_at IS NULL`,
      [uuid(ACCOUNT)],
    );
    expect(Number(rows[0]?.n)).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.token_hash?.toString('utf8')).not.toContain(
      result.value.sessionToken,
    );

    // Two contexts, so no membership is activated — the switcher decides.
    const active = await admin.query<{ active_membership_id: string | null }>(
      `SELECT active_membership_id FROM session
        WHERE account_id = $1 ORDER BY issued_at DESC LIMIT 1`,
      [uuid(ACCOUNT)],
    );
    expect(active.rows[0]?.active_membership_id).toBeNull();
  });

  it('refuses the same code twice', async () => {
    await admin.query('DELETE FROM otp_challenge WHERE credential_id = $1', [
      uuid(CREDENTIAL),
    ]);
    dispatcher.clear();
    await requestOtp({ identifier: PHONE }, deps);
    const code = dispatcher.lastCode!;

    const first = await verifyOtp({ identifier: PHONE, code }, verifyDeps);
    expect(first.ok).toBe(true);

    const second = await verifyOtp({ identifier: PHONE, code }, verifyDeps);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe(IdentityErrors.INVALID_CODE.code);
  });

  it('rejects a wrong code and counts the attempt', async () => {
    await admin.query('DELETE FROM otp_challenge WHERE credential_id = $1', [
      uuid(CREDENTIAL),
    ]);
    dispatcher.clear();
    await requestOtp({ identifier: PHONE }, deps);
    const code = dispatcher.lastCode!;
    const wrong = code === '000000' ? '111111' : '000000';

    const bad = await verifyOtp({ identifier: PHONE, code: wrong }, verifyDeps);
    expect(bad.ok).toBe(false);

    const { rows } = await admin.query<{ attempts: number }>(
      `SELECT attempts FROM otp_challenge
        WHERE credential_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [uuid(CREDENTIAL)],
    );
    expect(rows[0]?.attempts).toBe(1);

    // The right code still works while attempts remain.
    const good = await verifyOtp({ identifier: PHONE, code }, verifyDeps);
    expect(good.ok).toBe(true);
  });

  it('gives an unknown number the same error as a wrong code', async () => {
    const r = await verifyOtp({ identifier: UNKNOWN_PHONE, code: '123456' }, verifyDeps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(IdentityErrors.INVALID_CODE.code);
  });

  it('reuses the live challenge on resend rather than minting a second code', async () => {
    await admin.query('DELETE FROM otp_challenge WHERE credential_id = $1', [
      uuid(CREDENTIAL),
    ]);
    dispatcher.clear();

    await requestOtp({ identifier: PHONE }, deps);
    await requestOtp({ identifier: PHONE }, deps);

    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM otp_challenge WHERE credential_id = $1`,
      [uuid(CREDENTIAL)],
    );
    // One challenge, one SMS — two live codes would double both the guessing
    // surface and the bill.
    expect(rows[0]?.n).toBe('1');
    expect(dispatcher.sent).toHaveLength(1);
  });

  it('rate limits requests per identifier', async () => {
    await admin.query('DELETE FROM otp_challenge WHERE credential_id = $1', [
      uuid(CREDENTIAL),
    ]);
    dispatcher.clear();

    // Each request consumes the previous challenge so a new one is minted.
    for (let i = 0; i < OTP.maxRequestsPerWindow + 2; i++) {
      await requestOtp({ identifier: PHONE }, deps);
      await admin.query(
        `UPDATE otp_challenge SET consumed_at = now()
          WHERE credential_id = $1 AND consumed_at IS NULL`,
        [uuid(CREDENTIAL)],
      );
    }

    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM otp_challenge WHERE credential_id = $1`,
      [uuid(CREDENTIAL)],
    );
    expect(Number(rows[0]?.n)).toBe(OTP.maxRequestsPerWindow);
  });
});
