/**
 * Readiness. §35.3 step (d) waits on this before shifting traffic.
 *
 * Liveness and readiness answer different questions, and conflating them is how
 * a rolling deploy takes the site down: a container that is ALIVE but not READY
 * must keep running and receive no traffic, whereas one that is not alive must
 * be restarted. A readiness probe that only checks the process is up would let
 * Caddy shift traffic to a replica that cannot reach the database.
 */

import { appPoolFor } from '../../../db/pool';

export interface Readiness {
  ready: boolean;
  database: 'ok' | 'unreachable' | 'unmigrated';
  migrations: number;
  latencyMs: number;
}

/**
 * Checks the database as the APP role.
 *
 * Not the migrator: the question is whether the role serving requests can
 * connect, and a check that passes as a different user proves nothing about
 * the one that matters.
 */
export async function checkReadiness(): Promise<Readiness> {
  const started = Date.now();

  try {
    const pool = appPoolFor();
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM schema_migration',
    );
    const migrations = Number(rows[0]?.n ?? '0');
    const latencyMs = Date.now() - started;

    /*
     * Zero migrations means a database that exists but is empty — a fresh
     * volume, or a deploy that started before migrations ran. Serving traffic
     * then produces a stream of "relation does not exist" errors that look
     * like an application bug.
     */
    if (migrations === 0) {
      return { ready: false, database: 'unmigrated', migrations, latencyMs };
    }

    return { ready: true, database: 'ok', migrations, latencyMs };
  } catch {
    // The reason is deliberately not returned to the caller: a probe endpoint
    // is reachable from the internet and a connection error string names the
    // host, the port and the role.
    return {
      ready: false,
      database: 'unreachable',
      migrations: 0,
      latencyMs: Date.now() - started,
    };
  }
}
