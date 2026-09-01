/**
 * The finance module's only importable surface (ADR-0001).
 *
 * §13.1 (fee definition), §13.6 (invoice generation), §13.3/§13.4 (payment
 * recording, receipt issuance, reversal) and now collection sessions all
 * have real use cases. §13's own schema is now fully wired up.
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
  openCollectionSession,
  closeCollectionSession,
  verifyCollectionSession,
  CollectionSessionErrors,
  type CloseCollectionSessionInput,
  type VerifyCollectionSessionInput,
  type CollectionSessionView,
} from './application/collectionSessions';

export {
  CreateFeeHeadSchema,
  CreateFeeStructureSchema,
  CreateFeeAssignmentSchema,
  CreateDiscountSchema,
  ApproveDiscountSchema,
  GenerateInvoicesSchema,
  RecordPaymentSchema,
  ReversePaymentSchema,
  OpenCollectionSessionSchema,
  CloseCollectionSessionSchema,
  VerifyCollectionSessionSchema,
} from './application/dto';
