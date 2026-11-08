import { z } from "zod";

/** Scopes are a closed set. A typo must fail at validation, not silently do nothing. */
export const SCOPE_VALUES = [
  "payments:write",
  "payments:read",
  "refunds:write",
  "payouts:write",
  "ledger:read",
  "admin:keys",
] as const;

export type Scope = (typeof SCOPE_VALUES)[number];

export const ScopeSchema = z.enum(SCOPE_VALUES);

export const CreateMerchantSchema = z.object({
  name: z.string().trim().min(2).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  default_currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default("USD"),
});

export type CreateMerchantDto = z.infer<typeof CreateMerchantSchema>;

export const CreateApiKeySchema = z.object({
  label: z.string().trim().min(1).max(100).default("default"),
  scopes: z.array(ScopeSchema).min(1).max(SCOPE_VALUES.length).default([
    "payments:write",
    "payments:read",
    "ledger:read",
  ]),
});

export type CreateApiKeyDto = z.infer<typeof CreateApiKeySchema>;

/** What the API returns. Never contains the hash. */
export type MerchantResponse = {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly status: string;
  readonly default_currency: string;
  readonly created_at: string;
};

export type ApiKeyResponse = {
  readonly id: string;
  readonly key_prefix: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly created_at: string;
  /** Present only in the creation response, exactly once. */
  readonly api_key?: string;
};
