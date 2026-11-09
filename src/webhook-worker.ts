import { config } from "./modules/common/config";

console.log(`[webhook-worker] Starting worker in ${config.NODE_ENV} mode`);

setInterval(() => {
  console.log("[webhook-worker] polling outbox queue for pending webhook deliveries");
}, 30000);
