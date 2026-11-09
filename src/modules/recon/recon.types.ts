export type ReconciliationMismatchType =
  | "MISSING_INTERNAL"
  | "MISSING_PSP"
  | "AMOUNT_DIFF"
  | "STATUS_DIFF";

export interface SettlementRow {
  pspRef: string;
  ourPaymentId: string;
  amount: string;
  currency: string;
  status: string;
  settledAt: string;
}

export interface ReconciliationMismatch {
  type: ReconciliationMismatchType;
  ourPaymentId?: string;
  pspRef?: string;
  expectedAmount?: string;
  actualAmount?: string;
  expectedStatus?: string;
  actualStatus?: string;
  message: string;
}
