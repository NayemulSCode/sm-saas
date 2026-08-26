/**
 * Redaction, diffing and the reason rule. No database — these are the pure
 * parts, and they are the parts that decide whether PII reaches the audit
 * table.
 */

import { describe, it, expect } from 'vitest';
import {
  redact,
  redactValue,
  changedFields,
  hashIdentifier,
  REDACTED,
  REASON_REQUIRED,
} from './audit';

const ULID = '01JBQ8ZK9M3XN7R2VWD4TYFGHA';
const UUID = '0192f4e1-6c3d-7a2b-8f1e-3c4d5a6b7c8d';

describe('redactValue', () => {
  it('keeps ids, in either representation', () => {
    expect(redactValue(ULID)).toBe(ULID);
    expect(redactValue(UUID)).toBe(UUID);
  });

  it('keeps booleans — a flag is not personal data', () => {
    expect(redactValue(true)).toBe(true);
    expect(redactValue(false)).toBe(false);
  });

  it('keeps absence as null rather than pretending it is a value', () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeNull();
  });

  // The whole point of invariant 12.
  it('redacts a phone number, a name and an email', () => {
    expect(redactValue('+8801711223344')).toBe(REDACTED);
    expect(redactValue('ফারহানা ইসলাম')).toBe(REDACTED);
    expect(redactValue('guardian@example.bd')).toBe(REDACTED);
  });

  it('redacts numbers — a mark and an amount are values, not ids', () => {
    expect(redactValue(72)).toBe(REDACTED);
    expect(redactValue(150000n)).toBe(REDACTED);
  });

  it('redacts dates — a date of birth is personal data', () => {
    expect(redactValue(new Date('2011-04-17'))).toBe(REDACTED);
  });

  it('redacts nested objects and arrays wholesale', () => {
    expect(redactValue({ phone: '+8801711223344' })).toBe(REDACTED);
    expect(redactValue(['a', 'b'])).toBe(REDACTED);
  });

  /*
   * The property that matters most: redaction is a WHITELIST. A column added
   * next year is redacted without anyone remembering to list it.
   */
  it('redacts an unfamiliar shape by default', () => {
    expect(redactValue(Symbol('x'))).toBe(REDACTED);
    expect(redactValue(() => 'x')).toBe(REDACTED);
    expect(redactValue('nid-1234567890123')).toBe(REDACTED);
  });
});

describe('redact', () => {
  it('keeps every key while dropping the values that are not ids', () => {
    const row = {
      id: ULID,
      tenantId: UUID,
      namebn: 'সালমা বেগম',
      phone: '+8801711223344',
      isPrimaryContact: true,
      dateOfBirth: new Date('2011-04-17'),
    };

    expect(redact(row)).toEqual({
      id: ULID,
      tenantId: UUID,
      namebn: REDACTED,
      phone: REDACTED,
      isPrimaryContact: true,
      dateOfBirth: REDACTED,
    });
  });

  it('never lets a raw value through, whatever the shape', () => {
    const serialised = JSON.stringify(
      redact({ a: 'secret value', b: 42, c: { deep: 'secret value' }, d: ['secret value'] }),
    );
    expect(serialised).not.toContain('secret value');
    expect(serialised).not.toContain('42');
  });
});

describe('changedFields', () => {
  it('lists only what moved', () => {
    expect(
      changedFields({ a: 1, b: 'x', c: true }, { a: 1, b: 'y', c: false }),
    ).toEqual(['b', 'c']);
  });

  it('compares dates by instant, not by identity', () => {
    const before = { at: new Date('2026-01-01T00:00:00Z') };
    const after = { at: new Date('2026-01-01T00:00:00Z') };
    expect(changedFields(before, after)).toEqual([]);
  });

  it('counts a key appearing or disappearing as a change', () => {
    expect(changedFields({ a: 1 }, { a: 1, b: 2 })).toEqual(['b']);
    expect(changedFields({ a: 1, b: 2 }, { a: 1 })).toEqual(['b']);
  });

  it('does not report a change when nothing changed', () => {
    expect(changedFields({ a: 1, b: null }, { a: 1, b: null })).toEqual([]);
  });
});

describe('hashIdentifier', () => {
  it('is stable, so repeated attempts on one number correlate', () => {
    expect(hashIdentifier('+8801711223344')).toEqual(hashIdentifier('+8801711223344'));
  });

  it('separates different identifiers', () => {
    expect(hashIdentifier('+8801711223344')).not.toEqual(hashIdentifier('+8801711223345'));
  });

  // Two visually identical Bangla strings must not hash differently.
  it('normalises to NFC first', () => {
    expect(hashIdentifier('আ@example.bd')).toEqual(
      hashIdentifier('আ@example.bd'.normalize('NFD')),
    );
  });

  it('does not contain the identifier', () => {
    expect(hashIdentifier('+8801711223344').toString('utf8')).not.toContain('8801711223344');
  });
});

describe('the reason rule', () => {
  it('covers revocation, which is the destructive action that exists today', () => {
    expect(REASON_REQUIRED.has('invite.revoked')).toBe(true);
  });

  it('does not demand a reason for ordinary creation', () => {
    expect(REASON_REQUIRED.has('invite.created')).toBe(false);
  });
});
