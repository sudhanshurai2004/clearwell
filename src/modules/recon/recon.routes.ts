import { Router } from "express";
import { z } from "zod";
import { reconciliationService } from "./recon.service";

const compareSchema = z.object({
  internalPayments: z.array(
    z.object({
      paymentId: z.string().min(1),
      amount: z.string().min(1),
      currency: z.string().min(3).max(3),
      status: z.string().min(1),
    })
  ),
  settlementCsv: z.string().min(1),
});

export const reconRouter = Router();

reconRouter.post("/compare", (req, res) => {
  const parsed = compareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      code: "INVALID_RECON_REQUEST",
      message: parsed.error.issues[0]?.message ?? "Invalid reconciliation request",
    });
  }

  const mismatches = reconciliationService.compareSettlement(
    parsed.data.internalPayments,
    parsed.data.settlementCsv
  );

  return res.status(200).json({
    totalMismatches: mismatches.length,
    mismatches,
  });
});
