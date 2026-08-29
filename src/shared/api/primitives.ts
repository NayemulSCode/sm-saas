/**
 * Shared DTO primitives. §10.1.
 *
 * One schema per input, used by the client form AND the server handler, so the
 * two cannot drift.
 *
 * NFC normalisation lives HERE, in the schema, rather than in a service —
 * because every write path goes through a schema and none of them goes through
 * every service. Two visually identical Bangla names that do not compare equal
 * is a duplicate-detection failure nobody sees until a parent complains
 * (ADR-0019).
 */

import { z } from 'zod';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A ULID on the wire.
 *
 * Deliberately NOT transformed into a branded `Id<T>` here. The brand exists to
 * stop a StudentId being passed where an EnrolmentId belongs INSIDE the
 * application; at the transport edge the value is an untrusted string that has
 * only been shape-checked, and a cast at the call site is where the reader can
 * see that happening.
 */
export const zUlid = () => z.string().regex(ULID, 'common.error.invalidId');

/** NFC on write. Never optional, never forgotten. */
const nfc = (s: string) => s.normalize('NFC');

export const zNameBn = z.string().trim().min(1).max(120).transform(nfc);
export const zNameEn = z.string().trim().min(1).max(120).transform(nfc);

/** `YYYY-MM-DD`. Parsed into a LocalDate by the use case, not here — the
 *  transport layer should not own calendar semantics. */
export const zLocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'common.error.invalidDate');

/**
 * A Bangladeshi mobile number in E.164.
 *
 * Strict on purpose at this boundary: an operator typing a number into an
 * admission form has one right answer, and silently accepting `01711…` here
 * would store two formats for the same handset — which breaks the SMS
 * deduplication that FR-9.4 depends on.
 */
export const zPhoneBd = z
  .string()
  .trim()
  .regex(/^\+8801[3-9]\d{8}$/, 'auth.error.invalidIdentifier');

/**
 * A reason for a destructive action.
 *
 * Ten characters, matching `withPlatform`. "ok" and "." are not reasons, and
 * the whole point of demanding one is that somebody reads it a year later.
 */
export const zReason = z.string().trim().min(10).max(280);

/** A shorter reason, where the action is reversible and routine. */
export const zShortReason = z.string().trim().min(3).max(280);

/** Keyset pagination. Offset pagination shifts rows under a scrolling list. */
export const zPage = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const zRelationship = z.enum(['father', 'mother', 'guardian', 'emergency', 'other']);
export const zGender = z.enum(['male', 'female', 'other']);
export const zMedium = z.enum(['bangla', 'english', 'other']);
export const zOutcome = z.enum(['promoted', 'retained', 'transferred', 'withdrawn']);
export const zStudentStatus = z.enum([
  'applicant',
  'admitted',
  'active',
  'on_leave',
  'withdrawn',
  'alumni',
]);

/** `HH:MM` or `HH:MM:SS`, matching the `time` column. */
export const zTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'structure.error.invalidShiftTimes');
