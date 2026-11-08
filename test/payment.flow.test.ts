import { describe, it, expect, beforeEach, vi } from "vitest";
import { PaymentService } from "../src/modules/payment/payment.service";
import { PspSimulator } from "../src/modules/payment/psp/psp-simulator";
import { SimulatorPspClient } from "../src/modules/payment/psp/psp.client";
import { TEST_CARDS } from "../src/modules/payment/psp/psp.types";
import { Payment, PaymentStatus } from "../src/modules/payment/payment.types";
import { NotFoundError, BadRequestError, ConflictError } from "../src/modules/common/errors";

describe("Payment Lifecycle & Ledger Wiring (M4)", () => {
  let simulator: PspSimulator;
  let pspClient: SimulatorPspClient;
  let service: PaymentService;

  // In-memory payment and event storage for unit test verification
  const paymentsTable = new Map<string, Payment>();
  const paymentEventsTable: any[] = [];
  let ledgerCaptureCalls: any[] = [];
  let ledgerRefundCalls: any[] = [];

  const mockRepo = {
    createPayment: vi.fn(async (merchantId: string, amount: bigint, currency: string) => {
      const id = `pay_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const payment: Payment = {
        id,
        merchantId,
        amount,
        currency,
        status: "CREATED",
        authorizedAmount: 0n,
        capturedAmount: 0n,
        refundedAmount: 0n,
        pspRef: null,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      paymentsTable.set(id, payment);
      return payment;
    }),

    updatePaymentState: vi.fn(
      async (
        paymentId: string,
        expectedStatus: PaymentStatus,
        newStatus: PaymentStatus,
        updates: any = {}
      ) => {
        const p = paymentsTable.get(paymentId);
        if (!p || p.status !== expectedStatus) {
          throw new ConflictError("Status mismatch");
        }
        p.status = newStatus;
        if (updates.authorizedAmount !== undefined) p.authorizedAmount = updates.authorizedAmount;
        if (updates.capturedAmount !== undefined) p.capturedAmount = updates.capturedAmount;
        if (updates.refundedAmount !== undefined) p.refundedAmount = updates.refundedAmount;
        if (updates.pspRef !== undefined) p.pspRef = updates.pspRef;
        p.version += 1;
        p.updatedAt = new Date();
        return p;
      }
    ),

    recordEvent: vi.fn(async (paymentId: string, prev: any, next: any, type: string, payload: any) => {
      const event = { id: `evt_${Date.now()}`, paymentId, prev, next, type, payload, createdAt: new Date() };
      paymentEventsTable.push(event);
      return event;
    }),

    findByMerchantAndId: vi.fn(async (merchantId: string, paymentId: string) => {
      const p = paymentsTable.get(paymentId);
      if (!p || p.merchantId !== merchantId) return null;
      return p;
    }),
  } as any;

  const mockLedger = {
    recordPaymentCapture: vi.fn(async (mId: string, pId: string, gross: bigint, curr: string) => {
      ledgerCaptureCalls.push({ mId, pId, gross, curr });
      return { transaction: { id: "tx_cap" }, entries: [], isRetry: false };
    }),
    recordPaymentRefund: vi.fn(async (mId: string, refId: string, amount: bigint, curr: string) => {
      ledgerRefundCalls.push({ mId, refId, amount, curr });
      return { transaction: { id: "tx_ref" }, entries: [], isRetry: false };
    }),
  } as any;

  const mockPool = {
    connect: vi.fn(async () => ({
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    })),
  } as any;

  beforeEach(() => {
    simulator = new PspSimulator();
    pspClient = new SimulatorPspClient(simulator);
    paymentsTable.clear();
    paymentEventsTable.length = 0;
    ledgerCaptureCalls = [];
    ledgerRefundCalls = [];

    service = new PaymentService(mockRepo, pspClient, mockLedger, mockPool);
  });

  describe("Authorize & Capture Flow", () => {
    it("should authorize payment without writing ledger entries", async () => {
      const res = await service.createAndAuthorize("merchant-1", {
        amount: "10000", // $100.00
        currency: "USD",
        payment_method: {
          card_number: TEST_CARDS.SUCCESS,
          expiry_month: 12,
          expiry_year: 2028,
          cvv: "123",
        },
      });

      expect(res.status).toBe("AUTHORIZED");
      expect(res.authorized_amount).toBe("10000");
      expect(res.captured_amount).toBe("0");
      expect(res.psp_ref).toBeDefined();

      // Golden Rule: Authorization writes NO ledger entries!
      expect(ledgerCaptureCalls).toHaveLength(0);
    });

    it("should capture authorized payment and post to double-entry ledger", async () => {
      const auth = await service.createAndAuthorize("merchant-1", {
        amount: "10000",
        currency: "USD",
        payment_method: {
          card_number: TEST_CARDS.SUCCESS,
          expiry_month: 12,
          expiry_year: 2028,
          cvv: "123",
        },
      });

      const capture = await service.capturePayment("merchant-1", auth.id, 10000n);

      expect(capture.status).toBe("CAPTURED");
      expect(capture.captured_amount).toBe("10000");

      // Verify double-entry ledger posting was triggered
      expect(ledgerCaptureCalls).toHaveLength(1);
      expect(ledgerCaptureCalls[0]).toMatchObject({
        mId: "merchant-1",
        pId: auth.id,
        gross: 10000n,
        curr: "USD",
      });
    });

    it("should support partial capture and reject over-capture", async () => {
      const auth = await service.createAndAuthorize("merchant-1", {
        amount: "5000",
        currency: "USD",
        payment_method: {
          card_number: TEST_CARDS.SUCCESS,
          expiry_month: 12,
          expiry_year: 2028,
          cvv: "123",
        },
      });

      // Partial capture of 2000 cents
      const partial = await service.capturePayment("merchant-1", auth.id, 2000n);
      expect(partial.captured_amount).toBe("2000");
      expect(partial.authorized_amount).toBe("5000");

      // Attempting further capture on an already CAPTURED payment rejects with ConflictError (409)
      await expect(
        service.capturePayment("merchant-1", auth.id, 1000n)
      ).rejects.toThrowError(ConflictError);
    });

    it("should reject capture exceeding available authorized amount on fresh authorization", async () => {
      const auth = await service.createAndAuthorize("merchant-1", {
        amount: "3000",
        currency: "USD",
        payment_method: {
          card_number: TEST_CARDS.SUCCESS,
          expiry_month: 12,
          expiry_year: 2028,
          cvv: "123",
        },
      });

      // Capture amount (4000) > Authorized amount (3000)
      await expect(
        service.capturePayment("merchant-1", auth.id, 4000n)
      ).rejects.toThrowError(BadRequestError);
    });
  });

  describe("Void Flow", () => {
    it("should void authorized payment without writing ledger entries", async () => {
      const auth = await service.createAndAuthorize("merchant-1", {
        amount: "3000",
        currency: "USD",
        payment_method: {
          card_number: TEST_CARDS.SUCCESS,
          expiry_month: 12,
          expiry_year: 2028,
          cvv: "123",
        },
      });

      const voidRes = await service.voidPayment("merchant-1", auth.id);
      expect(voidRes.status).toBe("VOIDED");

      // Void writes NO ledger entries
      expect(ledgerCaptureCalls).toHaveLength(0);

      // Cannot capture voided payment
      await expect(
        service.capturePayment("merchant-1", auth.id, 3000n)
      ).rejects.toThrowError(ConflictError);
    });
  });

  describe("Refund Flow with Proportional Fee Reversal", () => {
    it("should handle partial and full refunds posting to ledger", async () => {
      const auth = await service.createAndAuthorize("merchant-1", {
        amount: "10000",
        currency: "USD",
        payment_method: {
          card_number: TEST_CARDS.SUCCESS,
          expiry_month: 12,
          expiry_year: 2028,
          cvv: "123",
        },
      });
      await service.capturePayment("merchant-1", auth.id, 10000n);

      // Partial refund: 4000 cents
      const partRefund = await service.refundPayment("merchant-1", auth.id, 4000n, "Customer request");
      expect(partRefund.status).toBe("PARTIALLY_REFUNDED");
      expect(partRefund.refunded_amount).toBe("4000");
      expect(ledgerRefundCalls).toHaveLength(1);
      expect(ledgerRefundCalls[0].amount).toBe(4000n);

      // Final refund: 6000 cents (total 10000)
      const fullRefund = await service.refundPayment("merchant-1", auth.id, 6000n, "Remaining balance");
      expect(fullRefund.status).toBe("REFUNDED");
      expect(fullRefund.refunded_amount).toBe("10000");
      expect(ledgerRefundCalls).toHaveLength(2);

      // Attempting further refund on a fully REFUNDED payment rejects with ConflictError (409)
      await expect(
        service.refundPayment("merchant-1", auth.id, 100n)
      ).rejects.toThrowError(ConflictError);
    });

    it("should reject refund amount exceeding captured amount", async () => {
      const auth = await service.createAndAuthorize("merchant-1", {
        amount: "5000",
        currency: "USD",
        payment_method: {
          card_number: TEST_CARDS.SUCCESS,
          expiry_month: 12,
          expiry_year: 2028,
          cvv: "123",
        },
      });
      await service.capturePayment("merchant-1", auth.id, 5000n);

      // Refund 6000 > Captured 5000
      await expect(
        service.refundPayment("merchant-1", auth.id, 6000n)
      ).rejects.toThrowError(BadRequestError);
    });
  });

  describe("Provider Timeout Handling (Golden Rule: UNKNOWN, never DECLINED)", () => {
    it("should mark payment as UNKNOWN when PSP times out", async () => {
      const res = await service.createAndAuthorize("merchant-1", {
        amount: "5000",
        currency: "USD",
        payment_method: {
          card_number: TEST_CARDS.TIMEOUT,
          expiry_month: 12,
          expiry_year: 2028,
          cvv: "123",
        },
      });

      // Must be UNKNOWN (in-doubt), NEVER DECLINED!
      expect(res.status).toBe("UNKNOWN");
    });
  });

  describe("Tenant Isolation Enforcement", () => {
    it("should return 404 when querying another merchant's payment", async () => {
      const auth = await service.createAndAuthorize("merchant-A", {
        amount: "2500",
        currency: "USD",
        payment_method: {
          card_number: TEST_CARDS.SUCCESS,
          expiry_month: 12,
          expiry_year: 2028,
          cvv: "123",
        },
      });

      // Merchant B queries Merchant A's payment ID -> returns 404 Not Found!
      await expect(
        service.getPaymentById("merchant-B-attacker", auth.id)
      ).rejects.toThrowError(NotFoundError);
    });
  });
});
