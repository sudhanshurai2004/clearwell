import { Router } from "express";
import type { Pool } from "pg";
import type { Logger } from "../common/logger";
import { idempotent } from "../common/idempotency";
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

  // Idempotency wraps every mutating handler. A retried create cannot charge
  // twice: the second request replays the first response instead of re-running.
  router.post("/payments", auth, requireScope("payments:write"), idempotent(controller.create()));
  router.get("/payments", auth, requireScope("payments:read"), controller.list());
  router.get("/payments/:paymentId", auth, requireScope("payments:read"), controller.get());
  router.get("/payments/:paymentId/events", auth, requireScope("payments:read"), controller.events());

  router.post(
    "/payments/:paymentId/capture",
    auth,
    requireScope("payments:write"),
    idempotent(controller.capture()),
  );
  router.post("/payments/:paymentId/void", auth, requireScope("payments:write"), idempotent(controller.void()));
  router.post(
    "/payments/:paymentId/refunds",
    auth,
    requireScope("refunds:write"),
    idempotent(controller.refund()),
  );

  return router;
}
