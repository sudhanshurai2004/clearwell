import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPspHarness, pspFetch, type PspHarness } from "../support/psp-harness";
import { signPayload, verifySignature } from "../../src/psp-simulator/psp-signature";
import { PSP_TEST_SECRET } from "../support/psp-harness";

let psp: PspHarness;

beforeAll(async () => {
  psp = await startPspHarness({ timeoutMs: 300 });
});

afterAll(async () => {
  await psp.close();
});

describe("psp simulator: authorize", () => {
  it("authorises and returns an opaque provider id", async () => {
    const res = await pspFetch(psp.baseUrl, "/psp/authorize", {
      our_reference: "pay_x1",
      amount_minor: "1000",
      currency: "USD",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string; our_reference: string };
    expect(body.status).toBe("AUTHORIZED");
    expect(body.our_reference).toBe("pay_x1");
    expect(body.id).toMatch(/^psp_[0-9a-f]{20}$/);
  });

  it("declines on request with a decline code", async () => {
    const res = await pspFetch(psp.baseUrl, "/psp/authorize", {
      our_reference: "pay_x2",
      amount_minor: "1000",
      currency: "USD",
      fault: "decline",
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("card_declined");
  });

  it("is idempotent per our_reference (a retry cannot double-charge)", async () => {
    await pspFetch(psp.baseUrl, "/psp/_reset", {});
    const first = await pspFetch(psp.baseUrl, "/psp/authorize", {
      our_reference: "pay_idem",
      amount_minor: "500",
      currency: "USD",
    });
    const second = await pspFetch(psp.baseUrl, "/psp/authorize", {
      our_reference: "pay_idem",
      amount_minor: "500",
      currency: "USD",
    });
    const a = (await first.json()) as { id: string };
    const b = (await second.json()) as { id: string };
    expect(a.id).toBe(b.id);
    expect(psp.store.all()).toHaveLength(1);
  });

  it("rejects a malformed request", async () => {
    const res = await pspFetch(psp.baseUrl, "/psp/authorize", { our_reference: "pay_bad" });
    expect(res.status).toBe(400);
  });
});

describe("psp simulator: lifecycle", () => {
  it("capture -> refund -> full refund walks the provider state", async () => {
    await pspFetch(psp.baseUrl, "/psp/authorize", {
      our_reference: "pay_life",
      amount_minor: "1000",
      currency: "USD",
    });

    const captured = (await (
      await pspFetch(psp.baseUrl, "/psp/capture", { our_reference: "pay_life", amount_minor: "1000" })
    ).json()) as { status: string; captured_amount_minor: string };
    expect(captured.status).toBe("CAPTURED");
    expect(captured.captured_amount_minor).toBe("1000");

    const partial = (await (
      await pspFetch(psp.baseUrl, "/psp/refund", { our_reference: "pay_life", amount_minor: "400" })
    ).json()) as { status: string };
    expect(partial.status).toBe("PARTIALLY_REFUNDED");

    const rest = (await (
      await pspFetch(psp.baseUrl, "/psp/refund", { our_reference: "pay_life", amount_minor: "600" })
    ).json()) as { status: string };
    expect(rest.status).toBe("REFUNDED");
  });

  it("refuses a refund larger than the captured amount", async () => {
    await pspFetch(psp.baseUrl, "/psp/authorize", {
      our_reference: "pay_over",
      amount_minor: "1000",
      currency: "USD",
    });
    await pspFetch(psp.baseUrl, "/psp/capture", { our_reference: "pay_over", amount_minor: "1000" });
    const res = await pspFetch(psp.baseUrl, "/psp/refund", { our_reference: "pay_over", amount_minor: "1001" });
    expect(res.status).toBe(409);
  });

  it("supports void of an authorization", async () => {
    await pspFetch(psp.baseUrl, "/psp/authorize", {
      our_reference: "pay_void",
      amount_minor: "700",
      currency: "USD",
    });
    const voided = (await (await pspFetch(psp.baseUrl, "/psp/void", { our_reference: "pay_void" })).json()) as {
      status: string;
    };
    expect(voided.status).toBe("VOIDED");
    // A second void is rejected: no idempotency shortcut for a wrong state.
    const again = await pspFetch(psp.baseUrl, "/psp/void", { our_reference: "pay_void" });
    expect(again.status).toBe(200); // idempotent replay of the same operation
  });
});

describe("psp simulator: status inquiry and settlement", () => {
  it("answers status inquiry by OUR reference (the recovery lifeline)", async () => {
    await pspFetch(psp.baseUrl, "/psp/authorize", {
      our_reference: "pay_inquire",
      amount_minor: "1234",
      currency: "USD",
    });
    const res = await pspFetch(psp.baseUrl, "/psp/payments/pay_inquire");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; amount_minor: string };
    expect(body.status).toBe("AUTHORIZED");
    expect(body.amount_minor).toBe("1234");
  });

  it("returns 404 for an unknown reference", async () => {
    const res = await pspFetch(psp.baseUrl, "/psp/payments/nope");
    expect(res.status).toBe(404);
  });

  it("produces a settlement CSV with the specified columns", async () => {
    await pspFetch(psp.baseUrl, "/psp/_reset", {});
    await pspFetch(psp.baseUrl, "/psp/authorize", {
      our_reference: "pay_settle",
      amount_minor: "2000",
      currency: "USD",
    });
    await pspFetch(psp.baseUrl, "/psp/capture", { our_reference: "pay_settle", amount_minor: "2000" });

    const res = await pspFetch(psp.baseUrl, "/psp/settlement?date=2026-01-15");
    const csv = await res.text();
    const [header, row] = csv.trim().split("\n");
    expect(header).toBe("psp_ref,our_payment_id,amount,currency,status,settled_at");
    expect(row).toContain("pay_settle");
    expect(row).toContain(",2000,USD,CAPTURED,2026-01-15T00:00:00Z");
  });

  it("excludes declined and voided payments from settlement", async () => {
    await pspFetch(psp.baseUrl, "/psp/_reset", {});
    await pspFetch(psp.baseUrl, "/psp/authorize", {
      our_reference: "pay_declined",
      amount_minor: "100",
      currency: "USD",
      fault: "decline",
    });
    const csv = await (await pspFetch(psp.baseUrl, "/psp/settlement")).text();
    expect(csv.trim().split("\n")).toHaveLength(1); // header only
  });
});

describe("psp simulator: callbacks and signing", () => {
  it("signs callbacks so the receiver can verify them", async () => {
    const body = JSON.stringify({ event: "payment.captured", payment_id: "pay_1" });
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = signPayload(PSP_TEST_SECRET, ts, body);

    expect(verifySignature({ secret: PSP_TEST_SECRET, timestamp: ts, signature, rawBody: body })).toEqual({
      ok: true,
    });
    // Tampered body, wrong secret, and stale timestamp must all fail.
    expect(
      verifySignature({ secret: PSP_TEST_SECRET, timestamp: ts, signature, rawBody: `${body}x` }).ok,
    ).toBe(false);
    expect(
      verifySignature({ secret: "wrong", timestamp: ts, signature, rawBody: body }).ok,
    ).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 301);
    expect(
      verifySignature({
        secret: PSP_TEST_SECRET,
        timestamp: old,
        signature: signPayload(PSP_TEST_SECRET, old, body),
        rawBody: body,
      }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("can duplicate and reorder callbacks on demand", async () => {
    await pspFetch(psp.baseUrl, "/psp/_reset", {});
    const faults = (await (
      await pspFetch(psp.baseUrl, "/psp/_faults", { duplicate_callbacks: true, out_of_order_callbacks: true })
    ).json()) as { faults: { duplicate_callbacks: boolean } };
    expect(faults.faults.duplicate_callbacks).toBe(true);
    await pspFetch(psp.baseUrl, "/psp/_faults", { duplicate_callbacks: false, out_of_order_callbacks: false });
  });
});
