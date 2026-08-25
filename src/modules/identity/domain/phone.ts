/**
 * Credential normalisation. §8.1.
 *
 * A Bangladeshi number is typed as `01711…`, `+88 01711…` and `8801711…`
 * interchangeably. Without normalisation the same guardian gets three accounts,
 * and the OTP lookup misses the one they actually have.
 *
 * Applied before ANY lookup or insert — which is why it lives in the domain and
 * is called from the Zod schema at the boundary, not from a service somewhere
 * that can be bypassed.
 */

import { type Result, ok, err } from '../../../shared/result';
// Digit folding is generic text handling; it lives in money.ts because that is
// where it was first needed (parsing a typed amount).
import { toLatinDigits } from '../../../shared/money';

export type CredentialKind = 'phone' | 'email';

export type CredentialError =
  | { code: 'INVALID_PHONE'; input: string }
  | { code: 'INVALID_EMAIL'; input: string };

/** Bangladeshi mobile: 11 digits nationally, operator prefixes 013–019. */
const BD_NATIONAL = /^1[3-9]\d{8}$/;

/**
 * → E.164, e.g. `+8801711223344`.
 *
 * Accepts Bangla digits, spaces, dashes, brackets, an optional `+88` country
 * code and an optional trunk `0`.
 */
export function normalisePhone(raw: string): Result<string, CredentialError> {
  const cleaned = toLatinDigits(raw)
    .replace(/[\s\-().]/g, '')
    .replace(/^\+/, '');

  // Strip the country code, then the trunk zero. Order matters: `8801711…`
  // and `01711…` must both reduce to `1711…`.
  const withoutCountry = cleaned.startsWith('88') ? cleaned.slice(2) : cleaned;
  const national = withoutCountry.startsWith('0')
    ? withoutCountry.slice(1)
    : withoutCountry;

  if (!BD_NATIONAL.test(national)) {
    return err({ code: 'INVALID_PHONE', input: raw });
  }
  return ok(`+880${national}`);
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function normaliseEmail(raw: string): Result<string, CredentialError> {
  const value = raw.trim().toLowerCase();
  if (!EMAIL.test(value)) return err({ code: 'INVALID_EMAIL', input: raw });
  return ok(value);
}

/**
 * Normalises whichever kind the caller supplied. Login accepts either, because
 * staff have email and guardians largely do not — the contradiction flagged in
 * §1 of the executive summary.
 */
export function normaliseIdentifier(
  raw: string,
): Result<{ kind: CredentialKind; value: string }, CredentialError> {
  if (raw.includes('@')) {
    const e = normaliseEmail(raw);
    return e.ok ? ok({ kind: 'email', value: e.value }) : e;
  }
  const p = normalisePhone(raw);
  return p.ok ? ok({ kind: 'phone', value: p.value }) : p;
}
