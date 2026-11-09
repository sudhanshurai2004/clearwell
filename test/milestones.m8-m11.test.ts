import { describe, it, expect } from "vitest";
import { riskService } from "../src/modules/risk/risk.service";
import { outboxService } from "../src/modules/outbox/outbox.service";
import { reconciliationService } from "../src/modules/recon/recon.service";

describe("Milestones M8 to M11", () => {
  it("should reject high-value or high-velocity payments in the risk engine", () => {
    const rejectedByAmount = riskService.evaluate({
      merchantId: "m-1",
      paymentId: "p-1",
      amount: 10000001n,
      currency: "USD",
    });

    const rejectedByVelocity = riskService.evaluate({
      merchantId: "m-1",
      paymentId: "p-2",
      amount: 500n,
      currency: "USD",
      recentAuthorizationCount: 5,
      velocityLimit: 5,
    });

    expect(rejectedByAmount.allowed).toBe(false);
    expect(rejectedByAmount.code).toBe("AMOUNT_LIMIT_EXCEEDED");
    expect(rejectedByVelocity.allowed).toBe(false);
    expect(rejectedByVelocity.code).toBe("VELOCITY_LIMIT_EXCEEDED");
  });

  it("should produce signed outbox events and publish them", async () => {
    const event = outboxService.createEvent("payment", "p-1", "PAYMENT_AUTHORIZED", { amount: "1000" });
    const signature = outboxService.signPayload(JSON.stringify(event), "secret");

    expect(event.status).toBe("PENDING");
    expect(signature).toContain("v1=");

    const published = await outboxService.processPending("https://example.com/webhook", "secret", {
      maxRetries: 1,
    });
    expect(Array.isArray(published)).toBe(true);
  });

  it("should compare settlement files to internal payment states", () => {
    const mismatches = reconciliationService.compareSettlement(
      [
        { paymentId: "p-1", amount: "1000", currency: "USD", status: "CAPTURED" },
      ],
      "psp_ref,our_payment_id,amount,currency,status,settled_at\np-abc,p-1,999,USD,DECLINED,2024-01-01T00:00:00.000Z\n"
    );

    expect(mismatches.some((m) => m.type === "AMOUNT_DIFF")).toBe(true);
    expect(mismatches.some((m) => m.type === "STATUS_DIFF")).toBe(true);
  });
});
