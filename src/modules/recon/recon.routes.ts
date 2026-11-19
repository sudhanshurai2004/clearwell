import { Router } from "express";
import { z } from "zod";
import { reconciliationService } from "./recon.service";
import { pool } from "../common/db";
import { authenticateApiKey } from "../merchant/middleware/authenticateApiKey";

const compareSchema = z.object({
  internalPayments: z.array(
    z.object({
      paymentId: z.string().uuid(),
      amount: z.string().min(1),
      currency: z.string().min(3).max(3),
      status: z.string().min(1),
    })
  ),
  settlementCsv: z.string().min(1),
});

export const reconRouter = Router();

reconRouter.use(authenticateApiKey);

reconRouter.post("/compare", async (req, res, next) => {
  try {
    const parsed = compareSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: "INVALID_RECON_REQUEST",
        message: parsed.error.issues[0]?.message ?? "Invalid reconciliation request",
      });
      return;
    }

    const mismatches = reconciliationService.compareSettlement(
      parsed.data.internalPayments,
      parsed.data.settlementCsv
    );

    const runResult = await pool.query(
      `INSERT INTO reconciliation_runs (status, source_type, mismatch_count, started_at, completed_at)
       VALUES ('COMPLETED','SETTLEMENT_CSV',$1,NOW(),NOW())
       RETURNING id, status, mismatch_count, created_at`,
      [mismatches.length]
    );
    const run = runResult.rows[0];

    for (const mismatch of mismatches) {
      const paymentId =
        mismatch.ourPaymentId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(mismatch.ourPaymentId)
          ? mismatch.ourPaymentId
          : null;
      await pool.query(
        `INSERT INTO reconciliation_mismatches
         (run_id,mismatch_type,our_payment_id,psp_ref,expected_amount,actual_amount,expected_status,actual_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          run.id,
          mismatch.type,
          paymentId,
          mismatch.pspRef ?? null,
          mismatch.expectedAmount ? BigInt(mismatch.expectedAmount) : null,
          mismatch.actualAmount ? BigInt(mismatch.actualAmount) : null,
          mismatch.expectedStatus ?? null,
          mismatch.actualStatus ?? null,
        ]
      );
    }

    res.status(200).json({
      runId: run.id,
      totalMismatches: mismatches.length,
      mismatches,
    });
  } catch (error) {
    next(error);
  }
});
