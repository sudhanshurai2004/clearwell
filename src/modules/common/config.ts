import "dotenv/config";
import { z } from "zod";

/**
 * Configuration is validated once, at startup, and then treated as immutable.
 * If something is missing or malformed the process refuses to boot -- a payment
 * service must never start half-configured and fail later mid-request.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://clearwell:clearwell_dev_password@localhost:5432/clearwell"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  API_KEY_HASH_SECRET: z.string().min(1, "API_KEY_HASH_SECRET is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  PSP_CALLBACK_SECRET: z.string().min(1, "PSP_CALLBACK_SECRET is required"),
  WEBHOOK_SIGNING_SECRET: z.string().min(1, "WEBHOOK_SIGNING_SECRET is required"),
});

export type AppConfig = {
  readonly nodeEnv: "development" | "test" | "production";
  readonly port: number;
  readonly databaseUrl: string;
  readonly logLevel: string;
  readonly secrets: {
    readonly apiKeyHash: string;
    readonly jwt: string;
    readonly pspCallback: string;
    readonly webhookSigning: string;
  };
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  const e = parsed.data;
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    logLevel: e.LOG_LEVEL,
    secrets: {
      apiKeyHash: e.API_KEY_HASH_SECRET,
      jwt: e.JWT_SECRET,
      pspCallback: e.PSP_CALLBACK_SECRET,
      webhookSigning: e.WEBHOOK_SIGNING_SECRET,
    },
  };
}
