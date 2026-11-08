import { describe, it, expect } from "vitest";
import { PaymentStateMachine } from "../src/modules/payment/payment.state-machine";
import { ConflictError } from "../src/modules/common/errors";

describe("Payment State Machine & Transitions (M3)", () => {
  describe("Valid Transitions", () => {
    it("should allow CREATED -> AUTH_PENDING and CREATED -> RISK_REJECTED", () => {
      expect(PaymentStateMachine.isValidPaymentTransition("CREATED", "AUTH_PENDING")).toBe(true);
      expect(PaymentStateMachine.isValidPaymentTransition("CREATED", "RISK_REJECTED")).toBe(true);
    });

    it("should allow AUTH_PENDING -> AUTHORIZED, DECLINED, and UNKNOWN", () => {
      expect(PaymentStateMachine.isValidPaymentTransition("AUTH_PENDING", "AUTHORIZED")).toBe(true);
      expect(PaymentStateMachine.isValidPaymentTransition("AUTH_PENDING", "DECLINED")).toBe(true);
      expect(PaymentStateMachine.isValidPaymentTransition("AUTH_PENDING", "UNKNOWN")).toBe(true);
    });

    it("should allow UNKNOWN -> AUTHORIZED and UNKNOWN -> DECLINED via recovery", () => {
      expect(PaymentStateMachine.isValidPaymentTransition("UNKNOWN", "AUTHORIZED")).toBe(true);
      expect(PaymentStateMachine.isValidPaymentTransition("UNKNOWN", "DECLINED")).toBe(true);
    });

    it("should allow AUTHORIZED -> CAPTURE_PENDING and AUTHORIZED -> VOIDED", () => {
      expect(PaymentStateMachine.isValidPaymentTransition("AUTHORIZED", "CAPTURE_PENDING")).toBe(true);
      expect(PaymentStateMachine.isValidPaymentTransition("AUTHORIZED", "VOIDED")).toBe(true);
    });

    it("should allow CAPTURE_PENDING -> CAPTURED, and gap-fix CAPTURE_PENDING -> AUTHORIZED", () => {
      expect(PaymentStateMachine.isValidPaymentTransition("CAPTURE_PENDING", "CAPTURED")).toBe(true);
      expect(PaymentStateMachine.isValidPaymentTransition("CAPTURE_PENDING", "AUTHORIZED")).toBe(true);
    });

    it("should allow CAPTURED -> PARTIALLY_REFUNDED and CAPTURED -> REFUNDED", () => {
      expect(PaymentStateMachine.isValidPaymentTransition("CAPTURED", "PARTIALLY_REFUNDED")).toBe(true);
      expect(PaymentStateMachine.isValidPaymentTransition("CAPTURED", "REFUNDED")).toBe(true);
      expect(PaymentStateMachine.isValidPaymentTransition("PARTIALLY_REFUNDED", "REFUNDED")).toBe(true);
    });
  });

  describe("Illegal Transitions Enforcement", () => {
    it("should reject illegal transition CREATED -> CAPTURED", () => {
      expect(PaymentStateMachine.isValidPaymentTransition("CREATED", "CAPTURED")).toBe(false);
      expect(() =>
        PaymentStateMachine.assertValidPaymentTransition("CREATED", "CAPTURED", "pay-1")
      ).toThrowError(ConflictError);
    });

    it("should reject illegal transition DECLINED -> AUTHORIZED (Terminal state)", () => {
      expect(PaymentStateMachine.isValidPaymentTransition("DECLINED", "AUTHORIZED")).toBe(false);
      expect(() =>
        PaymentStateMachine.assertValidPaymentTransition("DECLINED", "AUTHORIZED")
      ).toThrowError(ConflictError);
    });

    it("should reject illegal transition VOIDED -> CAPTURED (Terminal state)", () => {
      expect(PaymentStateMachine.isValidPaymentTransition("VOIDED", "CAPTURED")).toBe(false);
      expect(() =>
        PaymentStateMachine.assertValidPaymentTransition("VOIDED", "CAPTURED")
      ).toThrowError(ConflictError);
    });

    it("should reject illegal transition REFUNDED -> AUTHORIZED (Terminal state)", () => {
      expect(PaymentStateMachine.isValidPaymentTransition("REFUNDED", "AUTHORIZED")).toBe(false);
      expect(() =>
        PaymentStateMachine.assertValidPaymentTransition("REFUNDED", "AUTHORIZED")
      ).toThrowError(ConflictError);
    });
  });

  describe("Payout State Machine", () => {
    it("should allow PENDING -> PROCESSING -> COMPLETED or FAILED", () => {
      expect(PaymentStateMachine.isValidPayoutTransition("PENDING", "PROCESSING")).toBe(true);
      expect(PaymentStateMachine.isValidPayoutTransition("PROCESSING", "COMPLETED")).toBe(true);
      expect(PaymentStateMachine.isValidPayoutTransition("PROCESSING", "FAILED")).toBe(true);
    });

    it("should reject illegal transition PENDING -> COMPLETED directly", () => {
      expect(PaymentStateMachine.isValidPayoutTransition("PENDING", "COMPLETED")).toBe(false);
      expect(() =>
        PaymentStateMachine.assertValidPayoutTransition("PENDING", "COMPLETED")
      ).toThrowError(ConflictError);
    });
  });
});
