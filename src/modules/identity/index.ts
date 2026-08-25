/**
 * The identity module's ONLY importable surface.
 *
 * Nothing outside this module may reach into `domain/`, `application/` or
 * `infrastructure/` — a lint rule enforces it (ADR-0001). That is what makes
 * "extract this module into a service" a packaging change rather than a
 * rewrite: the public surface is already explicit and already narrow.
 */

// ── use cases ───────────────────────────────────────────────────────────────
export { requestOtp } from './application/requestOtp.js';
export type {
  RequestOtpInput,
  RequestOtpDeps,
  RequestOtpResult,
} from './application/requestOtp.js';

export { verifyOtp, IdentityErrors } from './application/verifyOtp.js';
export type {
  VerifyOtpInput,
  VerifyOtpDeps,
  VerifyOtpResult,
  ResolvedContext,
} from './application/verifyOtp.js';

// ── domain policy, exported because the transport layer needs the numbers ───
export { OTP } from './domain/otp.js';
export { SESSION_POLICY, evaluateSession, shouldTouchLastSeen } from './domain/session.js';
export type { SessionAudience, SessionState, SessionVerdict } from './domain/session.js';

// ── normalisation, used by the Zod schemas at the API boundary ──────────────
export { normalisePhone, normaliseEmail, normaliseIdentifier } from './domain/phone.js';
export type { CredentialKind, CredentialError } from './domain/phone.js';

// ── ports, so a caller can supply adapters (and tests can supply fakes) ─────
export type {
  PasswordHasher,
  CodeHasher,
  TokenGenerator,
  RandomSource,
  OtpDispatcher,
  AuthenticationContext,
  ContextResolver,
} from './domain/ports.js';

// ── the production adapters ─────────────────────────────────────────────────
export {
  passwordHasher,
  codeHasher,
  tokenGenerator,
  randomSource,
} from './infrastructure/crypto.js';
