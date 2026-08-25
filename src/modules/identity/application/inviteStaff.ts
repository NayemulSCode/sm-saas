/**
 * Invite a staff member. §8.4.
 *
 * AUTHENTICATED and tenant-scoped, unlike the login use cases: an existing
 * member of a school is granting access to it. Runs through `withTenant`, so
 * RLS applies and the invite cannot be created in another tenant.
 *
 * The interesting case is a person who ALREADY has an account — a teacher at
 * School A invited by School B. They get a second MEMBERSHIP, not a second
 * identity, and they keep their existing password (ADR-0006).
 */

import { withTenant, withPlatform } from '../../../db/rls';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { Ids, type MembershipId, type PersonId, type RoleId } from '../../../shared/ids';
import { normaliseIdentifier } from '../domain/phone';
import { INVITE, inviteExpiryFrom } from '../domain/invite';
import type { TokenGenerator } from '../domain/ports';
import { credentials } from '../infrastructure/repositories';
import { invites } from '../infrastructure/inviteRepository';

export const InviteErrors = defineErrors({
  INVALID_IDENTIFIER: {
    code: 'INVALID_IDENTIFIER',
    messageKey: 'auth.error.invalidIdentifier',
    httpStatus: 400,
  },
  ALREADY_A_MEMBER: {
    code: 'ALREADY_A_MEMBER',
    messageKey: 'invite.error.alreadyMember',
    httpStatus: 409,
  },
  INVITE_NOT_FOUND: {
    code: 'INVITE_NOT_FOUND',
    messageKey: 'invite.error.notFound',
    httpStatus: 404,
  },
});

export interface InviteStaffInput {
  /** The person record already exists — `directory` owns creating it (§14.5). */
  personId: PersonId;
  /** Phone or email. Becomes their login identifier if they have no account. */
  identifier: string;
  roleIds: RoleId[];
}

export interface InviteStaffDeps {
  tokens: TokenGenerator;
  now?: () => Date;
}

export interface InviteStaffResult {
  membershipId: MembershipId;
  /**
   * Returned ONCE and never stored in plaintext. The caller puts it in the
   * link; only its hash reaches the database.
   *
   * `null` when the invitee already has a password — they were granted access
   * and should sign in normally, with no link to leak.
   */
  inviteToken: string | null;
  expiresAt: Date | null;
}

export async function inviteStaff(
  ctx: AuthContext,
  input: InviteStaffInput,
  deps: InviteStaffDeps,
): Promise<Result<InviteStaffResult, DomainError>> {
  authorize(ctx, 'membership.manage');
  const now = deps.now?.() ?? new Date();

  const identifier = normaliseIdentifier(input.identifier);
  if (!identifier.ok) return err(InviteErrors.INVALID_IDENTIFIER);

  /*
   * `account` and `credential` are GLOBAL: they span tenants by design, so
   * they cannot be read or written inside a tenant session. This is the only
   * cross-tenant step, it is narrow (one identifier), and it is audited.
   */
  const existing = await withPlatform(
    'invite: find or create the global login for an invitee',
    async (tx) => {
      const found = await credentials.byIdentifier(
        tx,
        identifier.value.kind,
        identifier.value.value,
      );
      if (found) return found;
      return invites.createLogin(tx, identifier.value.kind, identifier.value.value);
    },
  );

  return withTenant(ctx, async (tx) => {
    // Being invited twice to the same school is a mistake worth surfacing,
    // not a silent no-op.
    if (await invites.membershipExists(tx, existing.accountId, input.personId)) {
      return err(InviteErrors.ALREADY_A_MEMBER);
    }

    const membershipId = Ids.generate<'membership'>();
    await invites.createMembership(tx, {
      id: membershipId,
      accountId: existing.accountId,
      personId: input.personId,
      roleIds: input.roleIds,
      actorId: ctx.personId,
    });

    // Already has a password: they were granted access to a second school and
    // sign in with the credentials they already use. No link is minted, so
    // there is nothing to leak.
    if (existing.passwordHash !== null && existing.passwordHash.length > 0) {
      return ok({ membershipId, inviteToken: null, expiresAt: null });
    }

    const { token, hash } = deps.tokens.newSessionToken();
    const expiresAt = inviteExpiryFrom(now);

    await invites.create(tx, {
      accountId: existing.accountId,
      credentialId: existing.id,
      membershipId,
      personId: input.personId,
      tokenHash: hash,
      expiresAt,
      invitedBy: ctx.personId,
    });

    return ok({ membershipId, inviteToken: token, expiresAt });
  });
}

/** Revokes a live invite. The link stops working immediately. */
export async function revokeInvite(
  ctx: AuthContext,
  membershipId: MembershipId,
  reason: string,
): Promise<Result<{ revoked: boolean }, DomainError>> {
  authorize(ctx, 'membership.manage');

  return withTenant(ctx, async (tx) => {
    const count = await invites.revokeForMembership(tx, membershipId, reason, ctx.personId);
    if (count === 0) return err(InviteErrors.INVITE_NOT_FOUND);
    return ok({ revoked: true });
  });
}

export { INVITE };
