/**
 * The finance module's only importable surface (ADR-0001).
 *
 * §13.1 (fee definition) has its first use cases now: fee heads and fee
 * structures. Invoice generation, payment recording and receipt issuance are
 * still ahead — each is its own increment, for the reasons in this module's
 * PRs: real concurrency and idempotency concerns that deserve their own
 * build-then-verify-by-breaking pass rather than landing bundled together.
 */

export {
  allocatePayment,
  type AllocationPolicy,
  type OutstandingLine,
  type Allocation,
  type AllocationVerdict,
} from './domain/rules/allocate';

export {
  createFeeHead,
  listFeeHeads,
  FeeHeadErrors,
  type CreateFeeHeadInput,
  type FeeHeadRow,
} from './application/feeHeads';

export {
  createFeeStructure,
  listFeeStructures,
  FeeStructureErrors,
  type CreateFeeStructureInput,
  type FeeStructureRow,
} from './application/feeStructures';

export { CreateFeeHeadSchema, CreateFeeStructureSchema } from './application/dto';
