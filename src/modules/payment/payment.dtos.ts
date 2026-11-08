import { z } from "zod";

export const createPaymentSchema = z.object({
  amount: z.coerce.string().refine((val) => {
    try {
      const b = BigInt(val);
      return b > 0n;
    } catch {
      return false;
    }
  }, "Amount must be a positive integer in minor units"),
  currency: z.string().length(3, "Currency must be a 3-letter ISO code").transform((c) => c.toUpperCase()),
  payment_method: z.object({
    card_number: z.string().min(12).max(19),
    expiry_month: z.number().int().min(1).max(12),
    expiry_year: z.number().int().min(2024).max(2099),
    cvv: z.string().min(3).max(4),
    cardholder_name: z.string().optional(),
  }),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

export const capturePaymentSchema = z.object({
  amount: z.coerce.string().optional().refine((val) => {
    if (val === undefined) return true;
    try {
      const b = BigInt(val);
      return b > 0n;
    } catch {
      return false;
    }
  }, "Capture amount must be a positive integer in minor units"),
});

export type CapturePaymentInput = z.infer<typeof capturePaymentSchema>;

export const refundPaymentSchema = z.object({
  amount: z.coerce.string().refine((val) => {
    try {
      const b = BigInt(val);
      return b > 0n;
    } catch {
      return false;
    }
  }, "Refund amount must be a positive integer in minor units"),
  reason: z.string().optional(),
});

export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;

export interface PaymentResponseDto {
  id: string;
  merchant_id: string;
  amount: string;
  currency: string;
  status: string;
  authorized_amount: string;
  captured_amount: string;
  refunded_amount: string;
  psp_ref: string | null;
  created_at: string;
  updated_at: string;
}
