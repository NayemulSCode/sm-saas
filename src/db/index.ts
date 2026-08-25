/**
 * The database module's public surface.
 *
 * `withTenant` is exported; the pools are NOT. That is the mechanical reason
 * invariant 1 holds — there is no other handle to reach for, and a lint rule
 * blocks importing `db/pool` from anywhere outside `src/db/**` (§6.5).
 */

export {
  withTenant,
  withTenantReadonly,
  withPlatform,
  TenantSuspendedError,
  type Db,
  type Tx,
  type WithTenantOptions,
} from './rls.js';

/** Process lifecycle only — called by an entrypoint on shutdown. */
export { closeAllPools } from './pool.js';
