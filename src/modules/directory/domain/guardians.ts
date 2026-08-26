/**
 * Guardian links. FR-4.9, FR-4.10.
 *
 * `is_billing_guardian` and `is_primary_contact` are SEPARATE flags, and the
 * whole module exists because collapsing them into one "primary guardian"
 * forces a wrong answer for a real family: separated parents where the father
 * pays and the mother is contacted, a grandmother who collects the child but
 * neither pays nor decides, a household sharing one handset.
 */

export const RELATIONSHIPS = ['father', 'mother', 'guardian', 'emergency', 'other'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export interface ExistingLink {
  id: string;
  guardianPersonId: string;
  relationship: Relationship;
  isBillingGuardian: boolean;
  isPrimaryContact: boolean;
  canReceiveResults: boolean;
  canCollectStudent: boolean;
}

export interface ProposedLink {
  guardianPersonId: string;
  relationship: Relationship;
  isBillingGuardian: boolean;
  isPrimaryContact: boolean;
}

export type LinkVerdict =
  | { kind: 'ok'; demoteBilling: string | null; demotePrimary: string | null }
  | { kind: 'already_linked' }
  /** An emergency contact is not a person who owes money or decides anything. */
  | { kind: 'emergency_cannot_bill' };

/**
 * Whether a link may be added, and which existing link has to step down.
 *
 * The database has a partial unique index for one billing guardian and one
 * primary contact per student, and it is not deferrable — so the incumbent is
 * demoted first, in the same transaction. Returning WHO to demote rather than
 * doing it here keeps this function pure and makes the demotion visible in the
 * audit trail as a deliberate consequence rather than a side effect.
 */
export function evaluateLink(
  existing: readonly ExistingLink[],
  proposed: ProposedLink,
): LinkVerdict {
  if (existing.some((l) => l.guardianPersonId === proposed.guardianPersonId)) {
    return { kind: 'already_linked' };
  }

  /*
   * An emergency contact is the number you ring when nobody else answers. They
   * have not agreed to pay fees and are not the household's decision-maker;
   * making one the billing guardian is almost always a data-entry slip, and it
   * produces an invoice addressed to a neighbour.
   */
  if (proposed.relationship === 'emergency' && proposed.isBillingGuardian) {
    return { kind: 'emergency_cannot_bill' };
  }

  return {
    kind: 'ok',
    demoteBilling: proposed.isBillingGuardian
      ? (existing.find((l) => l.isBillingGuardian)?.id ?? null)
      : null,
    demotePrimary: proposed.isPrimaryContact
      ? (existing.find((l) => l.isPrimaryContact)?.id ?? null)
      : null,
  };
}

export type UnlinkVerdict =
  | { kind: 'ok' }
  | { kind: 'not_linked' }
  /** Removing the only person the school can contact about this child. */
  | { kind: 'last_contact' }
  | { kind: 'would_leave_no_biller' };

/**
 * Whether a guardian may be unlinked.
 *
 * A student with no contactable guardian is unreachable: no absence SMS, no
 * result notification, nobody to call when they are ill. Removing the last one
 * is refused rather than warned about, because the consequence appears weeks
 * later and looks like the SMS system being broken.
 */
export function evaluateUnlink(
  existing: readonly ExistingLink[],
  guardianPersonId: string,
): UnlinkVerdict {
  const target = existing.find((l) => l.guardianPersonId === guardianPersonId);
  if (!target) return { kind: 'not_linked' };

  const remaining = existing.filter((l) => l.guardianPersonId !== guardianPersonId);
  if (remaining.length === 0) return { kind: 'last_contact' };

  if (target.isBillingGuardian && !remaining.some((l) => l.isBillingGuardian)) {
    // Nominate the replacement first. An invoice with nobody to address is a
    // problem finance discovers at the end of the month.
    return { kind: 'would_leave_no_biller' };
  }

  return { kind: 'ok' };
}

/**
 * Who to send a message to, deduplicated by handset. FR-9.4.
 *
 * Two absent siblings sharing one guardian phone must produce ONE message —
 * both because a family that receives two identical SMS stops reading them, and
 * because each one is billed.
 */
export function recipientsFor(
  links: ReadonlyArray<ExistingLink & { phone: string | null; suppressed?: boolean }>,
): string[] {
  const phones = new Set<string>();
  for (const l of links) {
    if (l.suppressed === true) continue;
    if (l.phone) phones.add(l.phone);
  }
  return [...phones];
}
