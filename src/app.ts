import express, { Express } from "express";
import { correlationIdMiddleware } from "./modules/common/middleware/correlationId";
import { errorHandler } from "./modules/common/middleware/errorHandler";
import { NotFoundError } from "./modules/common/errors";
import { merchantRouter } from "./modules/merchant/merchant.routes";
import { ledgerRouter } from "./modules/ledger/ledger.routes";

export function createApp(): Express {
  const app = express();

  // Basic middleware
  app.use(express.json());
  app.use(correlationIdMiddleware);

  // Health check endpoint
  app.get("/health", (req, res) => {
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      correlation_id: req.correlationId,
    });
  });

  // API v1 routes
  app.use("/v1/merchants", merchantRouter);
  app.use("/v1/accounts", ledgerRouter);
  app.use("/v1/ledger", ledgerRouter);

  // 404 handler for unknown routes
  app.use((req, res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
  });

  // Central error handler
  app.use(errorHandler);

  return app;
}
