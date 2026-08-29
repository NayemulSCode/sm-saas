/**
 * Password login, end to end, against real PostgreSQL.
 *
 * The properties that matter and cannot be checked by a unit test: lockout
 * surviving in the database across attempts, an OTP-only guardian being
 * indistinguishable from a wrong password, and the counter resetting on
 * success.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { authenticatePassword, PasswordErrors } from './authenticatePassword';
import { passwordHasher, tokenGenerator } from '../infrastructure/crypto';
import { LOCKOUT } from '../domain/password';
import { Ids } from '../../../shared/ids';

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
const phone = (code: string): string => `+8801${code}${String(STAMP).slice(-6)}`;

const STAFF_EMAIL = `principal-${STAMP}@pw-int.example.bd`;
const STAFF_PASSWORD = 'a-perfectly-fine-password';

const GUARDIAN_PHONE = phone('730');
const LOCKOUT_EMAIL = `lockme-${STAMP}@pw-int.example.bd`;

const PLAN = nid();
const TENANT = nid();
const STAFF_PERSON = nid();
const GUARDIAN_PERSON = nid();
const LOCK_PERSON = nid();
const STAFF_ACCOUNT = nid();
const GUARDIAN_ACCOUNT = nid();
const LOCK_ACCOUNT = nid();

let admin: Pool;
const deps = { hasher: passwordHasher, tokens: tokenGenerator };

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
    [uuid(PLAN), `pw-int-${STAMP}`],
  );
  await admin.query(
    `INSERT INTO tenant (id, slug, name_bn, name_en, plan_id, status)
     VALUES ($1,$3,'বিদ্যালয়','School',$2,'active') ON CONFLICT DO NOTHING`,
    [uuid(TENANT), uuid(PLAN), `pw-int-${STAMP}`],
  );

  for (const p of [STAFF_PERSON, GUARDIAN_PERSON, LOCK_PERSON]) {
    await admin.query(
      `INSERT INTO person (id, tenant_id, name_bn, name_en)
       VALUES ($1,$2,'নাসরিন আক্তার','Nasrin Akter') ON CONFLICT DO NOTHING`,
      [uuid(p), uuid(TENANT)],
    );
  }

  const hash = await passwordHasher.hash(STAFF_PASSWORD);

  // Staff: email + password.
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn') ON CONFLICT DO NOTHING`,
    [uuid(STAFF_ACCOUNT)],
  );
  await admin.query(
    `INSERT INTO credential (id, account_id, kind, value, password_hash, verified_at)
     VALUES ($1,$2,'email',$3,$4, now()) ON CONFLICT DO NOTHING`,
    [uuid(nid()), uuid(STAFF_ACCOUNT), STAFF_EMAIL, hash],
  );

  // Guardian: phone, password_hash NULL. A normal state, not an error.
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn') ON CONFLICT DO NOTHING`,
    [uuid(GUARDIAN_ACCOUNT)],
  );
  await admin.query(
    `INSERT INTO credential (id, account_id, kind, value, verified_at)
     VALUES ($1,$2,'phone',$3, now()) ON CONFLICT DO NOTHING`,
    [uuid(nid()), uuid(GUARDIAN_ACCOUNT), GUARDIAN_PHONE],
  );

  // A separate account to lock, so lockout tests cannot break the others.
  await admin.query(
    `INSERT INTO account (id, status, locale) VALUES ($1,'active','bn') ON CONFLICT DO NOTHING`,
    [uuid(LOCK_ACCOUNT)],
  );
  await admin.query(
    `INSERT INTO credential (id, account_id, kind, value, password_hash, verified_at)
     VALUES ($1,$2,'email',$3,$4, now()) ON CONFLICT DO NOTHING`,
    [uuid(nid()), uuid(LOCK_ACCOUNT), LOCKOUT_EMAIL, hash],
  );

  for (const [acct, person] of [
    [STAFF_ACCOUNT, STAFF_PERSON],
    [GUARDIAN_ACCOUNT, GUARDIAN_PERSON],
    [LOCK_ACCOUNT, LOCK_PERSON],
  ] as const) {
    await admin.query(
      `INSERT INTO membership (id, tenant_id, account_id, person_id, status)
       VALUES ($1,$2,$3,$4,'active') ON CONFLICT DO NOTHING`,
      [uuid(nid()), uuid(TENANT), uuid(acct), uuid(person)],
    );
  }
}, 60_000);

afterAll(async () => {
  const { closeAllPools } = await import('../../../db/index');
  await closeAllPools();
  await admin?.end();
});

describe('authenticatePassword', () => {
  it('logs a staff member in with the right password', async () => {
    const r = await authenticatePassword(
      { identifier: STAFF_EMAIL, password: STAFF_PASSWORD },
      deps,
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.contextCount).toBe(1);
    expect(r.value.sessionToken).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  }, 30_000);

  it('normalises the identifier: case and whitespace do not matter', async () => {
    const r = await authenticatePassword(
      { identifier: `  ${STAFF_EMAIL.toUpperCase()} `, password: STAFF_PASSWORD },
      deps,
    );
    expect(r.ok).toBe(true);
  }, 30_000);

  it('refuses a wrong password', async () => {
    const r = await authenticatePassword(
      { identifier: STAFF_EMAIL, password: 'not the right password' },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(PasswordErrors.INVALID_CREDENTIALS.code);
  }, 30_000);

  it('gives an unknown identifier the SAME error as a wrong password', async () => {
    const r = await authenticatePassword(
      { identifier: 'nobody@pw-int.example.bd', password: STAFF_PASSWORD },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(PasswordErrors.INVALID_CREDENTIALS.code);
  }, 30_000);

  /**
   * A guardian's credential has password_hash NULL. If this returned a
   * different error — or returned faster — the endpoint would reveal which
   * accounts are staff and which are guardians.
   */
  it('gives an OTP-only guardian the same error, not a crash', async () => {
    const r = await authenticatePassword(
      { identifier: GUARDIAN_PHONE, password: STAFF_PASSWORD },
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(PasswordErrors.INVALID_CREDENTIALS.code);
  }, 30_000);

  /**
   * The timing defence, measured.
   *
   * An unknown identifier must not answer materially faster than a wrong
   * password, or response time becomes an account-enumeration oracle. The
   * bound is deliberately loose — this asserts the dummy verify happens at
   * all, not a precise constant.
   */
  it('takes comparable time for an unknown identifier and a wrong password', async () => {
    const time = async (identifier: string): Promise<number> => {
      const started = performance.now();
      await authenticatePassword({ identifier, password: 'some wrong password' }, deps);
      return performance.now() - started;
    };

    // Warm up: the dummy hash is generated lazily on first use.
    await time('warmup@pw-int.example.bd');

    const unknown = await time('definitely-nobody@pw-int.example.bd');
    const wrongPassword = await time(STAFF_EMAIL);

    // Without the dummy verify, `unknown` returns in ~1ms while a real verify
    // costs tens of milliseconds — a ratio of 20x or more.
    const ratio = Math.max(unknown, wrongPassword) / Math.max(1, Math.min(unknown, wrongPassword));
    expect(ratio, `unknown=${unknown.toFixed(1)}ms wrong=${wrongPassword.toFixed(1)}ms`).toBeLessThan(5);
  }, 60_000);

  it('locks the account after the maximum failed attempts', async () => {
    await admin.query(
      `UPDATE account SET failed_attempts = 0, locked_until = NULL WHERE id = $1`,
      [uuid(LOCK_ACCOUNT)],
    );

    for (let i = 0; i < LOCKOUT.maxAttempts; i++) {
      const r = await authenticatePassword(
        { identifier: LOCKOUT_EMAIL, password: 'wrong' },
        deps,
      );
      expect(r.ok, `attempt ${i + 1}`).toBe(false);
      // Every attempt up to the limit reports invalid credentials, never the
      // lock — the lock applies to the NEXT attempt.
      if (!r.ok) expect(r.error.code).toBe(PasswordErrors.INVALID_CREDENTIALS.code);
    }

    const locked = await authenticatePassword(
      { identifier: LOCKOUT_EMAIL, password: 'wrong' },
      deps,
    );
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error.code).toBe(PasswordErrors.ACCOUNT_LOCKED.code);

    // Even the CORRECT password is refused while locked — otherwise the lock
    // would not bound an online guessing attack at all.
    const correctButLocked = await authenticatePassword(
      { identifier: LOCKOUT_EMAIL, password: STAFF_PASSWORD },
      deps,
    );
    expect(correctButLocked.ok).toBe(false);
    if (!correctButLocked.ok) {
      expect(correctButLocked.error.code).toBe(PasswordErrors.ACCOUNT_LOCKED.code);
    }

    const { rows } = await admin.query<{ locked_until: Date | null }>(
      `SELECT locked_until FROM account WHERE id = $1`,
      [uuid(LOCK_ACCOUNT)],
    );
    expect(rows[0]?.locked_until).not.toBeNull();
  }, 120_000);

  it('resets the failure counter on a successful login', async () => {
    await admin.query(
      `UPDATE account SET failed_attempts = 3, locked_until = NULL WHERE id = $1`,
      [uuid(STAFF_ACCOUNT)],
    );

    const r = await authenticatePassword(
      { identifier: STAFF_EMAIL, password: STAFF_PASSWORD },
      deps,
    );
    expect(r.ok).toBe(true);

    const { rows } = await admin.query<{ failed_attempts: number; locked_until: Date | null }>(
      `SELECT failed_attempts, locked_until FROM account WHERE id = $1`,
      [uuid(STAFF_ACCOUNT)],
    );
    expect(rows[0]?.failed_attempts).toBe(0);
    expect(rows[0]?.locked_until).toBeNull();
  }, 30_000);

  it('refuses a disabled account', async () => {
    await admin.query(
      `UPDATE account SET status = 'disabled', failed_attempts = 0, locked_until = NULL
        WHERE id = $1`,
      [uuid(STAFF_ACCOUNT)],
    );
    try {
      const r = await authenticatePassword(
        { identifier: STAFF_EMAIL, password: STAFF_PASSWORD },
        deps,
      );
      expect(r.ok).toBe(false);
      // Disabled looks exactly like a wrong password from outside.
      if (!r.ok) expect(r.error.code).toBe(PasswordErrors.INVALID_CREDENTIALS.code);
    } finally {
      await admin.query(`UPDATE account SET status = 'active' WHERE id = $1`, [
        uuid(STAFF_ACCOUNT),
      ]);
    }
  }, 30_000);
});
