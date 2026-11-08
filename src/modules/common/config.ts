import dotenv from "dotenv";
import { z } from "zod";

// Load environment variables from .env file
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default("postgres://clearwell:clearwell_dev_password@localhost:5432/clearwell"),
  API_KEY_HASH_SECRET: z.string().default("change-me-in-production"),
  JWT_SECRET: z.string().default("change-me-in-production"),
  PSP_CALLBACK_SECRET: z.string().default("change-me-in-production"),
  WEBHOOK_SIGNING_SECRET: z.string().default("change-me-in-production"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:", JSON.stringify(parsed.error.format(), null, 2));
  throw new Error("Invalid environment configuration");
}

export const config = parsed.data;
export type Config = z.infer<typeof envSchema>;
