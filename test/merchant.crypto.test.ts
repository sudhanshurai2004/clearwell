import { describe, it, expect } from "vitest";
import { generateApiKey, hashApiKey, verifyApiKey } from "../src/modules/merchant/merchant.crypto";

describe("Merchant API Key Crypto Utilities", () => {
  it("should generate a key with cw_live_ prefix and exactly 16 character lookup prefix", () => {
    const { rawKey, prefix, hash } = generateApiKey();

    expect(rawKey.startsWith("cw_live_")).toBe(true);
    expect(prefix.length).toBe(16);
    expect(rawKey.startsWith(prefix)).toBe(true);
    expect(hash).toBeDefined();
    expect(hash.length).toBe(64); // SHA-256 / HMAC-SHA256 hex is 64 chars
  });

  it("should verify valid key successfully", () => {
    const { rawKey, hash } = generateApiKey();
    const isValid = verifyApiKey(rawKey, hash);

    expect(isValid).toBe(true);
  });

  it("should reject tampered or invalid key", () => {
    const { rawKey, hash } = generateApiKey();
    const tamperedKey = rawKey.slice(0, -1) + (rawKey.slice(-1) === "a" ? "b" : "a");

    const isValid = verifyApiKey(tamperedKey, hash);
    expect(isValid).toBe(false);
  });

  it("should reject completely invalid key against stored hash", () => {
    const { hash } = generateApiKey();
    const isValid = verifyApiKey("cw_live_fakekey1234567890", hash);

    expect(isValid).toBe(false);
  });
});
