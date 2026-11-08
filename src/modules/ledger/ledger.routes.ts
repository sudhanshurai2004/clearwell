import { Router } from "express";
import type { Pool } from "pg";
import type { Logger } from "../common/logger";
import { apiKeyAuth, requireScope } from "../merchant/auth.middleware";
import { LedgerController } from "./ledger.controller";
import { LedgerService } from "./ledger.service";

export function createLedgerRouter(deps: { pool: Pool; logger: Logger; apiKeyHashSecret: string }): Router {
  const router = Router();
  const service = new LedgerService(deps.pool);
  const controller = new LedgerController(service);
  const auth = apiKeyAuth({
    pool: deps.pool,
    logger: deps.logger,
    apiKeyHashSecret: deps.apiKeyHashSecret,
  });

  router.get("/accounts", auth, requireScope("ledger:read"), controller.listAccounts());
  router.get("/accounts/:accountId/ledger", auth, requireScope("ledger:read"), controller.getStatement());

  return router;
}
