import type { Server } from "node:http";
import { createApp } from "./app";
import { loadConfig } from "./modules/common/config";
import { createPool } from "./modules/common/db";
import { createLogger } from "./modules/common/logger";

/**
 * Process entry point: validate config -> build dependencies -> listen -> wire
 * graceful shutdown. Any failure here must crash loudly instead of serving
 * requests with a broken half-initialised state.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.nodeEnv === "development");
  const pool = createPool(config.databaseUrl, logger);
  const app = createApp({
    logger,
    pool,
    apiKeyHashSecret: config.secrets.apiKeyHash,
    nodeEnv: config.nodeEnv,
  });

  // Bind 0.0.0.0, not 127.0.0.1: containers and preview proxies must reach it.
  const server: Server = app.listen(config.port, "0.0.0.0", () => {
    logger.info({ port: config.port, env: config.nodeEnv }, "clearwell_api_started");
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutdown_started");
    // Stop accepting new connections, let in-flight requests finish, then close
    // the pool. Payments in flight must not be killed mid-transaction.
    server.close(() => {
      void pool.end().then(() => {
        logger.info("shutdown_complete");
        process.exit(0);
      });
    });
    setTimeout(() => {
      logger.error("shutdown_forced_exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
