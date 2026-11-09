import { Router } from "express";
import { z } from "zod";
import { riskService } from "./risk.service";

const riskInputSchema = z.object({
  merchantId: z.string().min(1),
  paymentId: z.string().min(1),
  amount: z.coerce.bigint(),
  currency: z.string().min(3).max(3),
  recentAuthorizationCount: z.number().int().nonnegative().optional(),
  maxAmount: z.coerce.bigint().optional(),
  velocityLimit: z.number().int().min(1).optional(),
});

export const riskRouter = Router();

riskRouter.post("/evaluate", (req, res) => {
  const parsed = riskInputSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      code: "INVALID_RISK_REQUEST",
      message: parsed.error.issues[0]?.message ?? "Invalid risk request",
    });
  }

  const result = riskService.evaluate({
    merchantId: parsed.data.merchantId,
    paymentId: parsed.data.paymentId,
    amount: parsed.data.amount,
    currency: parsed.data.currency,
    recentAuthorizationCount: parsed.data.recentAuthorizationCount,
    maxAmount: parsed.data.maxAmount,
    velocityLimit: parsed.data.velocityLimit,
  });

  return res.status(result.allowed ? 200 : 422).json(result);
});
