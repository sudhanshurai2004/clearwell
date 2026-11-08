import { z } from "zod";
import { PayoutStatus } from "./payment.types";
export { PayoutStatus };

export interface PayoutDestination {
  type: "BANK_ACCOUNT";
  account_number: string;
  routing_number?: string;
  account_holder_name?: string;
}

export interface Payout {
  id: string;
  merchantId: string;
  amount: bigint;
  currency: string;
  status: PayoutStatus;
  destination: PayoutDestination;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const createPayoutSchema = z.object({
  amount: z.coerce.string().refine((val) => {
    try {
      const b = BigInt(val);
      return b > 0n;
    } catch {
      return false;
    }
  }, "Payout amount must be a positive integer in minor units"),
  currency: z.string().length(3).default("USD").transform((c) => c.toUpperCase()),
  destination: z.object({
    type: z.literal("BANK_ACCOUNT").default("BANK_ACCOUNT"),
    account_number: z.string().min(4).max(34),
    routing_number: z.string().optional(),
    account_holder_name: z.string().optional(),
  }),
});

export type CreatePayoutInput = z.infer<typeof createPayoutSchema>;

export interface PayoutResponseDto {
  id: string;
  merchant_id: string;
  amount: string;
  currency: string;
  status: PayoutStatus;
  destination: PayoutDestination;
  created_at: string;
  updated_at: string;
}
