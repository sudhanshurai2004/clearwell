import { Router } from "express";
import { z } from "zod";
import { riskService } from "./risk.service";
import { pool } from "../common/db";
import { authenticateApiKey } from "../merchant/middleware/authenticateApiKey";

const riskInputSchema = z.object({
  paymentId: z.string().uuid(),
  amount: z.coerce.bigint(),
  currency: z.string().min(3).max(3),
  recentAuthorizationCount: z.number().int().nonnegative().optional(),
  maxAmount: z.coerce.bigint().optional(),
  velocityLimit: z.number().int().min(1).optional(),
});

export const riskRouter = Router();

riskRouter.use(authenticateApiKey);

riskRouter.post("/evaluate", async (req, res, next) => {
  try {
    const parsed = riskInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: "INVALID_RISK_REQUEST",
        message: parsed.error.issues[0]?.message ?? "Invalid risk request",
      });
      return;
    }

    const recentAuthorizationCount = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM payments
       WHERE merchant_id=$1
         AND status IN ('AUTHORIZED','CAPTURE_PENDING','CAPTURED','PARTIALLY_REFUNDED')
         AND updated_at > NOW() - INTERVAL '1 hour'`,
      [req.merchant.id]
    );

    const result = riskService.evaluate({
      merchantId: req.merchant.id,
      paymentId: parsed.data.paymentId,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      recentAuthorizationCount: recentAuthorizationCount.rows[0].count,
      maxAmount: parsed.data.maxAmount,
      velocityLimit: parsed.data.velocityLimit,
    });

    await pool.query(
      `INSERT INTO risk_decisions (merchant_id,payment_id,allowed,code,reason,amount,currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [req.merchant.id, parsed.data.paymentId, result.allowed, result.code, result.reason ?? null, parsed.data.amount, parsed.data.currency.toUpperCase()]
    );

    res.status(result.allowed ? 200 : 422).json(result);
  } catch (error) {
    next(error);
  }
});
