import crypto from "node:crypto";

/**
 * HMAC-SHA256 request signing, the same scheme on PSP callbacks and merchant
 * webhooks:
 *
 *   signed_payload = `<timestamp>.<raw body>`
 *   signature      = hex(hmac_sha256(secret, signed_payload))
 *
 * The timestamp is inside the signature, which is what allows a replay window
 * check (5 minutes): an attacker cannot re-use an old body with a new time
 * because the signature would no longer match.
 *
 * Comparing signatures must be constant-time (crypto.timingSafeEqual) or the
 * comparison itself leaks how much of the signature was guessed correctly.
 */
export const SIGNATURE_HEADER = "x-clearwell-signature";
export const TIMESTAMP_HEADER = "x-clearwell-timestamp";
export const REPLAY_WINDOW_SECONDS = 300;

export function signPayload(secret: string, timestamp: string, rawBody: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`, "utf8")
    .digest("hex");
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" };

export function verifySignature(input: {
  secret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  nowSeconds?: number;
}): VerifyResult {
  const { secret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "stale_timestamp" };
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > REPLAY_WINDOW_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const expected = signPayload(secret, timestamp, rawBody);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length || a.length === 0) return { ok: false, reason: "bad_signature" };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: "bad_signature" };
}
