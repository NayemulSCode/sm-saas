/**
 * Guardian links and sibling groups. §14.5, FR-4.8 to FR-4.10.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import type { PersonId, StudentId } from '../../../shared/ids';
import { evaluateLink, evaluateUnlink, type Relationship } from '../domain/guardians';
import { directory } from '../infrastructure/repositories';
import { AdmissionErrors } from './admitStudent';

export const GuardianErrors = defineErrors({
  ALREADY_LINKED: {
    code: 'ALREADY_LINKED',
    messageKey: 'directory.error.alreadyLinked',
    httpStatus: 409,
  },
  NOT_LINKED: {
    code: 'NOT_LINKED',
    messageKey: 'directory.error.notLinked',
    httpStatus: 404,
  },
  EMERGENCY_CANNOT_BILL: {
    code: 'EMERGENCY_CANNOT_BILL',
    messageKey: 'directory.error.emergencyCannotBill',
    httpStatus: 409,
  },
  /** A student with nobody to contact is unreachable. */
  LAST_CONTACT: {
    code: 'LAST_CONTACT',
    messageKey: 'directory.error.lastContact',
    httpStatus: 409,
  },
  WOULD_LEAVE_NO_BILLER: {
    code: 'WOULD_LEAVE_NO_BILLER',
    messageKey: 'directory.error.wouldLeaveNoBiller',
    httpStatus: 409,
  },
  SAME_STUDENT: {
    code: 'SAME_STUDENT',
    messageKey: 'directory.error.sameStudent',
    httpStatus: 400,
  },
  /** Neither an existing person nor details for a new one. */
  NO_GUARDIAN_GIVEN: {
    code: 'NO_GUARDIAN_GIVEN',
    messageKey: 'directory.error.noGuardianGiven',
    httpStatus: 400,
  },
});

export interface LinkGuardianInput {
  studentId: StudentId;
  /**
   * An existing person, OR `person` below to create one.
   *
   * Both, because both happen. A sibling's guardian is already on file and
   * creating them again would fork the family; a new admission's father is
   * not, and making the office create him on a separate screen first is two
   * screens for one thought.
   */
  guardianPersonId?: PersonId | undefined;
  person?:
    | {
        nameBn: string;
        nameEn: string;
        phone?: string | undefined;
        email?: string | undefined;
      }
    | undefined;
  relationship: Relationship;
  isBillingGuardian?: boolean | undefined;
  isPrimaryContact?: boolean | undefined;
  canReceiveResults?: boolean | undefined;
  canCollectStudent?: boolean | undefined;
}

export async function linkGuardian(
  ctx: AuthContext,
  input: LinkGuardianInput,
): Promise<Result<{ linkId: string; demoted: string[] }, DomainError>> {
  authorize(ctx, 'guardian.write');

  if (!input.guardianPersonId && !input.person) {
    return err(GuardianErrors.NO_GUARDIAN_GIVEN);
  }

  return withTenant(ctx, async (tx) => {
    if (!(await directory.studentById(tx, input.studentId))) {
      return err(AdmissionErrors.STUDENT_NOT_FOUND);
    }

    /*
     * Created inside the transaction, so a guardian is never left orphaned by
     * a link that fails validation a line later.
     */
    const guardianPersonId =
      input.guardianPersonId ??
      (await directory.createPerson(tx, {
        nameBn: input.person!.nameBn,
        nameEn: input.person!.nameEn,
        ...(input.person!.phone !== undefined ? { phone: input.person!.phone } : {}),
        ...(input.person!.email !== undefined ? { email: input.person!.email } : {}),
        actorId: ctx.personId,
      }));

    if (input.guardianPersonId && !(await directory.personExists(tx, guardianPersonId))) {
      return err(AdmissionErrors.PERSON_NOT_FOUND);
    }

    const existing = await directory.linksFor(tx, input.studentId);
    const verdict = evaluateLink(existing, {
      guardianPersonId,
      relationship: input.relationship,
      isBillingGuardian: input.isBillingGuardian ?? false,
      isPrimaryContact: input.isPrimaryContact ?? false,
    });

    switch (verdict.kind) {
      case 'already_linked':
        return err(GuardianErrors.ALREADY_LINKED);
      case 'emergency_cannot_bill':
        return err(GuardianErrors.EMERGENCY_CANNOT_BILL);
      case 'ok':
        break;
    }

    /*
     * The incumbent steps down FIRST. The partial unique indexes allow one
     * billing guardian and one primary contact per student and are not
     * deferrable, so the insert would fail otherwise — and both statements are
     * in one transaction, so the student is never briefly unbilled.
     */
    const demoted: string[] = [];
    if (verdict.demoteBilling) {
      await directory.demoteLink(tx, verdict.demoteBilling, 'billing', ctx.personId);
      demoted.push(verdict.demoteBilling);
    }
    if (verdict.demotePrimary) {
      await directory.demoteLink(tx, verdict.demotePrimary, 'primary', ctx.personId);
      demoted.push(verdict.demotePrimary);
    }

    const linkId = await directory.createLink(tx, {
      studentId: input.studentId,
      guardianPersonId,
      relationship: input.relationship,
      isBillingGuardian: input.isBillingGuardian ?? false,
      isPrimaryContact: input.isPrimaryContact ?? false,
      canReceiveResults: input.canReceiveResults ?? true,
      canCollectStudent: input.canCollectStudent ?? true,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'guardian.linked', input.studentId, {
      entityType: 'student',
      after: {
        linkId,
        guardianPersonId,
        relationship: fact(input.relationship),
        isBillingGuardian: input.isBillingGuardian ?? false,
        isPrimaryContact: input.isPrimaryContact ?? false,
        // Recorded because a demotion is a consequence somebody may need to
        // explain: "why did the father stop being the billing guardian?"
        demoted: demoted.length > 0 ? fact(demoted.join(',')) : null,
      },
    });

    return ok({ linkId, demoted });
  });
}

export async function unlinkGuardian(
  ctx: AuthContext,
  input: { studentId: StudentId; guardianPersonId: PersonId; reason: string },
): Promise<Result<{ unlinked: boolean }, DomainError>> {
  authorize(ctx, 'guardian.write');

  return withTenant(ctx, async (tx) => {
    const existing = await directory.linksFor(tx, input.studentId);
    const verdict = evaluateUnlink(existing, input.guardianPersonId);

    switch (verdict.kind) {
      case 'not_linked':
        return err(GuardianErrors.NOT_LINKED);
      case 'last_contact':
        return err(GuardianErrors.LAST_CONTACT);
      case 'would_leave_no_biller':
        return err(GuardianErrors.WOULD_LEAVE_NO_BILLER);
      case 'ok':
        break;
    }

    const target = existing.find((l) => l.guardianPersonId === input.guardianPersonId)!;
    await directory.softDeleteLink(tx, target.id, input.reason, ctx.personId);

    await audit(tx, ctx, 'guardian.unlinked', input.studentId, {
      entityType: 'student',
      reason: input.reason,
      before: { linkId: target.id, guardianPersonId: input.guardianPersonId },
    });

    return ok({ unlinked: true });
  });
}

/**
 * Puts two students in the same sibling group. FR-4.8.
 *
 * Drives sibling discounts and SMS deduplication — two absent siblings sharing
 * one guardian phone must produce one message. A student belongs to exactly one
 * group, or a discount could be applied twice.
 */
export async function linkSiblings(
  ctx: AuthContext,
  input: { studentId: StudentId; siblingStudentId: StudentId },
): Promise<Result<{ groupId: string; members: number }, DomainError>> {
  authorize(ctx, 'student.write');

  if (input.studentId === input.siblingStudentId) return err(GuardianErrors.SAME_STUDENT);

  return withTenant(ctx, async (tx) => {
    for (const id of [input.studentId, input.siblingStudentId]) {
      if (!(await directory.studentById(tx, id))) return err(AdmissionErrors.STUDENT_NOT_FOUND);
    }

    const groupA = await directory.groupFor(tx, input.studentId);
    const groupB = await directory.groupFor(tx, input.siblingStudentId);

    /*
     * Two students who are each already in a DIFFERENT group is a merge of two
     * families' records, not a link. Refused here rather than guessed: the
     * unique constraint would refuse the second membership anyway, and picking
     * a winner silently could move a child out of their real sibling group.
     */
    if (groupA && groupB && groupA !== groupB) return err(GuardianErrors.ALREADY_LINKED);

    const groupId = groupA ?? groupB ?? (await directory.createGroup(tx, ctx.personId));
    if (!groupA) await directory.addToGroup(tx, groupId, input.studentId, ctx.personId);
    if (!groupB) await directory.addToGroup(tx, groupId, input.siblingStudentId, ctx.personId);

    const members = await directory.membersOf(tx, groupId);

    await audit(tx, ctx, 'sibling.linked', input.studentId, {
      entityType: 'student',
      after: {
        groupId,
        siblingStudentId: input.siblingStudentId,
        members: fact(members.length),
      },
    });

    return ok({ groupId, members: members.length });
  });
}
