/**
 * Request DTOs. One Zod schema per input, shared by the client form and the
 * server handler, so the two cannot drift (§19.7).
 *
 * Normalisation lives IN the schema rather than in a service, because every
 * write path goes through a schema and can therefore never skip it.
 */

import { z } from 'zod';
import { normaliseIdentifier } from '../domain/phone';
import { OTP } from '../domain/otp';

/**
 * Accepts phone or email, in any of the forms a Bangladeshi user actually
 * types, and emits the normalised value. An unparseable identifier is a
 * validation failure here rather than a silent miss at lookup time.
 */
const zIdentifier = z
  .string()
  .min(3)
  .max(160)
  .transform((raw, ctx) => {
    const result = normaliseIdentifier(raw);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: 'auth.error.invalidIdentifier' });
      return z.NEVER;
    }
    return result.value.value;
  });

export const OtpRequestSchema = z.object({
  identifier: zIdentifier,
});
export type OtpRequestDto = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({
  identifier: zIdentifier,
  code: z.string().regex(new RegExp(`^\\d{${OTP.digits}}$`), 'auth.error.codeShape'),
});
export type OtpVerifyDto = z.infer<typeof OtpVerifySchema>;

export const ActivateContextSchema = z.object({
  membershipId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'common.error.invalidId'),
});
export type ActivateContextDto = z.infer<typeof ActivateContextSchema>;

export const PasswordLoginSchema = z.object({
  identifier: zIdentifier,
  // Bounded to keep an Argon2id verify from being turned into a CPU amplifier:
  // the hasher's cost is fixed, but a megabyte of input still costs something.
  password: z.string().min(8).max(200),
});
export type PasswordLoginDto = z.infer<typeof PasswordLoginSchema>;

export const InviteStaffSchema = z.object({
  personId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'common.error.invalidId'),
  identifier: zIdentifier,
  roleIds: z
    .array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'common.error.invalidId'))
    .max(10)
    .default([]),
});
export type InviteStaffDto = z.infer<typeof InviteStaffSchema>;

export const AcceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(200),
});
export type AcceptInviteDto = z.infer<typeof AcceptInviteSchema>;

export const RevokeInviteSchema = z.object({
  // Revocation is audited, so the reason is required rather than optional.
  reason: z.string().min(3).max(280),
});
export type RevokeInviteDto = z.infer<typeof RevokeInviteSchema>;

export const GrantRoleSchema = z.object({
  roleId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'common.error.invalidId'),
  /**
   * `{}` — unrestricted within the tenant. An absent axis is unrestricted; a
   * present but empty one denies everything, so a misconfigured role fails
   * closed (§9.3).
   */
  scope: z
    .record(z.string(), z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)))
    .optional(),
  // Access changes are never routine.
  reason: z.string().trim().min(3).max(280),
});

export const RevokeRoleSchema = z.object({
  roleId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'common.error.invalidId'),
  reason: z.string().trim().min(3).max(280),
});
