import { Router } from "express";
import type { Pool } from "pg";
import type { Logger } from "../common/logger";
import { apiKeyAuth, requireScope } from "../merchant/auth.middleware";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import type { PspClient } from "./psp/psp-client";

export function createPaymentRouter(deps: {
  pool: Pool;
  logger: Logger;
  apiKeyHashSecret: string;
  pspClient: PspClient;
}): Router {
  const router = Router();
  const service = new PaymentService(deps.pool, deps.pspClient, deps.logger);
  const controller = new PaymentController(service);
  const auth = apiKeyAuth({
    pool: deps.pool,
    logger: deps.logger,
    apiKeyHashSecret: deps.apiKeyHashSecret,
  });

  router.post("/payments", auth, requireScope("payments:write"), controller.create());
  router.get("/payments", auth, requireScope("payments:read"), controller.list());
  router.get("/payments/:paymentId", auth, requireScope("payments:read"), controller.get());
  router.get("/payments/:paymentId/events", auth, requireScope("payments:read"), controller.events());

  router.post("/payments/:paymentId/capture", auth, requireScope("payments:write"), controller.capture());
  router.post("/payments/:paymentId/void", auth, requireScope("payments:write"), controller.void());
  router.post("/payments/:paymentId/refunds", auth, requireScope("refunds:write"), controller.refund());

  return router;
}
