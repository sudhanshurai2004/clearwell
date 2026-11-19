import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "payment_method.card_number",
    "cvv",
    "api_key",
    "api_key.raw_key",
  ],
});
