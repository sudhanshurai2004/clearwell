import { describe, expect, it } from "vitest";
import {
  flatFeeBps,
  formatMinorUnits,
  MAX_AMOUNT_MINOR,
  MinorUnitsSchema,
  PLATFORM_FEE_BPS,
} from "../../src/modules/common/money";

describe("money validation", () => {
  it("accepts integer strings and numbers and yields bigint", () => {
    expect(MinorUnitsSchema.parse("1050")).toBe(1050n);
    expect(MinorUnitsSchema.parse(1050)).toBe(1050n);
    expect(typeof MinorUnitsSchema.parse("1050")).toBe("bigint");
  });

  it("rejects floats, zero, negatives and non-numeric input", () => {
    for (const bad of ["10.50", "abc", "-100", "0", "1e5", "", " 10.5"]) {
      expect(() => MinorUnitsSchema.parse(bad), `should reject ${bad}`).toThrow();
    }
    expect(() => MinorUnitsSchema.parse(0)).toThrow();
    expect(() => MinorUnitsSchema.parse(-5)).toThrow();
    expect(() => MinorUnitsSchema.parse(10.5)).toThrow();
  });

  it("caps amounts below 2^53 so an inexact double can never be accepted", () => {
    // 2^53 is 9.007e15; our ceiling is 1e15, so every accepted value is exact.
    expect(MAX_AMOUNT_MINOR < BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(MinorUnitsSchema.parse(MAX_AMOUNT_MINOR.toString())).toBe(MAX_AMOUNT_MINOR);
    expect(() => MinorUnitsSchema.parse((MAX_AMOUNT_MINOR + 1n).toString())).toThrow();
    expect(() => MinorUnitsSchema.parse(MAX_AMOUNT_MINOR)).toThrow();
  });

  it("rejects absurd upper bounds", () => {
    expect(() => MinorUnitsSchema.parse("99999999999999999")).toThrow();
  });
});

describe("fee calculation (flat 2%, floor)", () => {
  it("computes floor(2%) and never rounds up", () => {
    expect(flatFeeBps(1000n, PLATFORM_FEE_BPS)).toBe(20n); // 10.00 -> 0.20
    expect(flatFeeBps(1050n, PLATFORM_FEE_BPS)).toBe(21n); // 10.50 -> 0.21
    expect(flatFeeBps(1049n, PLATFORM_FEE_BPS)).toBe(20n); // 10.49 -> 0.2098 -> 0.20
    expect(flatFeeBps(49n, PLATFORM_FEE_BPS)).toBe(0n); // 0.49 -> 0.0098 -> 0.00 floor
    expect(flatFeeBps(1n, PLATFORM_FEE_BPS)).toBe(0n);
  });

  it("gross = net + fee always holds (no lost cents)", () => {
    for (const gross of [1n, 49n, 99n, 100n, 1050n, 123_457n, 9_999_999n]) {
      const fee = flatFeeBps(gross, PLATFORM_FEE_BPS);
      const net = gross - fee;
      expect(net + fee).toBe(gross);
      expect(fee >= 0n).toBe(true);
    }
  });

  it("is exact where floating point would drift", () => {
    // 0.1 + 0.2 style drift: repeating decimals are fine with integers.
    expect(flatFeeBps(10n ** 15n, PLATFORM_FEE_BPS)).toBe(2n * 10n ** 13n);
  });
});

describe("formatting", () => {
  it("renders minor units for humans", () => {
    expect(formatMinorUnits(1050n, "USD")).toBe("10.50 USD");
    expect(formatMinorUnits(5n, "USD")).toBe("0.05 USD");
    expect(formatMinorUnits(0n, "INR")).toBe("0.00 INR");
    expect(formatMinorUnits(-1050n, "USD")).toBe("-10.50 USD");
  });
});
