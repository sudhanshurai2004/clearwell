import { describe, expect, it } from "vitest";
import {
  allowedTransitions,
  assertPayoutTransition,
  assertTransition,
  canTransition,
  isTerminal,
  PaymentStatus,
  PayoutStatus,
} from "../../src/modules/payment/payment-state";

describe("payment state machine", () => {
  it("allows the designed happy path", () => {
    expect(canTransition("CREATED", "AUTH_PENDING")).toBe(true);
    expect(canTransition("AUTH_PENDING", "AUTHORIZED")).toBe(true);
    expect(canTransition("AUTHORIZED", "CAPTURE_PENDING")).toBe(true);
    expect(canTransition("CAPTURE_PENDING", "CAPTURED")).toBe(true);
    expect(canTransition("CAPTURED", "PARTIALLY_REFUNDED")).toBe(true);
    expect(canTransition("PARTIALLY_REFUNDED", "REFUNDED")).toBe(true);
  });

  it("allows the agreed gap-fix edges", () => {
    // A capture the provider refuses must not strand the payment.
    expect(canTransition("CAPTURE_PENDING", "AUTHORIZED")).toBe(true);
    // A timeout leaves us in UNKNOWN, which recovery resolves.
    expect(canTransition("AUTH_PENDING", "UNKNOWN")).toBe(true);
    expect(canTransition("UNKNOWN", "AUTHORIZED")).toBe(true);
    expect(canTransition("UNKNOWN", "DECLINED")).toBe(true);
  });

  it("forbids skipping steps and going backwards", () => {
    const illegal: [PaymentStatus, PaymentStatus][] = [
      ["CREATED", "AUTHORIZED"],
      ["CREATED", "CAPTURED"],
      ["AUTHORIZED", "CAPTURED"],
      ["AUTHORIZED", "REFUNDED"],
      ["CAPTURED", "VOIDED"],
      ["CAPTURED", "AUTHORIZED"],
      ["DECLINED", "AUTHORIZED"],
      ["REFUNDED", "PARTIALLY_REFUNDED"],
      ["VOIDED", "AUTHORIZED"],
      ["RISK_REJECTED", "AUTH_PENDING"],
    ];
    for (const [from, to] of illegal) {
      expect(canTransition(from, to), `${from} -> ${to} must be illegal`).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(/Illegal payment transition/);
    }
  });

  it("treats settled states as terminal", () => {
    for (const status of ["REFUNDED", "VOIDED", "DECLINED", "RISK_REJECTED"] as PaymentStatus[]) {
      expect(isTerminal(status)).toBe(true);
      expect(allowedTransitions(status)).toHaveLength(0);
    }
    expect(isTerminal("AUTHORIZED")).toBe(false);
  });

  it("returns 409 semantics for illegal transitions", () => {
    try {
      assertTransition("DECLINED", "AUTHORIZED");
      throw new Error("should have thrown");
    } catch (err) {
      const error = err as { status: number; code: string; message: string };
      expect(error.status).toBe(409);
      expect(error.code).toBe("CONFLICT");
      expect(error.message).toContain("terminal state");
    }
  });
});

describe("payout state machine", () => {
  it("follows PENDING -> PROCESSING -> COMPLETED | FAILED", () => {
    expect(PayoutStatus.PENDING).toBe("PENDING");
    expect(() => assertPayoutTransition("PENDING", "PROCESSING")).not.toThrow();
    expect(() => assertPayoutTransition("PROCESSING", "COMPLETED")).not.toThrow();
    expect(() => assertPayoutTransition("PROCESSING", "FAILED")).not.toThrow();
  });

  it("forbids skipping and leaving terminal states", () => {
    expect(() => assertPayoutTransition("PENDING", "COMPLETED")).toThrow();
    expect(() => assertPayoutTransition("COMPLETED", "FAILED")).toThrow();
    expect(() => assertPayoutTransition("FAILED", "PROCESSING")).toThrow();
  });
});
