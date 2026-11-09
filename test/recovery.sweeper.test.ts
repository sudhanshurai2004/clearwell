import { describe, it, expect, vi } from "vitest";
import { PaymentService } from "../src/modules/payment/payment.service";

describe("M7 Timeout Recovery Sweeper", () => {
  it("should resolve UNKNOWN payments using PSP status inquiry", async () => {
    const payment = {
      id: "pay_123",
      merchantId: "m_123",
      amount: 5000n,
      currency: "USD",
      status: "UNKNOWN" as const,
      authorizedAmount: 0n,
      capturedAmount: 0n,
      refundedAmount: 0n,
      pspRef: "psp_123",
      version: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const fakeRepo = {
      findByStatus: vi.fn().mockResolvedValue([payment]),
      updatePaymentState: vi.fn().mockImplementation(async (_id, _expected, newStatus, updates) => ({
        ...payment,
        status: newStatus,
        authorizedAmount: updates.authorizedAmount ?? payment.authorizedAmount,
        pspRef: updates.pspRef ?? payment.pspRef,
      })),
      recordEvent: vi.fn().mockResolvedValue({}),
    };

    const fakePsp = {
      authorize: vi.fn(),
      capture: vi.fn(),
      void: vi.fn(),
      refund: vi.fn(),
      statusInquiry: vi.fn().mockResolvedValue({
        pspReference: "psp_123",
        ourReference: payment.id,
        status: "AUTHORIZED",
        amount: "5000",
        currency: "USD",
      }),
    };

    const fakeClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };

    const fakePool = {
      connect: vi.fn().mockResolvedValue(fakeClient),
    };

    const service = new PaymentService(
      fakeRepo as any,
      fakePsp as any,
      undefined as any,
      fakePool as any
    );

    const result = await service.recoverUnknownPayments(10);

    expect(result.scanned).toBe(1);
    expect(result.recovered).toBe(1);
    expect(fakePsp.statusInquiry).toHaveBeenCalledWith("pay_123");
    expect(fakeRepo.updatePaymentState).toHaveBeenCalledWith(
      "pay_123",
      "UNKNOWN",
      "AUTHORIZED",
      expect.objectContaining({
        authorizedAmount: payment.amount,
        pspRef: "psp_123",
      }),
      expect.anything()
    );
  });
});
