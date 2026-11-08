import pino from "pino";

/**
 * Structured JSON logs. In development we pipe through pino-pretty for humans
 * (that is a formatting concern only -- the underlying records are still JSON).
 *
 * redact removes secret-ish fields before they are ever serialised. This is the
 * "log redaction" requirement: API keys, passwords, card data and bearer
 * tokens must never reach disk, even by accident.
 */
export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["idempotency-key"]',
        'req.headers["x-clearwell-signature"]',
        "res.headers",
        "*.apiKey",
        "*.api_key",
        "*.password",
        "*.secret",
        "*.token",
        "*.card_number",
        "*.cardNumber",
        "*.cvv",
      ],
      censor: "[REDACTED]",
    },
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss.l" } } }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
