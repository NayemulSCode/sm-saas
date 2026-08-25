import { describe, it, expect, beforeAll, vi } from 'vitest';
import { codeHasher, tokenGenerator, randomSource, passwordHasher } from './crypto';
import { generateCode, OTP } from '../domain/otp';

beforeAll(() => {
  // passwordHasher reads ARGON2_MEMORY_KIB from the validated environment.
  // stubEnv rather than assignment: @types/node types NODE_ENV as readonly.
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('APP_URL', 'http://localhost:3000');
  vi.stubEnv('PLATFORM_HOST', 'admin.localhost');
  vi.stubEnv('DATABASE_URL_APP', 'postgres://x@localhost:5432/x');
  vi.stubEnv('SESSION_SECRET', 'x'.repeat(32));
  vi.stubEnv('ENCRYPTION_KEY', 'a'.repeat(64));
  vi.stubEnv('TZ', 'Asia/Dhaka');
});

describe('codeHasher', () => {
  it('is deterministic', () => {
    expect(codeHasher.hash('123456')).toBe(codeHasher.hash('123456'));
  });

  it('differs for different codes', () => {
    expect(codeHasher.hash('123456')).not.toBe(codeHasher.hash('123457'));
  });

  it('does not store the code in the hash', () => {
    expect(codeHasher.hash('123456')).not.toContain('123456');
  });

  it('compares equal hashes', () => {
    const h = codeHasher.hash('123456');
    expect(codeHasher.equals(h, h)).toBe(true);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    // timingSafeEqual throws on differing lengths, which would itself leak.
    expect(codeHasher.equals('short', codeHasher.hash('123456'))).toBe(false);
    expect(codeHasher.equals('', '')).toBe(true);
  });
});

describe('tokenGenerator', () => {
  it('produces a long, URL-safe token', () => {
    const { token } = tokenGenerator.newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
  });

  it('never repeats', () => {
    const set = new Set(
      Array.from({ length: 2000 }, () => tokenGenerator.newSessionToken().token),
    );
    expect(set.size).toBe(2000);
  });

  // The database stores sha256(token); a leak of the table must not yield
  // usable session cookies.
  it('hashes the token to 32 bytes and the hash is not the token', () => {
    const { token, hash } = tokenGenerator.newSessionToken();
    expect(hash).toHaveLength(32);
    expect(hash.toString('base64url')).not.toBe(token);
    expect(tokenGenerator.hashToken(token).equals(hash)).toBe(true);
  });
});

describe('randomSource + generateCode', () => {
  it('always yields a six-digit code', () => {
    for (let i = 0; i < 2000; i++) {
      const code = generateCode((max) => randomSource.int(max));
      expect(code).toMatch(/^\d{6}$/);
      expect(code).toHaveLength(OTP.digits);
    }
  });

  it('covers the low end, so zero-padding is exercised', () => {
    const codes = Array.from({ length: 5000 }, () =>
      generateCode((max) => randomSource.int(max)),
    );
    expect(codes.some((c) => c.startsWith('0'))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(4000); // not obviously biased
  });
});

describe('passwordHasher', () => {
  it('round-trips a password', async () => {
    const hash = await passwordHasher.hash('correct horse battery staple');
    expect(await passwordHasher.verify(hash, 'correct horse battery staple')).toBe(true);
    expect(await passwordHasher.verify(hash, 'wrong password')).toBe(false);
  }, 20_000);

  it('salts: the same password hashes differently each time', async () => {
    const a = await passwordHasher.hash('same');
    const b = await passwordHasher.hash('same');
    expect(a).not.toBe(b);
    expect(await passwordHasher.verify(a, 'same')).toBe(true);
    expect(await passwordHasher.verify(b, 'same')).toBe(true);
  }, 20_000);

  it('is argon2id', async () => {
    expect(await passwordHasher.hash('x')).toMatch(/^\$argon2id\$/);
  }, 20_000);

  // An OTP-only guardian has password_hash NULL. A throw here would 500 and
  // leak which accounts have passwords.
  it('returns false rather than throwing on a malformed hash', async () => {
    expect(await passwordHasher.verify('not-a-hash', 'x')).toBe(false);
    expect(await passwordHasher.verify('', 'x')).toBe(false);
  });
});
