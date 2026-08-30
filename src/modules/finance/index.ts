/**
 * The finance module's only importable surface.
 *
 * Fee heads, fee structures, invoice generation, payments and reversal.
 * §13 — first slice: the core loop, not the full ten-table phase.
 */

export {
  createFeeHead,
  listFeeHeads,
  FeeHeadErrors,
  type CreateFeeHeadInput,
} from './application/feeHeads';

export {
  createFeeStructure,
  listFeeStructures,
  FeeStructureErrors,
  type CreateFeeStructureInput,
} from './application/feeStructures';

export {
  generateInvoices,
  getOutstanding,
  type GenerateInvoicesInput,
  type GenerateInvoicesResult,
} from './application/invoices';

export {
  recordPayment,
  reversePayment,
  PaymentErrors,
  type RecordPaymentInput,
  type RecordPaymentAllocationInput,
  type RecordPaymentResult,
  type ReversePaymentResult,
} from './application/payments';

export {
  CreateFeeHeadSchema,
  CreateFeeStructureSchema,
  GenerateInvoicesSchema,
  RecordPaymentSchema,
  ReversePaymentSchema,
} from './application/dto';

export {
  allocatePayment,
  AllocationErrors,
  type AllocationPolicy,
  type AllocationRequest,
  type Allocation,
  type OutstandingLine,
} from './domain/allocate';

export type { FeeHeadRow, FeeStructureRow, InvoiceRow, OutstandingRow } from './infrastructure/repositories';
