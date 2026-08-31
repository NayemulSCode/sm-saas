/**
 * `Idempotency-Key` handling — the `idempotency_key` table's first actual
 * caller. §13.4's own transaction sketch: the INSERT happens FIRST, before
 * any of the real work, and a primary-key conflict on it means "replay the
 * original" rather than "do the work again".
 *
 * Lives in `db/`, not inside `modules/finance/`, for the same reason the
 * table itself does (PR #43): a retried request after a dropped connection
 * is a transport concern every mutating endpoint could have, not something
 * finance owns. Finance is only the first module that needed it.
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Tx } from './rls';
import { idempotencyKey } from './schema/finance';

export type IdempotencyCheck<T> =
  | { kind: 'fresh' }
  | { kind: 'replay'; status: number; body: T }
  /** Same key, a MATERIALLY DIFFERENT request body — reusing an
   *  Idempotency-Key across two different requests is a client bug, not a
   *  retry, and must not silently replay the wrong response. */
  | { kind: 'reused' };

/** Deterministic regardless of client-side key ordering — `{a:1,b:2}` and
 *  `{b:2,a:1}` must hash identically, or a client's JSON library choosing a
 *  different key order would make an honest retry look "reused". */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  return value;
}

function hashRequest(body: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(canonicalize(body)), 'utf8').digest();
}

/**
 * Must be called FIRST in the transaction, before any real work — §13.4's own
 * ordering. `tenant_id` defaults from `app.current_tenant_id()`, same as
 * every other tenant-owned insert; RLS narrows the conflict lookup to the
 * caller's own tenant automatically.
 *
 * A `fresh` result covers two different situations the caller cannot tell
 * apart, deliberately: a genuinely new key, AND a key whose earlier attempt
 * never reached `completeIdempotent` (it crashed, or returned a `DomainError`
 * before any write — see `completeIdempotent`'s own comment). Both are safe
 * to treat as "do the work" — nothing was actually committed under the first,
 * and a second real backstop, `payment.idempotency_key`'s own UNIQUE
 * constraint, stops a genuine double-write regardless.
 */
export async function beginIdempotent<T = unknown>(
  tx: Tx,
  input: { key: string; endpoint: string; requestBody: unknown; ttlHours?: number },
): Promise<IdempotencyCheck<T>> {
  const requestHash = hashRequest(input.requestBody);
  const expiresAt = new Date(Date.now() + (input.ttlHours ?? 24) * 3_600_000);

  const inserted = await tx
    .insert(idempotencyKey)
    .values({ key: input.key, endpoint: input.endpoint, requestHash, expiresAt })
    .onConflictDoNothing({ target: [idempotencyKey.tenantId, idempotencyKey.key] })
    .returning({ key: idempotencyKey.key });
  if (inserted[0]) return { kind: 'fresh' };

  const [existing] = await tx
    .select({
      requestHash: idempotencyKey.requestHash,
      responseStatus: idempotencyKey.responseStatus,
      responseBody: idempotencyKey.responseBody,
    })
    .from(idempotencyKey)
    .where(eq(idempotencyKey.key, input.key))
    .limit(1);

  if (!existing) {
    throw new Error(
      'beginIdempotent: insert conflicted but no row was found — the unique index and this query have drifted apart',
    );
  }
  if (!existing.requestHash.equals(requestHash)) return { kind: 'reused' };
  if (existing.responseStatus === null) return { kind: 'fresh' };

  return { kind: 'replay', status: existing.responseStatus, body: existing.responseBody as T };
}

/**
 * Records the response a `fresh` request produced, so a later retry can
 * replay it. Called only on SUCCESS.
 *
 * A request that returns a `DomainError` — a validation failure, a business
 * rule refused — is safe to leave unrecorded: nothing else in that
 * transaction wrote anything either (every use case in this codebase checks
 * before it mutates), so the transaction commits an idempotency_key row with
 * no response and nothing else. A retry of that same request sees
 * `responseStatus === null` above, is treated as `fresh`, and simply
 * re-evaluates against current state — which is what should happen, since
 * nothing was ever actually done the first time.
 */
export async function completeIdempotent(
  tx: Tx,
  input: { key: string; status: number; body: unknown },
): Promise<void> {
  await tx
    .update(idempotencyKey)
    .set({ responseStatus: input.status, responseBody: input.body })
    .where(eq(idempotencyKey.key, input.key));
}
