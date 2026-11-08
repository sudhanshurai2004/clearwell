import { loadConfig } from "../modules/common/config";
import { createLogger } from "../modules/common/logger";
import { createStandalonePsp } from "./psp-app";

/**
 * Entry point for the standalone simulator process:
 *   npm run psp        (tsx)  /  node dist/psp-simulator/index.js (built)
 * It is a SEPARATE process on purpose: a real provider is not inside our
 * application, and the network boundary is exactly where the interesting
 * failures live.
 */
const PSP_PORT = Number(process.env.PSP_PORT ?? 4000);

const config = loadConfig();
const logger = createLogger(config.logLevel, config.nodeEnv === "development");

createStandalonePsp({
  logger,
  callbackSecret: config.secrets.pspCallback,
  callbackUrl: process.env.PSP_CALLBACK_URL ?? "http://127.0.0.1:3000/v1/internal/psp/callbacks",
  port: PSP_PORT,
});
