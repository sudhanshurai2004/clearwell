import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { config } from "../common/config";

export const paymentCallbackRouter = Router();

const callbackSchema = z.object({
  ourPaymentId: z.string().uuid(),
  pspReference: z.string().min(1),
  status: z.enum(["AUTHORIZED", "DECLINED", "CAPTURED", "REFUNDED", "VOIDED"]),
});

paymentCallbackRouter.post("/internal/psp/callbacks", (req, res) => {
  const signature = String(req.get("x-clearwell-signature") ?? "");
  const timestamp = String(req.get("x-clearwell-timestamp") ?? "");
  const ageSeconds = timestamp ? Math.abs(Date.now() / 1000 - Number(timestamp)) : Infinity;

  if (!timestamp || !Number.isFinite(ageSeconds) || ageSeconds > 300) {
    res.status(400).json({ code: "INVALID_CALLBACK_TIMESTAMP", message: "Callback timestamp is outside the replay window" });
    return;
  }

  const rawBody = JSON.stringify(req.body);
  const expected = crypto
    .createHmac("sha256", config.PSP_CALLBACK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    res.status(401).json({ code: "INVALID_CALLBACK_SIGNATURE", message: "Invalid PSP callback signature" });
    return;
  }

  const parsed = callbackSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: "INVALID_CALLBACK", message: "Invalid PSP callback payload" });
    return;
  }

  res.status(202).json({
    status: "QUEUED",
    ourPaymentId: parsed.data.ourPaymentId,
  });
});
