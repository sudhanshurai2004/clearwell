import { z } from "zod";

export const Direction = {
  DEBIT: "DEBIT",
  CREDIT: "CREDIT",
} as const;
export type Direction = (typeof Direction)[keyof typeof Direction];

export const LedgerTransactionKind = {
  CAPTURE: "CAPTURE",
  REFUND: "REFUND",
  PAYOUT: "PAYOUT",
  FEE_ADJUSTMENT: "FEE_ADJUSTMENT",
} as const;
export type LedgerTransactionKind =
  (typeof LedgerTransactionKind)[keyof typeof LedgerTransactionKind];

export const AccountType = {
  ASSET: "ASSET",
  LIABILITY: "LIABILITY",
  REVENUE: "REVENUE",
  EXPENSE: "EXPENSE",
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];

/** Chart-of-accounts codes used by the engine. */
export const AccountCode = {
  /** Money sitting at the provider. Global, one per currency. */
  PSP_CLEARING: "PSP_CLEARING",
  /** What we owe merchants. One per merchant per currency. */
  MERCHANT_PAYABLE: "MERCHANT_PAYABLE",
  /** Platform fee income. Global, one per currency. */
  FEE_REVENUE: "FEE_REVENUE",
} as const;
export type AccountCode = (typeof AccountCode)[keyof typeof AccountCode];

/** A single line of a journal entry. Amounts are always positive; direction carries sign. */
export type PostingLine = {
  readonly accountId: string;
  readonly direction: Direction;
  readonly amount: bigint;
};

export type PostingRequest = {
  readonly kind: LedgerTransactionKind;
  readonly merchantId: string;
  readonly paymentId?: string;
  readonly payoutId?: string;
  /** 1 for capture / first refund, 2 for the second refund, ... */
  readonly sequence: number;
  readonly currency: string;
  /** Gross amount of the business event; the entries must sum to this per side. */
  readonly amount: bigint;
  readonly description: string;
  readonly correlationId?: string;
  readonly lines: readonly PostingLine[];
};

export type PostingResult = {
  readonly transactionId: string;
  /** False when this exact (payment_id, kind, sequence) was already posted. */
  readonly posted: boolean;
};

export type LedgerEntryView = {
  readonly id: string;
  readonly transaction_id: string;
  readonly account_id: string;
  readonly direction: Direction;
  readonly amount_minor: string;
  readonly currency: string;
  readonly created_at: string;
  readonly kind: LedgerTransactionKind;
  readonly description: string;
  readonly payment_id: string | null;
  readonly payout_id: string | null;
};

export type AccountView = {
  readonly id: string;
  readonly code: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly is_system: boolean;
  readonly balance_minor: string;
};

export const LedgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().regex(/^\d+$/).optional(),
  direction: z.enum(["DEBIT", "CREDIT"]).optional(),
});
export type LedgerQueryDto = z.infer<typeof LedgerQuerySchema>;
