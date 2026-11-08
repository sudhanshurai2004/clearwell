import express, { type Express, type Request, type Response } from "express";
import pinoHttp from "pino-http";
import type { Pool } from "pg";
import { asyncHandler } from "./modules/common/async-handler";
import { correlationId } from "./modules/common/correlation";
import { errorHandler, notFoundHandler } from "./modules/common/error-handler";
import type { Logger } from "./modules/common/logger";
import { createLedgerRouter } from "./modules/ledger/ledger.routes";
import { createMerchantRouter } from "./modules/merchant/merchant.routes";
import { createPaymentRouter } from "./modules/payment/payment.routes";
import type { PspClient } from "./modules/payment/psp/psp-client";

export type AppDeps = {
  readonly logger: Logger;
  readonly pool: Pool;
  readonly apiKeyHashSecret: string;
  readonly nodeEnv?: "development" | "test" | "production";
  /** Provider adapter. Tests inject a fake; production uses HttpPspClient. */
  readonly pspClient: PspClient;
};

/**
 * Builds the Express app. Dependencies are passed in (constructor-style DI):
 * tests can inject a fake pool or a silent logger without touching globals.
 */
export function createApp(deps: AppDeps): Express {
  const { logger, pool } = deps;
  const app = express();
  app.set("nodeEnv", deps.nodeEnv ?? "development");
  // Available to middleware (e.g. idempotency) without threading it through
  // every signature. Same instance the routes use.
  app.set("pool", pool);

  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).correlationId,
      customLogLevel: (_req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      autoLogging: {
        ignore: (req) => req.url === "/healthz",
      },
    }),
  );

  app.use(correlationId);
  app.use(express.json({ limit: "100kb" }));

  // Liveness: is the process up? No dependency checks.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  // Readiness: can we actually serve? Checks the database round-trip.
  app.get(
    "/readyz",
    asyncHandler(async (_req, res) => {
      await pool.query("SELECT 1");
      res.status(200).json({ status: "ready" });
    }),
  );

  const routerDeps = {
    pool,
    logger,
    apiKeyHashSecret: deps.apiKeyHashSecret,
    pspClient: deps.pspClient,
  };
  app.use("/v1", createMerchantRouter(routerDeps));
  app.use("/v1", createLedgerRouter(routerDeps));
  app.use("/v1", createPaymentRouter(routerDeps));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
