/**
 * Branded ULIDs stored as `uuid`. ADR-0016.
 *
 * Branding is compile-time only — zero runtime cost — and makes
 * `getEnrolment(studentId)` fail to compile. A student and their enrolment are
 * both "the student" in conversation, which is exactly why the type system has
 * to keep them apart.
 *
 * Ids are generated in the APPLICATION so a full object graph can be built
 * before any of it is written — the import staging flow depends on it.
 */

import { monotonicFactory, decodeTime } from 'ulidx';
import { type Result, ok, err } from './result';

/**
 * Monotonic, not the plain factory.
 *
 * Plain `ulid()` draws a fresh random component every call, so two ids created
 * in the SAME millisecond have no defined order. ADR-0016 chose ULIDs precisely
 * for time-ordered inserts — keeping `attendance` and `audit_log` writes at the
 * right edge of the B-tree — and a bulk import creates thousands of ids per
 * millisecond. The monotonic factory increments the random component within a
 * millisecond, so ordering is strict rather than merely millisecond-granular.
 */
const nextUlid = monotonicFactory();

declare const brand: unique symbol;

export type Id<T extends string> = string & { readonly [brand]: T };

export type PlanId = Id<'plan'>;
export type TenantId = Id<'tenant'>;
export type AccountId = Id<'account'>;
export type CredentialId = Id<'credential'>;
export type SessionId = Id<'session'>;
export type OtpChallengeId = Id<'otpChallenge'>;
export type MembershipId = Id<'membership'>;
export type RoleId = Id<'role'>;
export type PersonId = Id<'person'>;
export type StudentId = Id<'student'>;
export type StaffId = Id<'staff'>;
export type EnrolmentId = Id<'enrolment'>;
export type OrganizationId = Id<'organization'>;
export type SchoolId = Id<'school'>;
export type CampusId = Id<'campus'>;
export type ShiftId = Id<'shift'>;
export type AcademicYearId = Id<'academicYear'>;
export type TermId = Id<'term'>;
export type ClassLevelId = Id<'classLevel'>;
export type SectionId = Id<'section'>;
export type SubjectId = Id<'subject'>;
export type MembershipRoleId = Id<'membershipRole'>;
export type StaffInviteId = Id<'staffInvite'>;
export type FeeHeadId = Id<'feeHead'>;
export type FeeStructureId = Id<'feeStructure'>;

export type IdError = { code: 'INVALID_ULID'; input: string };

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Crockford base32 alphabet, excluding I, L, O and U. */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const Ids = {
  generate<T extends string>(): Id<T> {
    return nextUlid() as Id<T>;
  },

  parse<T extends string>(input: string): Result<Id<T>, IdError> {
    const s = input.toUpperCase();
    return ULID_RE.test(s) ? ok(s as Id<T>) : err({ code: 'INVALID_ULID', input });
  },

  is(input: string): boolean {
    return ULID_RE.test(input.toUpperCase());
  },

  /** Creation time encoded in the ULID prefix. Useful in debugging, never in
   *  domain logic — a row's `created_at` is the source of truth. */
  timeOf(id: Id<string>): Date {
    return new Date(decodeTime(id));
  },

  /**
   * ULID text → canonical uuid text for the database.
   * A ULID is 128 bits, exactly a uuid, so this is a base conversion and not a
   * hash: it round-trips losslessly.
   */
  toUuid(id: Id<string>): string {
    let n = 0n;
    for (const ch of id) {
      const v = B32.indexOf(ch);
      if (v === -1) throw new Error(`Invalid ULID character: ${ch}`);
      n = n * 32n + BigInt(v);
    }
    const hex = n.toString(16).padStart(32, '0');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20, 32),
    ].join('-');
  },

  fromUuid<T extends string>(uuid: string): Id<T> {
    const hex = uuid.replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Invalid uuid: ${uuid}`);
    let n = BigInt(`0x${hex}`);
    let out = '';
    for (let i = 0; i < 26; i++) {
      out = B32[Number(n % 32n)] + out;
      n /= 32n;
    }
    return out as Id<T>;
  },
};
