import crypto from "crypto";
import { config } from "../common/config";

export interface GeneratedApiKey {
  rawKey: string;
  prefix: string;
  hash: string;
}

const KEY_PREFIX = "cw_live_";
const PREFIX_LENGTH = 16; // "cw_live_" (8 chars) + 8 chars of random hex

export function generateApiKey(): GeneratedApiKey {
  const randomBytes = crypto.randomBytes(24).toString("hex");
  const rawKey = `${KEY_PREFIX}${randomBytes}`;
  const prefix = rawKey.substring(0, PREFIX_LENGTH);
  const hash = hashApiKey(rawKey);

  return { rawKey, prefix, hash };
}

export function hashApiKey(key: string): string {
  return crypto
    .createHmac("sha256", config.API_KEY_HASH_SECRET)
    .update(key)
    .digest("hex");
}

export function verifyApiKey(candidateKey: string, storedHash: string): boolean {
  const candidateHash = hashApiKey(candidateKey);
  const candidateBuffer = Buffer.from(candidateHash, "hex");
  const storedBuffer = Buffer.from(storedHash, "hex");

  if (candidateBuffer.length !== storedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(candidateBuffer, storedBuffer);
}
