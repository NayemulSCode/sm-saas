/**
 * AuthContext — the object every use case takes as its first argument.
 *
 * It is built in middleware from VERIFIED memberships and never from request
 * input. That is the single reason `tenantIds` can be trusted enough to drive
 * the RLS session variable (§5.4).
 */

import type {
  AccountId,
  CampusId,
  ClassLevelId,
  MembershipId,
  PersonId,
  SectionId,
  SessionId,
  SubjectId,
  TenantId,
} from './ids';
import type { Permission } from './permissions';
import { isWritePermission } from './permissions';

export interface Scope {
  /** An absent key means unrestricted WITHIN the tenant. Never across tenants. */
  readonly campusIds?: readonly CampusId[];
  readonly classIds?: readonly ClassLevelId[];
  /** Present but empty denies everything — a misconfigured role fails closed. */
  readonly sectionIds?: readonly SectionId[];
  readonly subjectIds?: readonly SubjectId[];
}

export interface Impersonation {
  readonly operatorId: AccountId;
  readonly reason: string;
  readonly expiresAt: Date;
  readonly readOnly: boolean;
}

export interface AuthContext {
  readonly accountId: AccountId;
  readonly sessionId: SessionId;

  /**
   * Normally exactly one. Several ONLY for an organization administrator
   * viewing across their own schools, derived from verified memberships.
   */
  readonly tenantIds: readonly TenantId[];
  readonly activeTenantId: TenantId;

  readonly personId: PersonId;
  readonly membershipId: MembershipId;
  readonly permissions: ReadonlySet<Permission>;
  readonly scope: Scope;
  /**
   * The role codes granted to this membership — 'Guardian', 'ClassTeacher',
   * and so on. Not a permission set: `Librarian` and `Guardian` currently hold
   * the identical base permission (`student.read`), and only the ROLE tells
   * them apart for {@link isHouseholdOnly}. There is no role-authoring
   * endpoint yet, so a code here is always one of the fixed system codes in
   * `RoleCode` — revisit this comment the day a school can name its own roles.
   */
  readonly roleCodes: readonly string[];

  readonly locale: 'en' | 'bn';
  readonly requestId: string;

  /** A suspended tenant resolves but cannot write (invariant 14). */
  readonly readOnly: boolean;

  readonly impersonation?: Impersonation;
}

export type ScopeTarget = {
  readonly campusId?: CampusId;
  readonly classId?: ClassLevelId;
  readonly sectionId?: SectionId;
  readonly subjectId?: SubjectId;
};

export class AuthorizationError extends Error {
  constructor(
    readonly permission: Permission,
    readonly kind: 'forbidden' | 'out_of_scope' | 'read_only',
  ) {
    super(`Authorization failed (${kind}) for ${permission}`);
    this.name = 'AuthorizationError';
  }
}

function inScope(scope: Scope, target: ScopeTarget): boolean {
  // A present-but-empty list denies. An absent list is unrestricted.
  const check = <T>(allowed: readonly T[] | undefined, value: T | undefined): boolean => {
    if (allowed === undefined) return true;
    if (value === undefined) return false;
    return allowed.includes(value);
  };

  return (
    check(scope.campusIds, target.campusId) &&
    check(scope.classIds, target.classId) &&
    check(scope.sectionIds, target.sectionId) &&
    check(scope.subjectIds, target.subjectId)
  );
}

/**
 * Called by EVERY use case. Asserts, so control flow after it is typed as
 * authorized. A lint rule flags exported use cases whose body lacks the call.
 */
export function authorize(
  ctx: AuthContext,
  permission: Permission,
  target?: ScopeTarget,
): void {
  if (ctx.readOnly && isWritePermission(permission)) {
    throw new AuthorizationError(permission, 'read_only');
  }
  if (ctx.impersonation?.readOnly === true && isWritePermission(permission)) {
    throw new AuthorizationError(permission, 'read_only');
  }
  if (!ctx.permissions.has(permission)) {
    throw new AuthorizationError(permission, 'forbidden');
  }
  if (target !== undefined && !inScope(ctx.scope, target)) {
    throw new AuthorizationError(permission, 'out_of_scope');
  }
}

export function can(ctx: AuthContext, permission: Permission, target?: ScopeTarget): boolean {
  try {
    authorize(ctx, permission, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * True for a Guardian or Student membership — a household account, never a
 * member of staff.
 *
 * Why this exists: `Guardian` is granted `student.read` (§9.2) so the
 * guardian-facing use cases can share the permission key with staff ones, on
 * the assumption those use cases scope by RELATIONSHIP rather than by Scope.
 * That assumption only holds where every caller respects it. The (staff)
 * surface's own pages do not — `listStudents`/`getStudent` answer for any
 * student in the tenant to anyone holding `student.read`, and `Librarian`
 * holds exactly that same permission with no more. A permission check alone
 * therefore cannot tell a librarian from a guardian; only the role can. Every
 * staff-surface page calls this before rendering anything and redirects a
 * household session to the guardian surface instead.
 *
 * `[].every(...)` is vacuously true, so a membership holding NO role at all is
 * also treated as household — the safe direction, since no role means no
 * proven staff duty either.
 */
const HOUSEHOLD_ROLES = new Set(['Guardian', 'Student']);
export function isHouseholdOnly(ctx: AuthContext): boolean {
  return ctx.roleCodes.every((code) => HOUSEHOLD_ROLES.has(code));
}

/**
 * An OPERATOR of the platform, not a member of any school.
 *
 * A separate type rather than an AuthContext with the tenant fields left blank.
 * An operator genuinely has no `activeTenantId`, no `personId` and no
 * `membershipId` — those come from a verified membership, and an operator has
 * none. Faking them would put unverifiable values into the one object the whole
 * tenancy chain trusts, and `withTenant` would happily open a session for a
 * tenant nobody proved they belong to.
 *
 * The platform pool is the only place this is usable, and every use of it is
 * audited (ADR-0029).
 */
export interface PlatformContext {
  /**
   * Optional, because a CLI run has no account behind it — only whoever holds
   * the platform database credentials. The audit records that honestly as a
   * null actor rather than inventing an operator who does not exist. The
   * operator console will always supply one.
   */
  readonly accountId?: AccountId | undefined;
  readonly permissions: ReadonlySet<Permission>;
  readonly requestId: string;
  /** Required and audited. Operator actions are never routine. */
  readonly reason: string;
}

/** `authorize()` for an operator. Same assertion, different subject. */
export function authorizePlatform(ctx: PlatformContext, permission: Permission): void {
  if (!permission.startsWith('platform.')) {
    // A tenant permission checked against an operator context would pass or
    // fail for the wrong reasons; it is a programming error, not a refusal.
    throw new Error(`authorizePlatform called with a tenant permission: ${permission}`);
  }
  if (!ctx.permissions.has(permission)) {
    throw new AuthorizationError(permission, 'forbidden');
  }
  if (ctx.reason.trim().length < 10) {
    throw new Error('a platform action requires a substantive audit reason');
  }
}
