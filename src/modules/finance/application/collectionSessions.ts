/**
 * Opening, closing and verifying a collector's cash-drawer session. §13.3,
 * §13.7.
 *
 * Opt-in: `payment.collection_session_id` is nullable, and a school that
 * never opens one simply never gets this discipline applied — cash payments
 * still record fine. Once a session IS open, `recordPayment` attaches every
 * cash payment to it automatically (see that file), which is what makes
 * `expected_minor` — "Σ cash payments in session" — a real number rather
 * than something the collector has to compute by hand.
 */

import { withTenant } from '../../../db/rls';
import { audit, fact } from '../../../db/audit';
import { type Result, ok, err, type DomainError, defineErrors } from '../../../shared/result';
import { authorize, type AuthContext } from '../../../shared/auth-context';
import { LocalDate, systemClock, type Clock } from '../../../shared/date';
import { Money } from '../../../shared/money';
import type { CollectionSessionId, SchoolId } from '../../../shared/ids';
import { finance } from '../infrastructure/repositories';

export const CollectionSessionErrors = defineErrors({
  /** The `UNIQUE (tenant_id, collector_person_id, business_date)` this
   *  mirrors: one drawer per person per day, tenant-wide. */
  SESSION_ALREADY_OPEN: {
    code: 'SESSION_ALREADY_OPEN',
    messageKey: 'finance.error.sessionAlreadyOpen',
    httpStatus: 409,
  },
  SESSION_NOT_FOUND: {
    code: 'SESSION_NOT_FOUND',
    messageKey: 'finance.error.sessionNotFound',
    httpStatus: 404,
  },
  SESSION_NOT_OPEN: {
    code: 'SESSION_NOT_OPEN',
    messageKey: 'finance.error.sessionNotOpen',
    httpStatus: 409,
  },
  SESSION_NOT_CLOSED: {
    code: 'SESSION_NOT_CLOSED',
    messageKey: 'finance.error.sessionNotClosed',
    httpStatus: 409,
  },
  /** §13.3's own CHECK, restated: a non-zero variance without a reason is
   *  unrepresentable. Caught here first, so it reads as a 400 with a field
   *  rather than the constraint the caller never sees. */
  VARIANCE_REASON_REQUIRED: {
    code: 'VARIANCE_REASON_REQUIRED',
    messageKey: 'finance.error.varianceReasonRequired',
    httpStatus: 400,
  },
});

export interface CollectionSessionView {
  id: CollectionSessionId;
  schoolId: SchoolId;
  businessDate: string;
  status: 'open' | 'closed' | 'verified';
  expectedMinor?: string | undefined;
  countedMinor?: string | undefined;
  varianceMinor?: string | undefined;
}

export async function openCollectionSession(
  ctx: AuthContext,
  input: { schoolId: SchoolId },
  deps: { clock?: Clock } = {},
): Promise<Result<CollectionSessionView, DomainError>> {
  authorize(ctx, 'fee.collect');

  const today = LocalDate.today(deps.clock ?? systemClock);

  return withTenant(ctx, async (tx) => {
    const existing = await finance.collectorSessionFor(tx, {
      collectorPersonId: ctx.personId,
      businessDate: today,
    });
    if (existing) return err(CollectionSessionErrors.SESSION_ALREADY_OPEN);

    const sessionId = await finance.createCollectionSession(tx, {
      collectorPersonId: ctx.personId,
      schoolId: input.schoolId,
      businessDate: today,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'collectionSession.opened', sessionId, {
      entityType: 'collectionSession',
      after: {
        sessionId,
        schoolId: input.schoolId,
        collectorPersonId: fact(ctx.personId),
        businessDate: fact(LocalDate.toISO(today)),
      },
    });

    return ok({ id: sessionId, schoolId: input.schoolId, businessDate: LocalDate.toISO(today), status: 'open' });
  });
}

export interface CloseCollectionSessionInput {
  sessionId: CollectionSessionId;
  /** What was physically in the drawer, as a wire string. */
  countedMinor: string;
  varianceReason?: string | undefined;
}

export async function closeCollectionSession(
  ctx: AuthContext,
  input: CloseCollectionSessionInput,
  deps: { clock?: Clock } = {},
): Promise<Result<CollectionSessionView, DomainError>> {
  authorize(ctx, 'fee.collect');

  const counted = Money.fromJSON(input.countedMinor);
  const closedAt = (deps.clock ?? systemClock).now();

  return withTenant(ctx, async (tx) => {
    const session = await finance.collectionSessionById(tx, input.sessionId);
    if (!session) return err(CollectionSessionErrors.SESSION_NOT_FOUND);
    if (session.status !== 'open') return err(CollectionSessionErrors.SESSION_NOT_OPEN);

    const expected = await finance.sessionCashTotal(tx, input.sessionId);
    const variance = Money.sub(counted, Money.fromMinor(expected)).minor;
    if (variance !== 0n && !input.varianceReason?.trim()) {
      return err(CollectionSessionErrors.VARIANCE_REASON_REQUIRED);
    }

    await finance.closeCollectionSession(tx, {
      sessionId: input.sessionId,
      expectedMinor: expected,
      countedMinor: counted.minor,
      varianceMinor: variance,
      varianceReason: input.varianceReason ?? null,
      closedAt,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'collectionSession.closed', input.sessionId, {
      entityType: 'collectionSession',
      ...(input.varianceReason ? { reason: input.varianceReason } : {}),
      after: {
        sessionId: input.sessionId,
        expectedMinor: fact(expected.toString()),
        countedMinor: fact(counted.minor.toString()),
        varianceMinor: fact(variance.toString()),
      },
    });

    return ok({
      id: session.id,
      schoolId: session.schoolId,
      businessDate: LocalDate.toISO(session.businessDate),
      status: 'closed',
      expectedMinor: expected.toString(),
      countedMinor: counted.minor.toString(),
      varianceMinor: variance.toString(),
    });
  });
}

export interface VerifyCollectionSessionInput {
  sessionId: CollectionSessionId;
  depositReference?: string | undefined;
}

export async function verifyCollectionSession(
  ctx: AuthContext,
  input: VerifyCollectionSessionInput,
): Promise<Result<CollectionSessionView, DomainError>> {
  authorize(ctx, 'fee.reconcile');

  return withTenant(ctx, async (tx) => {
    const session = await finance.collectionSessionById(tx, input.sessionId);
    if (!session) return err(CollectionSessionErrors.SESSION_NOT_FOUND);
    if (session.status !== 'closed') return err(CollectionSessionErrors.SESSION_NOT_CLOSED);

    await finance.verifyCollectionSession(tx, {
      sessionId: input.sessionId,
      depositReference: input.depositReference ?? null,
      actorId: ctx.personId,
    });

    await audit(tx, ctx, 'collectionSession.verified', input.sessionId, {
      entityType: 'collectionSession',
      after: {
        sessionId: input.sessionId,
        depositReference: input.depositReference ? fact(input.depositReference) : null,
      },
    });

    return ok({
      id: session.id,
      schoolId: session.schoolId,
      businessDate: LocalDate.toISO(session.businessDate),
      status: 'verified',
    });
  });
}
