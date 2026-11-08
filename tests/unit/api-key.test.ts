import { describe, expect, it } from "vitest";
import {
  extractKeyPrefix,
  generateApiKey,
  hashApiKey,
  safeCompareDigest,
} from "../../src/modules/merchant/api-key";
import { newId } from "../../src/modules/common/ids";

const SECRET = "unit-test-secret";

describe("api key generation", () => {
  it("produces a raw key whose prefix is recoverable and hash matches", () => {
    const key = generateApiKey(true, SECRET);
    expect(key.rawKey).toMatch(/^cw_live_[0-9a-f]{8}_[0-9a-f]{32}$/);
    expect(key.keyPrefix).toMatch(/^cw_live_[0-9a-f]{8}$/);
    expect(extractKeyPrefix(key.rawKey)).toBe(key.keyPrefix);
    expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key.rawKey, SECRET)).toBe(key.keyHash);
  });

  it("uses test prefix for non-live keys", () => {
    expect(generateApiKey(false, SECRET).rawKey.startsWith("cw_test_")).toBe(true);
  });

  it("never repeats a key", () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey(true, SECRET).rawKey));
    expect(keys.size).toBe(200);
  });

  it("changes the hash when the server secret changes", () => {
    const key = generateApiKey(true, SECRET);
    expect(hashApiKey(key.rawKey, "another-secret")).not.toBe(key.keyHash);
  });
});

describe("api key parsing rejects junk", () => {
  it.each([
    "",
    "cw_live_",
    "cw_live_abcd1234",
    "cw_live_abcd1234_short",
    "bearer cw_live_abcd1234_0123456789abcdef0123456789abcdef",
    "cw_prod_abcd1234_0123456789abcdef0123456789abcdef",
    "cw_live_ZZZZZZZZ_0123456789abcdef0123456789abcdef",
  ])("rejects %s", (input) => {
    expect(extractKeyPrefix(input)).toBeNull();
  });
});

describe("constant time comparison", () => {
  it("compares hex digests correctly", () => {
    expect(safeCompareDigest("aabb", "aabb")).toBe(true);
    expect(safeCompareDigest("aabb", "aabc")).toBe(false);
    expect(safeCompareDigest("aabb", "aab")).toBe(false);
    expect(safeCompareDigest("", "")).toBe(false);
  });
});

describe("ids", () => {
  it("are 26 chars, url safe, unique, and time ordered", async () => {
    const a = newId();
    await new Promise((r) => setTimeout(r, 2));
    const b = newId();
    expect(a).toMatch(/^[0-9a-v]{26}$/);
    expect(a).not.toBe(b);
    // Lexicographic order follows creation order (timestamp is the high bits).
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => newId())).size).toBe(1000);
  });
});
