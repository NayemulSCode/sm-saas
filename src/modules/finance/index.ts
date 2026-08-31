/**
 * The finance module's only importable surface (ADR-0001).
 *
 * §13.1 (fee definition) is complete: fee heads, fee structures, per-student
 * fee assignments and discounts (with their approval workflow) all have real
 * use cases. §13.6 (invoice generation) reads all four now. Payment recording
 * and receipt issuance are still ahead.
 */

export {
  allocatePayment,
  type AllocationPolicy,
  type OutstandingLine,
  type Allocation,
  type AllocationVerdict,
} from './domain/rules/allocate';

export {
  priceStudentFees,
  type StructureLine,
  type AssignmentOverride,
  type ApplicableDiscount,
  type PricedHead,
} from './domain/rules/price';

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
  generateInvoices,
  InvoiceGenerationErrors,
  type GenerateInvoicesInput,
  type GenerateInvoicesResult,
} from './application/generateInvoices';

export {
  CreateFeeHeadSchema,
  CreateFeeStructureSchema,
  CreateFeeAssignmentSchema,
  CreateDiscountSchema,
  ApproveDiscountSchema,
  GenerateInvoicesSchema,
} from './application/dto';
