/**
 * The finance module's only importable surface (ADR-0001).
 *
 * §13.1 (fee definition) is complete: fee heads, fee structures, per-student
 * fee assignments and discounts (with their approval workflow) all have real
 * use cases now. Invoice generation is next — it is what actually reads all
 * four. Payment recording and receipt issuance are still ahead after that.
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

export {
  createFeeAssignment,
  listFeeAssignments,
  FeeAssignmentErrors,
  type CreateFeeAssignmentInput,
  type FeeAssignmentRow,
} from './application/feeAssignments';

export {
  createDiscount,
  approveDiscount,
  listDiscounts,
  DiscountErrors,
  type CreateDiscountInput,
  type ApproveDiscountInput,
  type DiscountRow,
} from './application/discounts';

export {
  CreateFeeHeadSchema,
  CreateFeeStructureSchema,
  CreateFeeAssignmentSchema,
  CreateDiscountSchema,
  ApproveDiscountSchema,
} from './application/dto';
