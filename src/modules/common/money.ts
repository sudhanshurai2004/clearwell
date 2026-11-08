import { z } from "zod";

/**
 * MONEY RULES (non-negotiable in this project)
 *  - Amounts are INTEGER MINOR UNITS (cents/paise). 10.50 USD == 1050.
 *  - Transported and stored as strings/BIGINT, never as JSON floats.
 *      JS:  0.1 + 0.2 === 0.30000000000000004   -> never use for money
 *      C++: double has the same problem; you would use int64_t cents
 *  - In code we use `bigint`, which is exact for any size.
 *      JS `number` is only exact up to 2^53 (~9e15) -- fine for cents in
 *      practice, but "in practice" is not a guarantee, so we don't rely on it.
 */

export const CURRENCY_REGEX = /^[A-Z]{3}$/;

export const CurrencySchema = z
  .string()
  .regex(CURRENCY_REGEX, "currency must be a 3-letter ISO-4217 code, e.g. USD");

/**
 * Accepts "1050" (preferred) or 1050 and yields bigint minor units.
 * Rejects floats, negatives, zero, exponents, and numbers beyond 2^53.
 */
export const MinorUnitsSchema = z
  .union([z.string(), z.number()])
  .superRefine((value, ctx) => {
    const raw = typeof value === "number" ? String(value) : value.trim();
    if (!/^\d+$/.test(raw)) {
      ctx.addIssue({
        code: "custom",
        message: "amount must be a positive integer in minor units (e.g. \"1050\")",
      });
      return;
    }
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      ctx.addIssue({
        code: "custom",
        message: "amount must be sent as a string once it exceeds 2^53",
      });
      return;
    }
    const parsed = BigInt(raw);
    if (parsed <= 0n) {
      ctx.addIssue({ code: "custom", message: "amount must be greater than zero" });
    }
    if (parsed > MAX_AMOUNT_MINOR) {
      ctx.addIssue({ code: "custom", message: "amount exceeds the maximum allowed value" });
    }
  })
  .transform((value) => BigInt(typeof value === "number" ? String(value) : value.trim()));

/**
 * Hard ceiling: 10^15 minor units (10 trillion currency units).
 *
 * Chosen deliberately BELOW Number.MAX_SAFE_INTEGER (2^53 = 9.007e15) so that
 * even a caller who sends a JSON number can never hand us a value that a
 * double cannot represent exactly. The `Number.isSafeInteger` check above is
 * therefore a second line of defence, not the primary one.
 */
export const MAX_AMOUNT_MINOR = 10n ** 15n;

export type MinorUnits = bigint;

/** Serialise for JSON/logs without losing precision. */
export function minorUnitsToString(amount: bigint): string {
  return amount.toString();
}

/** Human-readable ("1050" -> "10.50"), for logs and the optional dashboard only. */
export function formatMinorUnits(amount: bigint, currency: string): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const major = abs / 100n;
  const minor = abs % 100n;
  const body = `${major}.${minor.toString().padStart(2, "0")}`;
  return `${negative ? "-" : ""}${body} ${currency}`;
}

/**
 * Flat percentage fee with FLOOR rounding, decided in v1:
 *   fee = floor(amount * rateBps / 10000)
 * Refunds reverse the fee proportionally (floor as well) -- implemented in the
 * ledger module, where the rounding rule is documented next to the posting.
 */
export function flatFeeBps(amount: bigint, rateBps: bigint): bigint {
  if (amount <= 0n) throw new Error("amount must be positive");
  if (rateBps < 0n || rateBps > 10_000n) throw new Error("rateBps out of range");
  return (amount * rateBps) / 10_000n; // integer division == floor for non-negatives
}

export const PLATFORM_FEE_BPS = 200n; // 2%
