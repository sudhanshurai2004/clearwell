import { z } from "zod";

export interface Merchant {
  id: string;
  name: string;
  email: string;
  status: "ACTIVE" | "SUSPENDED";
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKey {
  id: string;
  merchantId: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  revokedAt: Date | null;
  createdAt: Date;
}

export interface Account {
  id: string;
  merchantId: string | null;
  type: "ASSET" | "LIABILITY" | "REVENUE";
  name: string;
  currency: string;
  balance: bigint;
  createdAt: Date;
  updatedAt: Date;
}

export const createMerchantSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(255),
  email: z.string().email("Invalid email address"),
  currency: z.string().length(3, "Currency must be 3-letter ISO code").default("USD").transform((c) => c.toUpperCase()),
});

export type CreateMerchantDto = z.infer<typeof createMerchantSchema>;

export interface MerchantResponseDto {
  id: string;
  name: string;
  email: string;
  status: string;
  created_at: string;
}

export interface OnboardingResponseDto {
  merchant: MerchantResponseDto;
  api_key: {
    raw_key: string;
    prefix: string;
    scopes: string[];
    warning: string;
  };
  account: {
    id: string;
    type: string;
    name: string;
    currency: string;
    balance: string;
  };
}
