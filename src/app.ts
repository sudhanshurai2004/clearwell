import express, { Express } from "express";
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

export function createApp(): Express {
  const app = express();

  // Basic middleware
  app.use(express.json());
  app.use(correlationIdMiddleware);

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

  app.get("/", (_req, res) => {
    res.type("html").status(200).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Clearwell API</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b1220; color: #e5edf8; }
      main { width: min(620px, calc(100% - 40px)); padding: 36px; border: 1px solid #26344c; border-radius: 18px; background: #121d30; box-shadow: 0 24px 80px #0005; }
      .badge { color: #77e0bd; font-size: .82rem; letter-spacing: .12em; text-transform: uppercase; }
      h1 { margin: 12px 0; font-size: clamp(2rem, 7vw, 3.2rem); }
      p { color: #aab9cf; line-height: 1.65; }
      ul { padding-left: 20px; color: #cbd7e8; line-height: 2; }
      a { color: #77e0bd; }
      code { color: #d7e4f7; background: #1d2b42; padding: 3px 7px; border-radius: 5px; }
      .note { margin-top: 24px; padding: 12px 14px; border-left: 3px solid #e8ba6a; background: #1b2636; color: #d7c9a8; font-size: .9rem; }
    </style>
  </head>
  <body>
    <main>
      <div class="badge">Service online</div>
      <h1>Clearwell API</h1>
      <p>The Clearwell payment orchestration API is running. This service is an API, not a merchant dashboard.</p>
      <ul>
        <li>API status: <a href="/health"><code>View status</code></a></li>
        <li>Health JSON: <a href="/health?format=json"><code>GET /health?format=json</code></a></li>
        <li>Merchant onboarding: <code>POST /v1/merchants</code></li>
        <li>Payments: <code>/v1/payments</code></li>
        <li>Accounts and ledger: <code>/v1/accounts</code></li>
      </ul>
      <div class="note">Payments use the built-in simulated provider for development. No real money or card data is processed.</div>
    </main>
  </body>
</html>`);
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

  // 404 handler for unknown routes
  app.use((req, res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
  });

  // Central error handler
  app.use(errorHandler);

  return app;
}
