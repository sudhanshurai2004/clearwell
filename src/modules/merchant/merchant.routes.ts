import { Router } from "express";
import type { Pool } from "pg";
import type { Logger } from "../common/logger";
import { apiKeyAuth, requireScope } from "./auth.middleware";
import { MerchantController } from "./merchant.controller";
import { MerchantService } from "./merchant.service";

export function createMerchantRouter(deps: {
  pool: Pool;
  logger: Logger;
  apiKeyHashSecret: string;
}): Router {
  const router = Router();
  const service = new MerchantService(deps.pool, deps.apiKeyHashSecret);
  const controller = new MerchantController(service);
  const auth = apiKeyAuth({
    pool: deps.pool,
    logger: deps.logger,
    apiKeyHashSecret: deps.apiKeyHashSecret,
  });

  // Bootstrap: unauthenticated by design (admin/JWT comes in a later milestone).
  // In production this is disabled behind an environment switch.
  router.post("/merchants", controller.createMerchant());

  router.get("/merchants/me", auth, controller.getMe());
  router.post("/merchants/me/api-keys", auth, requireScope("admin:keys"), controller.createApiKey());

  return router;
}
