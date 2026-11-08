import crypto from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * A UUIDv7-ish identifier: 48-bit big-endian millisecond timestamp followed by
 * 80 bits of randomness. Encoded as base32hex (lowercase), giving a fixed
 * 26-character, URL-safe, lexicographically sortable id.
 *
 * Why not randomUUID()? Payment/correlation ids end up in database indexes and
 * logs. Time-ordered ids keep B-tree inserts at the right edge of the index
 * instead of scattering them, and they sort chronologically in logs.
 */
export function newId(): string {
  // 128 bits total, exactly like a UUID: 48-bit timestamp + 80 random bits.
  // 128 bits -> ceil(128/5) = 26 base32 characters, no padding needed.
  const bytes = Buffer.alloc(16);
  // Date.now() is safe here: it is ~1.8e12, far below 2^48.
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  crypto.randomFillSync(bytes, 6, 10);
  return base32hex(bytes);
}

function base32hex(bytes: Buffer): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Constant-time string comparison, for HMAC/signature checks. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
