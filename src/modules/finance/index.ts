/**
 * The finance module's only importable surface (ADR-0001).
 *
 * §13.1 (fee definition), §13.6 (invoice generation), §13.3/§13.4 (payment
 * recording and receipt issuance) and now payment reversal all have real use
 * cases. Collection sessions are still ahead.
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

export { fiscalYearOf } from './domain/rules/fiscalYear';

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

export { listOutstanding, type OutstandingLineView } from './application/listOutstanding';

export {
  recordPayment,
  PaymentErrors,
  type RecordPaymentInput,
  type PaymentView,
  type PaymentAllocationView,
} from './application/recordPayment';

export {
  reversePayment,
  ReversalErrors,
  type ReversePaymentInput,
} from './application/reversePayment';

export {
  CreateFeeHeadSchema,
  CreateFeeStructureSchema,
  CreateFeeAssignmentSchema,
  CreateDiscountSchema,
  ApproveDiscountSchema,
  GenerateInvoicesSchema,
  RecordPaymentSchema,
  ReversePaymentSchema,
} from './application/dto';
