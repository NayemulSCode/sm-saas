/**
 * withTenant — the ONLY path to the database. Invariant 1.
 *
 * `set_config(..., true)` is TRANSACTION-local: it cannot leak to the next
 * borrower of a pooled connection, and it is compatible with PgBouncer
 * transaction mode, which session-level SET is not. That keeps the pooling
 * upgrade path open without a code change (§5.4).
 *
 * If this function is bypassed, `app.current_tenant_ids()` returns an empty
 * array, every policy matches nothing, and queries return ZERO ROWS. The system
 * fails closed — a bug becomes visible and harmless rather than catastrophic.
 */

import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { appPoolFor, platformPool, readonlyPool } from './pool';
import type { AuthContext } from '../shared/auth-context';
import { Ids } from '../shared/ids';

export type Db = NodePgDatabase<Record<string, never>>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface WithTenantOptions {
  readOnly?: boolean;
  /** e.g. '5min' for a worker job; the interactive default is 15s. */
  statementTimeout?: string;
  /** Money-moving transactions wait for the replica: financial RPO 0 (§4.5). */
  synchronousCommit?: 'remote_write' | 'remote_apply';
}

export class TenantSuspendedError extends Error {
  constructor() {
    super('Tenant is read-only (suspended or past retention)');
    this.name = 'TenantSuspendedError';
  }
}

async function applySessionContext(
  tx: Tx,
  tenantIds: readonly string[],
  actorId: string | null,
  opts: WithTenantOptions | undefined,
): Promise<void> {
  const ids = tenantIds.map((t) => Ids.toUuid(t as never)).join(',');
  await tx.execute(sql`SELECT set_config('app.tenant_ids', ${ids}, true)`);
  await tx.execute(sql`SELECT set_config('app.actor_id', ${actorId ?? ''}, true)`);

  if (opts?.statementTimeout) {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${opts.statementTimeout}'`));
  }
  if (opts?.synchronousCommit) {
    await tx.execute(sql.raw(`SET LOCAL synchronous_commit = '${opts.synchronousCommit}'`));
  }
}

/**
 * Opens a transaction, sets the tenant session variables, and runs `fn`.
 * Refuses a writable transaction for a read-only context, so invariant 14
 * cannot be forgotten by an individual use case.
 */
export async function withTenant<T>(
  ctx: AuthContext,
  fn: (tx: Tx) => Promise<T>,
  opts?: WithTenantOptions,
): Promise<T> {
  if (ctx.readOnly && opts?.readOnly !== true) {
    throw new TenantSuspendedError();
  }
  const db = drizzle(appPoolFor());
  return db.transaction(async (tx) => {
    await applySessionContext(tx, ctx.tenantIds, Ids.toUuid(ctx.personId), opts);
    return fn(tx);
  });
}

/** Reporting path: replica, SELECT only, RLS still applies (ADR-0021). */
export async function withTenantReadonly<T>(
  ctx: AuthContext,
  fn: (tx: Tx) => Promise<T>,
  opts?: Omit<WithTenantOptions, 'readOnly' | 'synchronousCommit'>,
): Promise<T> {
  const db = drizzle(readonlyPool());
  return db.transaction(async (tx) => {
    await applySessionContext(tx, ctx.tenantIds, Ids.toUuid(ctx.personId), {
      ...opts,
      readOnly: true,
    });
    return fn(tx);
  });
}

/**
 * The ONE legitimate way past the wall: tenant provisioning, cross-tenant
 * operator work, and login-time context resolution — which cannot use a tenant
 * session because the tenant is what it is resolving.
 *
 * Deliberately awkward. Every caller must supply an audit reason, and callers
 * are reviewed.
 */
export async function withPlatform<T>(
  reason: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!reason || reason.trim().length < 10) {
    throw new Error('withPlatform requires a substantive audit reason');
  }
  const db = drizzle(platformPool());
  return db.transaction(fn);
}

/** Test-only: run with NO tenant context, to prove the system fails closed. */
export async function withoutTenantContext<T>(
  pool: Pool,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const db = drizzle(pool);
  return db.transaction(fn);
}
