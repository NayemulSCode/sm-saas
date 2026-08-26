/**
 * The audit trail. Non-negotiable 4 — every mutation is audited with actor,
 * tenant, timestamp, before/after and reason.
 *
 * Two entry points, because there are two trails (ADR-0033):
 *
 *   audit()            tenant-scoped mutations → audit_log. Needs a tenant
 *                      session, so it is only callable inside withTenant.
 *   recordAuthEvent()  authentication → auth_event. Global, because the login
 *                      path has no tenant yet.
 *
 * REDACTION IS NOT OPTIONAL
 *
 * Invariant 12 says before/after hold ids and changed field names, NOT values.
 * That is enforced here rather than trusted to callers: `redact()` keeps a
 * value only if it is an id or a boolean, and replaces everything else with a
 * marker. A caller passing a whole `person` row therefore records that `phone`
 * changed without recording the number.
 *
 * It fails SAFE. A field added to a table next year is redacted by default,
 * because it will not look like an id — nobody has to remember to add it to a
 * blocklist.
 */

import { createHash } from 'node:crypto';
import type { Tx } from './rls';
import { authEvent, auditLog } from './schema/audit';
import { Ids } from '../shared/ids';
import type { AuthContext } from '../shared/auth-context';

/** What a redacted value looks like in the stored JSON. */
export const REDACTED = '[redacted]';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Loose on purpose — PostgreSQL validates `inet`; this only rejects junk. */
const IPISH = /^[0-9a-fA-F.:]+$/;

function isIdLike(value: string): boolean {
  return ULID.test(value) || UUID.test(value);
}

/**
 * One value, redacted. Ids and booleans survive; everything else does not.
 *
 * Numbers and dates are redacted too. A mark, an amount and a date of birth
 * are all "just a number", and the audit does not need them — the ledger and
 * the row itself hold the values. Knowing the field changed is the point.
 */
export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && isIdLike(value)) return value;
  return REDACTED;
}

export function redact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) out[key] = redactValue(value);
  return out;
}

/** Stable enough to compare two column values for equality. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return Object.is(a, b);
}

/**
 * The keys whose values actually differ.
 *
 * Computed on the RAW objects and only then redacted — which is the whole
 * reason `audit()` takes real rows rather than pre-redacted ones. Redacted
 * values all compare equal, so a diff taken afterwards would find nothing.
 */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => !sameValue(before[k], after[k])).sort();
}

/**
 * Actions that may not be recorded without a reason.
 *
 * Anything destructive or reversing. The list is short because it only holds
 * what exists today; adding an action here is how a new dangerous operation
 * gets the same treatment. §9.1's `is_dangerous` permissions map onto these as
 * their modules ship.
 */
export const REASON_REQUIRED: ReadonlySet<string> = new Set([
  'invite.revoked',
  'membership.revoked',
  'role.granted',
  'role.revoked',
  'student.merged',
  'fee.waived',
  'fee.refunded',
  'result.published',
  'result.revised',
  'academicYear.closed',
]);

export interface AuditEntry {
  /** Defaults to the action's first segment: `invite.revoked` → `invite`. */
  entityType?: string | undefined;
  before?: Record<string, unknown> | undefined;
  after?: Record<string, unknown> | undefined;
  reason?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Records a tenant-scoped mutation.
 *
 * Must be called INSIDE the same `withTenant` transaction as the change it
 * describes. That is not a style preference: the tenant session variable is
 * transaction-local, so an audit row written outside it is refused by RLS —
 * and a row written in a separate transaction could commit while the mutation
 * rolls back, or the reverse.
 */
export async function audit(
  tx: Tx,
  ctx: AuthContext,
  action: string,
  entityId: string,
  entry: AuditEntry = {},
): Promise<void> {
  return auditAs(
    tx,
    {
      tenantId: ctx.activeTenantId,
      actorPersonId: ctx.personId,
      actorAccountId: ctx.accountId,
      requestId: ctx.requestId,
      impersonatedBy: ctx.impersonation?.operatorId,
    },
    action,
    entityId,
    entry,
  );
}

/**
 * The actor as the audit table sees them.
 *
 * `actorPersonId` is optional because a platform OPERATOR has no person row in
 * the tenant they are acting on — provisioning creates the school before anyone
 * belongs to it. `actorAccountId` still identifies them.
 */
export interface AuditActor {
  tenantId: string;
  actorPersonId?: string | undefined;
  actorAccountId?: string | undefined;
  requestId: string;
  impersonatedBy?: string | undefined;
}

/**
 * The form that does not require an AuthContext — for provisioning and other
 * operator work, where the tenant exists but nobody is a member of it yet.
 */
export async function auditAs(
  tx: Tx,
  actor: AuditActor,
  action: string,
  entityId: string,
  entry: AuditEntry = {},
): Promise<void> {
  if (REASON_REQUIRED.has(action) && !entry.reason?.trim()) {
    throw new Error(`audit: "${action}" may not be recorded without a reason`);
  }

  const { before, after } = entry;
  let storedBefore: Record<string, unknown> | null = null;
  let storedAfter: Record<string, unknown> | null = null;

  if (before && after) {
    // Only the fields that moved. The key set IS the changed-field list.
    const changed = changedFields(before, after);
    storedBefore = redact(Object.fromEntries(changed.map((k) => [k, before[k]])));
    storedAfter = redact(Object.fromEntries(changed.map((k) => [k, after[k]])));
  } else if (after) {
    storedAfter = redact(after);
  } else if (before) {
    storedBefore = redact(before);
  }

  await tx.insert(auditLog).values({
    id: Ids.generate<'auditLog'>(),
    tenantId: actor.tenantId as never,
    actorPersonId: (actor.actorPersonId ?? null) as never,
    actorAccountId: (actor.actorAccountId ?? null) as never,
    entityType: entry.entityType ?? (action.split('.')[0] || action),
    entityId: entityId as never,
    action,
    before: storedBefore,
    after: storedAfter,
    reason: entry.reason ?? null,
    requestId: actor.requestId,
    impersonatedBy: (actor.impersonatedBy ?? null) as never,
    ip: normaliseIp(entry.ip),
    userAgent: entry.userAgent ?? null,
  });
}

export interface AuthEventEntry {
  /** otp.requested · password.attempted · session.created · … */
  type: string;
  outcome: 'success' | 'failure';
  accountId?: string | undefined;
  credentialId?: string | undefined;
  sessionId?: string | undefined;
  /** The raw phone or email. HASHED here — never stored in the clear. */
  identifier?: string | undefined;
  reason?: string | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  /** Ids and flags only, same rule as before/after. Redacted on the way in. */
  detail?: Record<string, unknown> | undefined;
}

/**
 * The transport facts an auth event needs, carried through the use cases.
 *
 * Optional everywhere: a worker or a test has no request behind it, and an
 * event with no IP is still worth recording.
 */
export interface RequestMeta {
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Records an authentication event.
 *
 * Callable from a platform transaction, because it has to be: at login time
 * there is no tenant, and `auth_event` carries no tenant_id for exactly that
 * reason.
 */
export async function recordAuthEvent(tx: Tx, e: AuthEventEntry): Promise<void> {
  await tx.insert(authEvent).values({
    id: Ids.generate<'authEvent'>(),
    type: e.type,
    outcome: e.outcome,
    accountId: (e.accountId ?? null) as never,
    credentialId: (e.credentialId ?? null) as never,
    sessionId: (e.sessionId ?? null) as never,
    identifierHash: e.identifier ? hashIdentifier(e.identifier) : null,
    reason: e.reason ?? null,
    // An event with no request behind it is a worker or a test, not a user.
    requestId: e.requestId ?? 'system',
    ip: normaliseIp(e.ip),
    userAgent: e.userAgent ?? null,
    detail: e.detail ? redact(e.detail) : {},
  });
}

/**
 * Correlates repeated attempts on one identifier without storing the number.
 *
 * Unsalted, deliberately: a salt would make two attempts on the same phone
 * hash differently, which destroys the only property this column exists for.
 * The input space is small enough to brute-force, so this is not a
 * confidentiality control — it is there so that a support engineer reading the
 * table does not read a list of phone numbers.
 */
export function hashIdentifier(identifier: string): Buffer {
  return createHash('sha256').update(identifier.normalize('NFC'), 'utf8').digest();
}

/** `clientIp()` yields 'unknown' behind a proxy that sent no header. */
function normaliseIp(ip: string | undefined): string | null {
  if (!ip || !IPISH.test(ip)) return null;
  return ip;
}
