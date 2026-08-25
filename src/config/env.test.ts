import { describe, it, expect } from 'vitest';
import { loadEnv } from './env.js';

const valid = {
  NODE_ENV: 'test',
  APP_URL: 'https://sm.example.com',
  PLATFORM_HOST: 'admin.sm.example.com',
  DATABASE_URL_APP: 'postgres://sm_app:pw@localhost:5432/sm',
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: 'a'.repeat(64),
  TZ: 'Asia/Dhaka',
} satisfies NodeJS.ProcessEnv;

describe('loadEnv', () => {
  it('accepts a valid environment and applies defaults', () => {
    const e = loadEnv(valid);
    expect(e.DB_POOL_MAX).toBe(15);
    expect(e.SMS_PROVIDER).toBe('mock');
    expect(e.ARGON2_MEMORY_KIB).toBe(19_456);
    expect(e.TZ).toBe('Asia/Dhaka');
  });

  // Refusing to start is the point: the alternative is failing at 02:00 on the
  // first request that needs the value.
  it('refuses to start on a missing secret', () => {
    const { SESSION_SECRET: _omit, ...rest } = valid;
    expect(() => loadEnv(rest)).toThrow(/SESSION_SECRET/);
  });

  it('refuses a short session secret', () => {
    expect(() => loadEnv({ ...valid, SESSION_SECRET: 'tooshort' })).toThrow(/SESSION_SECRET/);
  });

  it('refuses an encryption key that is not 32 bytes of hex', () => {
    expect(() => loadEnv({ ...valid, ENCRYPTION_KEY: 'nothex' })).toThrow(/ENCRYPTION_KEY/);
  });

  it('refuses a malformed APP_URL', () => {
    expect(() => loadEnv({ ...valid, APP_URL: 'not-a-url' })).toThrow(/APP_URL/);
  });

  // The platform timezone is fixed. A different value is a misconfiguration.
  it('refuses a timezone other than Asia/Dhaka', () => {
    expect(() => loadEnv({ ...valid, TZ: 'UTC' })).toThrow(/TZ/);
  });

  it('coerces numeric settings from strings', () => {
    const e = loadEnv({ ...valid, DB_POOL_MAX: '25' });
    expect(e.DB_POOL_MAX).toBe(25);
  });

  it('reports every problem at once, not just the first', () => {
    try {
      loadEnv({ ...valid, APP_URL: 'bad', ENCRYPTION_KEY: 'bad' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const msg = String(e);
      expect(msg).toContain('APP_URL');
      expect(msg).toContain('ENCRYPTION_KEY');
    }
  });
});
