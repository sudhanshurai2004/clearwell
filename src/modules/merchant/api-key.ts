import crypto from "node:crypto";

/**
 * API KEY DESIGN
 *
 * Format:  cw_<live|test>_<8 hex>_<32 hex>
 *          └── prefix ─────────┘ └─ secret ─┘
 *
 * - Only the PREFIX is stored in clear text. It is the lookup key.
 * - The full key is hashed with HMAC-SHA256 + a server-side secret and stored
 *   in `api_keys.key_hash`. A database leak therefore does not leak usable keys.
 * - Why HMAC and not bcrypt/argon2? API keys are 128-bit random values, not
 *   human passwords: brute force is already infeasible, so we want a fast,
 *   deterministic hash we can index/dedupe and compare in constant time.
 *   (Passwords for humans would use argon2 -- different threat model.)
 * - Authentication then costs one indexed lookup + one constant-time compare,
 *   no scan over all keys.
 */

const KEY_PREFIX_ALPHABET = /^[0-9a-f]{8}$/;

export type GeneratedApiKey = {
  /** Shown to the merchant exactly once. Never stored. */
  readonly rawKey: string;
  /** Stored; used to locate the row. */
  readonly keyPrefix: string;
  /** Stored; HMAC-SHA256(rawKey, secret) as 64 lowercase hex chars. */
  readonly keyHash: string;
};

export function generateApiKey(live: boolean, secret: string): GeneratedApiKey {
  const env = live ? "live" : "test";
  const prefixPart = crypto.randomBytes(4).toString("hex");
  const secretPart = crypto.randomBytes(16).toString("hex");
  const keyPrefix = `cw_${env}_${prefixPart}`;
  const rawKey = `${keyPrefix}_${secretPart}`;
  return { rawKey, keyPrefix, keyHash: hashApiKey(rawKey, secret) };
}

export function hashApiKey(rawKey: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawKey, "utf8").digest("hex");
}

/** Pull the lookup prefix out of a raw key without touching the database. */
export function extractKeyPrefix(rawKey: string): string | null {
  const match = /^(cw_(?:live|test)_[0-9a-f]{8})_[0-9a-f]{32}$/.exec(rawKey);
  if (!match) return null;
  const prefix = match[1] as string;
  return KEY_PREFIX_ALPHABET.test(prefix.slice(prefix.lastIndexOf("_") + 1)) ? prefix : null;
}

/** Constant-time comparison of two hex digests. */
export function safeCompareDigest(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
