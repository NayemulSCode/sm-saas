/**
 * The finance module's only importable surface (ADR-0001).
 *
 * Domain only, for now. §13's schema (migration 0014) ships ahead of any
 * repository or use case — see `db/schema/finance.ts` and
 * `db/schema/finance.integration.test.ts` — the same order Phase 3a shipped
 * tenancy and RLS before the first tenant table.
 */

export {
  allocatePayment,
  type AllocationPolicy,
  type OutstandingLine,
  type Allocation,
  type AllocationVerdict,
} from './domain/rules/allocate';
