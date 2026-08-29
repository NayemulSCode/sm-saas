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
import { audit } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { Ids, type MembershipId, type PersonId, type RoleId } from '../../../shared/ids';
import { normaliseIdentifier } from '../domain/phone';
import { INVITE, inviteExpiryFrom } from '../domain/invite';
import type { TokenGenerator } from '../domain/ports';
import { credentials } from '../infrastructure/repositories';
import { invites } from '../infrastructure/inviteRepository';
import { people } from '../infrastructure/personRepository';

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
  /** Neither an existing person nor a name to create one. */
  NO_PERSON_GIVEN: {
    code: 'NO_PERSON_GIVEN',
    messageKey: 'invite.error.noPersonGiven',
    httpStatus: 400,
  },
});

export interface InviteStaffInput {
  /**
   * An existing person, OR `person` below to create one.
   *
   * `directory` owns the person model, and this reaches into it deliberately:
   * requiring an office to create a teacher on one screen and invite them on
   * another is two screens for one thought, and the half-completed state in
   * between is a person nobody can find.
   */
  personId?: PersonId | undefined;
  person?: { nameBn: string; nameEn: string } | undefined;
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

  if (!input.personId && !input.person) return err(InviteErrors.NO_PERSON_GIVEN);

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
    /*
     * Created inside the transaction, so a person is never left behind by an
     * invite that fails validation a line later.
     */
    const personId =
      input.personId ??
      (await people.create(tx, {
        nameBn: input.person!.nameBn,
        nameEn: input.person!.nameEn,
        actorId: ctx.personId,
      }));

    // Being invited twice to the same school is a mistake worth surfacing,
    // not a silent no-op.
    if (await invites.membershipExists(tx, existing.accountId, personId)) {
      return err(InviteErrors.ALREADY_A_MEMBER);
    }

    const membershipId = Ids.generate<'membership'>();
    await invites.createMembership(tx, {
      id: membershipId,
      accountId: existing.accountId,
      personId,
      roleIds: input.roleIds,
      actorId: ctx.personId,
    });

    // Already has a password: they were granted access to a second school and
    // sign in with the credentials they already use. No link is minted, so
    // there is nothing to leak.
    if (existing.passwordHash !== null && existing.passwordHash.length > 0) {
      await audit(tx, ctx, 'membership.granted', membershipId, {
        after: {
          membershipId,
          personId,
          accountId: existing.accountId,
          roleCount: input.roleIds.length,
          // The distinguishing fact: no link was minted, so there is nothing
          // to leak and nothing to revoke.
          inviteLinkIssued: false,
        },
      });
      return ok({ membershipId, inviteToken: null, expiresAt: null });
    }

    const { token, hash } = deps.tokens.newSessionToken();
    const expiresAt = inviteExpiryFrom(now);

    await invites.create(tx, {
      accountId: existing.accountId,
      credentialId: existing.id,
      membershipId,
      personId,
      tokenHash: hash,
      expiresAt,
      invitedBy: ctx.personId,
    });

    // The TOKEN is never audited, only the fact that one exists. An audit row
    // carrying a live invite link would make the audit table a credential
    // store, which is the thing hashing it at rest was meant to prevent.
    await audit(tx, ctx, 'invite.created', membershipId, {
      entityType: 'invite',
      after: {
        membershipId,
        personId,
        accountId: existing.accountId,
        roleCount: input.roleIds.length,
        inviteLinkIssued: true,
      },
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

    // `audit()` refuses 'invite.revoked' without a reason, so the reason is
    // structurally guaranteed rather than merely requested by the DTO.
    await audit(tx, ctx, 'invite.revoked', membershipId, {
      entityType: 'invite',
      reason,
      after: { membershipId, revokedCount: count },
    });

    return ok({ revoked: true });
  });
}

export { INVITE };
