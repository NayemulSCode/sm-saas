/**
 * Connection pools. NOT importable outside `src/db/**` — a lint rule blocks it,
 * because `withTenant(ctx, fn)` is the only path to the database (§5.4).
 *
 * The operator pool is a DIFFERENT connection string on a DIFFERENT role, so
 * `sm_platform` (the one role with BYPASSRLS) cannot be reached by accident
 * from tenant request code (§5.1).
 */

import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../config/env';

export type ShardId = string;

const pools = new Map<string, Pool>();

function makePool(connectionString: string, max: number): Pool {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'sm-saas',
  });
  pool.on('error', (e) => {
    // An idle client erroring must not take the process down.
    console.error(JSON.stringify({ level: 'error', msg: 'pg idle client error', err: e.message }));
  });
  return pool;
}

function getPool(key: string, connectionString: string): Pool {
  let pool = pools.get(key);
  if (!pool) {
    pool = makePool(connectionString, env().DB_POOL_MAX);
    pools.set(key, pool);
  }
  return pool;
}

/**
 * The tenant-facing pool, resolved by shard.
 *
 * Every tenant maps to a shard; today every row reads 'primary'. The
 * indirection exists so moving one large tenant to its own database later is an
 * operational procedure rather than a change at every call site (§7.6).
 */
export function appPoolFor(_shard: ShardId = 'primary'): Pool {
  return getPool('app:primary', env().DATABASE_URL_APP);
}

/** BYPASSRLS. Deliberately awkward: distinct credentials, every use audited. */
export function platformPool(): Pool {
  const url = env().DATABASE_URL_PLATFORM;
  if (!url) throw new Error('DATABASE_URL_PLATFORM is not configured');
  return getPool('platform', url);
}

/** SELECT only; RLS still applies. Reporting reads the replica (ADR-0021). */
export function readonlyPool(): Pool {
  const url = env().DATABASE_URL_READONLY ?? env().DATABASE_URL_APP;
  return getPool('readonly', url);
}

export const appDb = () => drizzle(appPoolFor());
export const platformDb = () => drizzle(platformPool());
export const readonlyDb = () => drizzle(readonlyPool());

export async function closeAllPools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}
