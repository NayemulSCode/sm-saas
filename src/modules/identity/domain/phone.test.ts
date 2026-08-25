import { describe, it, expect } from 'vitest';
import { normalisePhone, normaliseEmail, normaliseIdentifier } from './phone';

const unwrap = (r: ReturnType<typeof normalisePhone>): string => {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
};

describe('normalisePhone', () => {
  // The whole point: these are the SAME guardian. Without normalisation they
  // become three accounts and the OTP lookup misses the one they have.
  it('folds every common way a Bangladeshi number is typed', () => {
    const forms = [
      '01711223344',
      '+8801711223344',
      '8801711223344',
      '+88 01711-223344',
      '01711 223344',
      '(01711) 223344',
      '+88 (01711) 22-33-44',
    ];
    for (const form of forms) {
      expect(unwrap(normalisePhone(form)), form).toBe('+8801711223344');
    }
  });

  it('accepts Bangla digits', () => {
    expect(unwrap(normalisePhone('০১৭১১২২৩৩৪৪'))).toBe('+8801711223344');
    expect(unwrap(normalisePhone('+৮৮০১৭১১২২৩৩৪৪'))).toBe('+8801711223344');
  });

  it('accepts every live operator prefix 013–019', () => {
    for (const p of ['13', '14', '15', '16', '17', '18', '19']) {
      expect(unwrap(normalisePhone(`01${p.slice(1)}11223344`))).toMatch(/^\+8801/);
    }
  });

  it('rejects a number that is too short or too long', () => {
    expect(normalisePhone('0171122334').ok).toBe(false);
    expect(normalisePhone('017112233445').ok).toBe(false);
  });

  it('rejects an invalid operator prefix', () => {
    // 012 and 010 are not allocated to mobile.
    expect(normalisePhone('01211223344').ok).toBe(false);
    expect(normalisePhone('01011223344').ok).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(normalisePhone('not-a-phone').ok).toBe(false);
    expect(normalisePhone('').ok).toBe(false);
  });

  it('is idempotent', () => {
    const once = unwrap(normalisePhone('01711223344'));
    expect(unwrap(normalisePhone(once))).toBe(once);
  });
});

describe('normaliseEmail', () => {
  it('trims and lowercases', () => {
    const r = normaliseEmail('  Head@School.EDU.BD ');
    expect(r.ok && r.value).toBe('head@school.edu.bd');
  });

  it('rejects a malformed address', () => {
    for (const bad of ['no-at-sign', 'a@b', '@b.com', 'a b@c.com', '']) {
      expect(normaliseEmail(bad).ok, bad).toBe(false);
    }
  });
});

describe('normaliseIdentifier', () => {
  // Staff have email, guardians largely do not. Login accepts either.
  it('routes by the presence of @', () => {
    const email = normaliseIdentifier('Principal@School.bd');
    expect(email.ok && email.value).toEqual({ kind: 'email', value: 'principal@school.bd' });

    const phone = normaliseIdentifier('০১৭১১২২৩৩৪৪');
    expect(phone.ok && phone.value).toEqual({ kind: 'phone', value: '+8801711223344' });
  });

  it('reports the right error kind for each', () => {
    const e = normaliseIdentifier('broken@');
    expect(!e.ok && e.error.code).toBe('INVALID_EMAIL');
    const p = normaliseIdentifier('12345');
    expect(!p.ok && p.error.code).toBe('INVALID_PHONE');
  });
});
