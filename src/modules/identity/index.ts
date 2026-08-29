/**
 * The identity module's ONLY importable surface.
 *
 * Nothing outside this module may reach into `domain/`, `application/` or
 * `infrastructure/` — a lint rule enforces it (ADR-0001). That is what makes
 * "extract this module into a service" a packaging change rather than a
 * rewrite: the public surface is already explicit and already narrow.
 */

// ── use cases ───────────────────────────────────────────────────────────────
export { requestOtp } from './application/requestOtp';
export type {
  RequestOtpInput,
  RequestOtpDeps,
  RequestOtpResult,
} from './application/requestOtp';

export { verifyOtp, IdentityErrors } from './application/verifyOtp';
export type {
  VerifyOtpInput,
  VerifyOtpDeps,
  VerifyOtpResult,
  ResolvedContext,
} from './application/verifyOtp';

// ── domain policy, exported because the transport layer needs the numbers ───
export { OTP } from './domain/otp';
export { SESSION_POLICY, evaluateSession, shouldTouchLastSeen } from './domain/session';
export type { SessionAudience, SessionState, SessionVerdict } from './domain/session';

// ── normalisation, used by the Zod schemas at the API boundary ──────────────
export { normalisePhone, normaliseEmail, normaliseIdentifier } from './domain/phone';
export type { CredentialKind, CredentialError } from './domain/phone';

// ── ports, so a caller can supply adapters (and tests can supply fakes) ─────
export type {
  PasswordHasher,
  CodeHasher,
  TokenGenerator,
  RandomSource,
  OtpDispatcher,
  AuthenticationContext,
  ContextResolver,
} from './domain/ports';

// ── the production adapters ─────────────────────────────────────────────────
export {
  passwordHasher,
  codeHasher,
  tokenGenerator,
  randomSource,
} from './infrastructure/crypto';

// ── session and context switching ───────────────────────────────────────────
export {
  resolveSession,
  listContexts,
  switchContext,
  SessionErrors,
} from './application/switchContext';
export type {
  SessionDeps,
  AvailableContext,
  ResolvedSession,
} from './application/switchContext';
export { revokeSession, revokeAllSessions } from './application/switchContext';

// ── request DTOs, shared by the client form and the server handler ──────────
export {
  OtpRequestSchema,
  OtpVerifySchema,
  ActivateContextSchema,
} from './application/dto';
export type { OtpRequestDto, OtpVerifyDto, ActivateContextDto } from './application/dto';

// ── OTP delivery adapter ────────────────────────────────────────────────────
export { otpDispatcher, mockOtpDispatcher } from './infrastructure/otpDispatcher';

// ── password login (staff) ──────────────────────────────────────────────────
export { authenticatePassword, PasswordErrors } from './application/authenticatePassword';
export type {
  PasswordLoginInput,
  PasswordLoginDeps,
  PasswordLoginResult,
} from './application/authenticatePassword';
export { LOCKOUT, gateLogin, hasPassword } from './domain/password';
export { PasswordLoginSchema } from './application/dto';
export type { PasswordLoginDto } from './application/dto';

// ── staff invitations ───────────────────────────────────────────────────────
export { inviteStaff, revokeInvite, InviteErrors } from './application/inviteStaff';
export type {
  InviteStaffInput,
  InviteStaffDeps,
  InviteStaffResult,
} from './application/inviteStaff';
export { acceptInvite, AcceptInviteErrors } from './application/acceptInvite';
export type {
  AcceptInviteInput,
  AcceptInviteDeps,
  AcceptInviteResult,
} from './application/acceptInvite';
export { INVITE, verifyInvite, shouldSetPassword } from './domain/invite';
export { resolveAuthContext, AuthContextErrors } from './application/resolveAuthContext';
export type { AuthContextDeps } from './application/resolveAuthContext';
export { mergeScopes } from './domain/scope';
export { InviteStaffSchema, AcceptInviteSchema, RevokeInviteSchema } from './application/dto';
export type { InviteStaffDto, AcceptInviteDto, RevokeInviteDto } from './application/dto';

export {
  grantRole,
  revokeRole,
  listRoles,
  GrantErrors,
  type GrantRoleInput,
} from './application/grantRole';
export { evaluateGrant, type GrantVerdict } from './domain/grant';
export { GrantRoleSchema, RevokeRoleSchema } from './application/dto';
