export type EntryDirection = "DEBIT" | "CREDIT";

export type ReferenceType = 
  | "PAYMENT_CAPTURE" 
  | "PAYMENT_REFUND" 
  | "MERCHANT_PAYOUT" 
  | "ADJUSTMENT";

export interface LedgerTransaction {
  id: string;
  merchantId: string | null;
  referenceId: string;
  referenceType: ReferenceType;
  description: string | null;
  postedAt: Date;
  createdAt: Date;
}

export interface LedgerEntry {
  id: string;
  transactionId: string;
  accountId: string;
  direction: EntryDirection;
  amount: bigint;
  currency: string;
  createdAt: Date;
}

export interface PostEntryInput {
  accountId: string;
  direction: EntryDirection;
  amount: bigint;
  currency: string;
}

export interface PostTransactionInput {
  merchantId: string | null;
  referenceId: string;
  referenceType: ReferenceType;
  description?: string;
  entries: PostEntryInput[];
}

export interface AccountBalance {
  accountId: string;
  accountName: string;
  accountType: "ASSET" | "LIABILITY" | "REVENUE";
  currency: string;
  balance: bigint;
}

export interface FeeCalculation {
  grossAmount: bigint;
  feeAmount: bigint;
  netAmount: bigint;
  feeBasisPoints: number; // e.g. 200 = 2.00%
}
