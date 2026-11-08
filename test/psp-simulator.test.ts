import { describe, it, expect, beforeEach } from "vitest";
import { PspSimulator } from "../src/modules/payment/psp/psp-simulator";
import { SimulatorPspClient } from "../src/modules/payment/psp/psp.client";
import { TEST_CARDS } from "../src/modules/payment/psp/psp.types";
import { GatewayTimeoutError, BadRequestError, NotFoundError } from "../src/modules/common/errors";

describe("PSP Simulator & Client Adapter (M3)", () => {
  let simulator: PspSimulator;
  let client: SimulatorPspClient;

  beforeEach(() => {
    simulator = new PspSimulator();
    client = new SimulatorPspClient(simulator);
  });

  describe("Authorization Flow & Fault Modes", () => {
    it("should authorize successfully with valid test card", async () => {
      const res = await client.authorize({
        ourReference: "pay_test_001",
        amount: "5000",
        currency: "USD",
        cardNumber: TEST_CARDS.SUCCESS,
      });

      expect(res.status).toBe("AUTHORIZED");
      expect(res.pspReference.startsWith("psp_sim_")).toBe(true);
      expect(res.ourReference).toBe("pay_test_001");
      expect(res.authorizationCode).toBeDefined();
    });

    it("should return identical response when called idempotently with same ourReference", async () => {
      const first = await client.authorize({
        ourReference: "pay_idempotent_001",
        amount: "2500",
        currency: "USD",
        cardNumber: TEST_CARDS.SUCCESS,
      });

      const second = await client.authorize({
        ourReference: "pay_idempotent_001",
        amount: "2500",
        currency: "USD",
        cardNumber: TEST_CARDS.SUCCESS,
      });

      expect(second.pspReference).toBe(first.pspReference);
      expect(second.status).toBe(first.status);
      expect(second.authorizationCode).toBe(first.authorizationCode);
    });

    it("should decline card with DO_NOT_HONOR when decline card is used", async () => {
      const res = await client.authorize({
        ourReference: "pay_decline_001",
        amount: "1000",
        currency: "USD",
        cardNumber: TEST_CARDS.DECLINE,
      });

      expect(res.status).toBe("DECLINED");
      expect(res.declineReason).toBe("DO_NOT_HONOR");
    });

    it("should decline card with INSUFFICIENT_FUNDS when designated card is used", async () => {
      const res = await client.authorize({
        ourReference: "pay_nsf_001",
        amount: "1000",
        currency: "USD",
        cardNumber: TEST_CARDS.INSUFFICIENT_FUNDS,
      });

      expect(res.status).toBe("DECLINED");
      expect(res.declineReason).toBe("INSUFFICIENT_FUNDS");
    });

    it("should throw GatewayTimeoutError when timeout card is used", async () => {
      await expect(
        client.authorize({
          ourReference: "pay_timeout_001",
          amount: "1000",
          currency: "USD",
          cardNumber: TEST_CARDS.TIMEOUT,
        })
      ).rejects.toThrowError(GatewayTimeoutError);
    });
  });

  describe("Capture, Void, Refund and Status Inquiry", () => {
    it("should capture an authorized payment successfully", async () => {
      const auth = await client.authorize({
        ourReference: "pay_cap_001",
        amount: "3000",
        currency: "USD",
        cardNumber: TEST_CARDS.SUCCESS,
      });

      const capture = await client.capture({
        pspReference: auth.pspReference,
        amount: "3000",
      });

      expect(capture.status).toBe("CAPTURED");
      expect(capture.capturedAmount).toBe("3000");

      const inquiry = await client.statusInquiry("pay_cap_001");
      expect(inquiry?.status).toBe("CAPTURED");
    });

    it("should void an authorized payment", async () => {
      const auth = await client.authorize({
        ourReference: "pay_void_001",
        amount: "4000",
        currency: "USD",
        cardNumber: TEST_CARDS.SUCCESS,
      });

      const voidRes = await client.void({ pspReference: auth.pspReference });
      expect(voidRes.status).toBe("VOIDED");

      const inquiry = await client.statusInquiry("pay_void_001");
      expect(inquiry?.status).toBe("VOIDED");
    });

    it("should refund a captured payment", async () => {
      const auth = await client.authorize({
        ourReference: "pay_ref_001",
        amount: "6000",
        currency: "USD",
        cardNumber: TEST_CARDS.SUCCESS,
      });

      await client.capture({ pspReference: auth.pspReference, amount: "6000" });

      const refund = await client.refund({
        pspReference: auth.pspReference,
        amount: "3000",
      });

      expect(refund.status).toBe("REFUNDED");
      expect(refund.refundReference).toBeDefined();

      const inquiry = await client.statusInquiry("pay_ref_001");
      expect(inquiry?.status).toBe("REFUNDED");
    });

    it("should reject capture on non-existent pspReference", async () => {
      await expect(
        client.capture({ pspReference: "psp_fake_999", amount: "1000" })
      ).rejects.toThrowError(NotFoundError);
    });

    it("should return null on status inquiry for non-existent ourReference", async () => {
      const inquiry = await client.statusInquiry("our_ref_non_existent");
      expect(inquiry).toBeNull();
    });
  });

  describe("Settlement CSV File Generation", () => {
    it("should generate valid settlement CSV with settled transactions", async () => {
      const auth = await client.authorize({
        ourReference: "pay_settle_001",
        amount: "10000",
        currency: "USD",
        cardNumber: TEST_CARDS.SUCCESS,
      });

      await client.capture({ pspReference: auth.pspReference, amount: "10000" });

      const csv = simulator.generateSettlementCsv();
      expect(csv).toContain("psp_ref,our_payment_id,amount,currency,status,settled_at");
      expect(csv).toContain(auth.pspReference);
      expect(csv).toContain("pay_settle_001");
      expect(csv).toContain("10000");
      expect(csv).toContain("CAPTURED");
    });
  });
});
