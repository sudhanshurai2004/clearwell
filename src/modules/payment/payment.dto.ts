import { z } from "zod";
import { CurrencySchema, MinorUnitsSchema } from "../common/money";
import type { PaymentStatus } from "./payment-state";

/** No card data, ever. Omitting it is a design decision, not an oversight. */
export const CreatePaymentSchema = z.object({
  amount_minor: MinorUnitsSchema,
  currency: CurrencySchema,
  description: z.string().trim().max(200).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  /** Simulator hint: force a specific provider behaviour for demos/tests. */
  simulate: z
    .enum(["approve", "decline", "timeout", "latency"])
    .optional(),
});
export type CreatePaymentDto = z.infer<typeof CreatePaymentSchema>;

export const CaptureSchema = z.object({
  /** Omitted = capture the full authorised amount. */
  amount_minor: MinorUnitsSchema.optional(),
});
export type CaptureDto = z.infer<typeof CaptureSchema>;

export const RefundSchema = z.object({
  amount_minor: MinorUnitsSchema,
  reason: z.string().trim().max(200).optional(),
});
export type RefundDto = z.infer<typeof RefundSchema>;

export const VoidSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});
export type VoidDto = z.infer<typeof VoidSchema>;

/** Payments are always serialised the same way: money as strings. */
export type PaymentResponse = {
  readonly id: string;
  readonly status: PaymentStatus;
  readonly amount_minor: string;
  readonly authorized_amount_minor: string;
  readonly captured_amount_minor: string;
  readonly refunded_amount_minor: string;
  readonly currency: string;
  readonly psp_reference: string;
  readonly psp_ref: string | null;
  readonly decline_code: string | null;
  readonly description: string | null;
  readonly metadata: Record<string, string>;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type PaymentEventResponse = {
  readonly id: string;
  readonly event_type: string;
  readonly from_status: string | null;
  readonly to_status: string | null;
  readonly detail: Record<string, unknown>;
  readonly created_at: string;
};
