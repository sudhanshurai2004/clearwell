import { createApp } from "./app";
import { config } from "./modules/common/config";
import { closePool } from "./modules/common/db";
import { paymentService } from "./modules/payment/payment.service";

const app = createApp();

const server = app.listen(config.PORT, () => {
  console.log(`🚀 Clearwell API server listening on http://localhost:${config.PORT} [${config.NODE_ENV}]`);
});

const recoveryInterval = setInterval(() => {
  void paymentService.recoverUnknownPayments(50).catch((error) => {
    console.error("[recovery-sweeper] recovery sweep failed", error);
  });
}, config.RECOVERY_POLL_INTERVAL_MS);

const handleShutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Gracefully shutting down Clearwell API...`);
  clearInterval(recoveryInterval);
  server.close(async () => {
    try {
      await closePool();
      console.log("Database pool closed. Exiting process.");
      process.exit(0);
    } catch (err) {
      console.error("Error during database pool shutdown:", err);
      process.exit(1);
    }
  });
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
