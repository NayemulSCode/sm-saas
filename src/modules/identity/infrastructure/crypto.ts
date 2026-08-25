/**
 * Cryptographic adapters for the identity ports.
 *
 * What is NOT hand-rolled: Argon2id, CSPRNG, SHA-256, constant-time comparison.
 * What is hand-rolled is session and context resolution, which is domain logic
 * in any case (§5.4).
 */

import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type {
  CodeHasher,
  PasswordHasher,
  RandomSource,
  TokenGenerator,
} from '../domain/ports';
import { env } from '../../../config/env';

/**
 * Argon2id at the OWASP baseline, with memory deliberately modest.
 *
 * The app shares an 8 GB host with PostgreSQL and a Chromium renderer
 * (ADR-0002). A 64 MiB setting under a login burst would compete with the
 * database for exactly the memory the database needs.
 *
 * `algorithm` is left at the library default rather than passed explicitly:
 * `@node-rs/argon2` exports `Algorithm` as an ambient const enum, which cannot
 * be referenced under `verbatimModuleSyntax`. Relying on a default for a
 * security parameter is only acceptable because a test asserts the produced
 * hash actually starts with `$argon2id$` — see crypto.test.ts.
 */
export const passwordHasher: PasswordHasher = {
  async hash(plain) {
    return argonHash(plain, {
      memoryCost: env().ARGON2_MEMORY_KIB,
      timeCost: 2,
      parallelism: 1,
    });
  },

  async verify(hash, plain) {
    // A malformed or absent hash must be a plain `false`, never a throw:
    // an OTP-only guardian has password_hash NULL, and a 500 there would leak
    // which accounts have passwords.
    try {
      return await argonVerify(hash, plain);
    } catch {
      return false;
    }
  },
};

/** OTP codes are hashed at rest, so a database leak yields no live codes. */
export const codeHasher: CodeHasher = {
  hash(code) {
    return createHash('sha256').update(code, 'utf8').digest('hex');
  },

  equals(a, b) {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    // timingSafeEqual throws on a length mismatch, which would itself leak.
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  },
};

export const tokenGenerator: TokenGenerator = {
  newSessionToken() {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashToken(token) };
  },

  hashToken(token) {
    return createHash('sha256').update(token, 'utf8').digest();
  },
};

/** Uniform, CSPRNG-backed — `Math.random()` is not acceptable for an OTP. */
export const randomSource: RandomSource = {
  int(maxExclusive) {
    return randomInt(maxExclusive);
  },
};
