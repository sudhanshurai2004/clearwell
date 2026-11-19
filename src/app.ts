import express, { Express } from "express";
import path from "path";
import { pool } from "./modules/common/db";
import { correlationIdMiddleware } from "./modules/common/middleware/correlationId";
import { errorHandler } from "./modules/common/middleware/errorHandler";
import { NotFoundError } from "./modules/common/errors";
import { merchantRouter } from "./modules/merchant/merchant.routes";
import { ledgerRouter } from "./modules/ledger/ledger.routes";
import { paymentRouter } from "./modules/payment/payment.routes";
import { payoutRouter } from "./modules/payment/payout.routes";
import { riskRouter } from "./modules/risk/risk.routes";
import { reconRouter } from "./modules/recon/recon.routes";
import { outboxRouter } from "./modules/outbox/outbox.routes";
import { paymentCallbackRouter } from "./modules/payment/payment-callback.routes";
import { metricsRegistry, httpRequestCounter, httpRequestDuration } from "./modules/common/metrics";

export function createApp(): Express {
  const app = express();

  // Basic middleware
  app.use(express.json());
  app.use(correlationIdMiddleware);

  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      const route = req.route?.path ?? req.path;
      httpRequestCounter.inc({ method: req.method, route, status: String(res.statusCode) });
      httpRequestDuration.observe(
        { method: req.method, route, status: String(res.statusCode) },
        durationSeconds
      );
    });
    next();
  });

  const publicDirectory = path.join(process.cwd(), "public");
  app.use(express.static(publicDirectory));

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metricsRegistry.contentType);
    res.status(200).send(await metricsRegistry.metrics());
  });

  // Health check endpoint
  app.get("/health", (req, res) => {
    const acceptHeader = req.get("accept") ?? "";
    if (acceptHeader.includes("text/html") && req.query.format !== "json") {
      res.type("html").status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Clearwell Health</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1220; color: #e5edf8; }
      main { width: min(520px, calc(100% - 40px)); padding: 32px; border: 1px solid #26344c; border-radius: 18px; background: #121d30; }
      .status { display: flex; align-items: center; gap: 10px; color: #77e0bd; font-size: 1.15rem; font-weight: 700; }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: #77e0bd; box-shadow: 0 0 14px #77e0bd99; }
      p { color: #aab9cf; line-height: 1.6; }
      a { color: #77e0bd; }
    </style>
  </head>
  <body>
    <main>
      <div class="status"><span class="dot"></span>API is healthy</div>
      <p>Clearwell API is responding normally.</p>
      <p><a href="/">Back to Clearwell</a> · <a href="/health?format=json">View health JSON</a></p>
    </main>
  </body>
</html>`);
      return;
    }

    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
      correlation_id: req.correlationId,
    });
  });

  app.get("/ready", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.status(200).json({
        status: "ready",
        database: "connected",
        timestamp: new Date().toISOString(),
        correlation_id: req.correlationId,
      });
    } catch {
      res.status(503).json({
        status: "not_ready",
        database: "disconnected",
        timestamp: new Date().toISOString(),
        correlation_id: req.correlationId,
      });
    }
  });

  // API v1 routes
  app.use("/v1/merchants", merchantRouter);
  app.use("/v1/accounts", ledgerRouter);
  app.use("/v1/ledger", ledgerRouter);
  app.use("/v1/payments", paymentRouter);
  app.use("/v1/payouts", payoutRouter);
  app.use("/v1/risk", riskRouter);
  app.use("/v1/reconciliation", reconRouter);
  app.use("/v1/outbox", outboxRouter);
  app.use(paymentCallbackRouter);

  // 404 handler for unknown routes
  app.use((req, res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
  });

  // Central error handler
  app.use(errorHandler);

  return app;
}
