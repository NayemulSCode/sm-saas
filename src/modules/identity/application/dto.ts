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
