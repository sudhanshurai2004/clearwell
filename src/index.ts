import { createApp } from "./app";
import { config } from "./modules/common/config";
import { closePool } from "./modules/common/db";

const app = createApp();

const server = app.listen(config.PORT, () => {
  console.log(`🚀 Clearwell API server listening on http://localhost:${config.PORT} [${config.NODE_ENV}]`);
});

const handleShutdown = async (signal: string) => {
  console.log(`\nReceived ${signal}. Gracefully shutting down Clearwell API...`);
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
