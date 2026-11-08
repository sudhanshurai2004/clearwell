import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import pg from "pg";
import { createTestApp, resetDatabase, type TestApp } from "../support/test-context";
import { startPspHarness, type PspHarness } from "../support/psp-harness";

/**
 * End-to-end payment tests against the REAL simulator over real HTTP:
 * real sockets, real timeouts, real idempotency on the provider side.
 */
let ctx: TestApp;
let psp: PspHarness;
let app: Express;
let pool: pg.Pool;
let apiKey: string;
let merchantId: string;

beforeAll(async () => {
  psp = await startPspHarness({ timeoutMs: 400 });
  ctx = await createTestApp({ pspClient: psp.client });
  app = ctx.app;
  pool = ctx.pool;
});

afterAll(async () => {
  await ctx.dispose();
  await psp.close();
});

beforeEach(async () => {
  await resetDatabase(pool);
  await fetch(`${psp.baseUrl}/psp/_reset`, { method: "POST" });
  const res = await request(app)
    .post("/v1/merchants")
    .send({ name: "Payments Co", email: "pay@example.com", default_currency: "USD" });
  apiKey = res.body.apiKey.api_key;
  merchantId = res.body.merchant.id;
});

const auth = () => ({ authorization: `Bearer ${apiKey}` });
const createPayment = (body: Record<string, unknown> = {}) =>
  request(app)
    .post("/v1/payments")
    .set(auth())
    .send({ amount_minor: "1000", currency: "USD", ...body });

const balance = async (code: string): Promise<bigint> => {
  const res = await pool.query<{ balance_minor: string }>(
    `SELECT balance_minor FROM account_balances
      WHERE (code = $1 AND merchant_id IS NULL) OR (code = $1 AND merchant_id = $2)
      ORDER BY is_system DESC LIMIT 1`,
    [code, merchantId],
  );
  return BigInt(res.rows[0]?.balance_minor ?? "0");
};

describe("authorize", () => {
  it("creates a payment, calls the provider and lands in AUTHORIZED", async () => {
    const res = await createPayment();
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("AUTHORIZED");
    expect(res.body.authorized_amount_minor).toBe("1000");
    expect(res.body.psp_ref).toMatch(/^psp_/);
    // Authorization writes NO ledger entries -- money has not moved yet.
    const entries = await pool.query("SELECT count(*) FROM ledger_entries");
    expect(entries.rows[0].count).toBe("0");

    const events = await pool.query<{ event_type: string; to_status: string }>(
      "SELECT event_type, to_status FROM payment_events ORDER BY id",
    );
    expect(events.rows.map((e) => e.event_type)).toEqual(["PAYMENT_CREATED", "AUTHORIZED"]);
  });

  it("commits AUTH_PENDING before calling the provider", async () => {
    // The provider is slow (300ms). If we held the transaction open, the
    // payment row would be invisible/locked; instead it must already be
    // AUTH_PENDING while the call is in flight.
    await fetch(`${psp.baseUrl}/psp/_faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ latency_ms: 300 }),
    });

    // NOTE: supertest's Test is a lazy thenable -- the HTTP request only starts
    // when it is awaited. Calling .then() here is what actually fires it, so we
    // can inspect the database while it is in flight.
    const pending = createPayment({ amount_minor: "2500" }).then((r) => r);
    await new Promise((r) => setTimeout(r, 150));

    const inFlight = await pool.query<{ status: string }>("SELECT status FROM payments");
    expect(inFlight.rows).toHaveLength(1);
    expect(inFlight.rows[0]?.status).toBe("AUTH_PENDING");

    const done = await pending;
    expect(done.body.status).toBe("AUTHORIZED");
    await fetch(`${psp.baseUrl}/psp/_faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ latency_ms: 0 }),
    });
  });

  it("marks a provider decline as DECLINED", async () => {
    const res = await createPayment({ simulate: "decline" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DECLINED");
    expect(res.body.decline_code).toBe("card_declined");
  });

  it("marks a provider timeout as UNKNOWN, never DECLINED", async () => {
    const res = await createPayment({ simulate: "timeout" });
    // 202: accepted, not settled. The body reports the honest state.
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("UNKNOWN");

    const events = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM payment_events ORDER BY id",
    );
    expect(events.rows.map((e) => e.event_type)).toContain("AUTHORIZE_OUTCOME_UNKNOWN");
    expect(events.rows.map((e) => e.event_type)).not.toContain("DECLINED");

    // The provider DID authorise it -- which is exactly why UNKNOWN matters.
    const inquiry = await fetch(`${psp.baseUrl}/psp/payments/${res.body.id}`).then((r) => r.json());
    expect(inquiry.status).toBe("AUTHORIZED");
  }, 20_000);

  it("records every provider call in psp_transactions, including timeouts", async () => {
    await createPayment({ simulate: "timeout" });
    const rows = await pool.query<{ operation: string; outcome: string; latency_ms: number }>(
      "SELECT operation, outcome, latency_ms FROM psp_transactions",
    );
    expect(rows.rows[0]?.operation).toBe("AUTHORIZE");
    expect(rows.rows[0]?.outcome).toBe("TIMEOUT");
    expect(rows.rows[0]?.latency_ms).toBeGreaterThan(0);
  }, 20_000);

  it("rejects invalid amounts without calling the provider", async () => {
    for (const amount of ["10.50", "-100", "0", "abc"]) {
      const res = await createPayment({ amount_minor: amount });
      expect(res.status, `amount ${amount}`).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    expect(psp.store.all()).toHaveLength(0);
    expect((await pool.query("SELECT count(*) FROM payments")).rows[0].count).toBe("0");
  });

  it("requires the payments:write scope", async () => {
    const readOnly = await request(app)
      .post("/v1/merchants/me/api-keys")
      .set(auth())
      .send({ label: "ro", scopes: ["payments:read"] });
    const res = await request(app)
      .post("/v1/payments")
      .set("authorization", `Bearer ${readOnly.body.api_key}`)
      .send({ amount_minor: "1000", currency: "USD" });
    expect(res.status).toBe(403);
  });
});

describe("capture", () => {
  const authorize = async (amount = "1000") => {
    const res = await createPayment({ amount_minor: amount });
    return res.body as { id: string };
  };

  it("captures an authorized payment, posting the ledger in the same transaction", async () => {
    const payment = await authorize("1050");
    const res = await request(app).post(`/v1/payments/${payment.id}/capture`).set(auth()).send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CAPTURED");
    expect(res.body.captured_amount_minor).toBe("1050");

    // 1050 gross: 21 fee (2%), 1029 net.
    expect(await balance("PSP_CLEARING")).toBe(1050n);
    expect(await balance("MERCHANT_PAYABLE")).toBe(1029n);
    expect(await balance("FEE_REVENUE")).toBe(21n);

    const tx = await pool.query<{ kind: string; amount_minor: string }>(
      "SELECT kind, amount_minor FROM ledger_transactions",
    );
    expect(tx.rows).toEqual([{ kind: "CAPTURE", amount_minor: "1050" }]);
  });

  it("supports a partial capture and leaves the rest authorized", async () => {
    const payment = await authorize("1000");
    const res = await request(app)
      .post(`/v1/payments/${payment.id}/capture`)
      .set(auth())
      .send({ amount_minor: "400" });
    expect(res.status).toBe(200);
    expect(res.body.captured_amount_minor).toBe("400");
    expect(res.body.authorized_amount_minor).toBe("1000");
    expect(await balance("MERCHANT_PAYABLE")).toBe(392n);
  });

  it("rejects capturing more than authorized", async () => {
    const payment = await authorize("1000");
    const res = await request(app)
      .post(`/v1/payments/${payment.id}/capture`)
      .set(auth())
      .send({ amount_minor: "1001" });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain("exceeds the authorised");
  });

  it("rejects capturing twice (double capture is impossible)", async () => {
    const payment = await authorize("1000");
    expect((await request(app).post(`/v1/payments/${payment.id}/capture`).set(auth()).send({})).status).toBe(200);
    const second = await request(app).post(`/v1/payments/${payment.id}/capture`).set(auth()).send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
    expect(second.body.error.message).toContain("Illegal payment transition");
    expect(await balance("MERCHANT_PAYABLE")).toBe(980n);
  });

  it("only lets ONE of two simultaneous captures win", async () => {
    const payment = await authorize("1000");
    const results = await Promise.all([
      request(app).post(`/v1/payments/${payment.id}/capture`).set(auth()).send({}),
      request(app).post(`/v1/payments/${payment.id}/capture`).set(auth()).send({}),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await balance("MERCHANT_PAYABLE")).toBe(980n);
    const entries = await pool.query("SELECT count(*) FROM ledger_entries");
    expect(entries.rows[0].count).toBe("3"); // exactly one capture posting
  });

  it("requires the payment to be authorized", async () => {
    const res = await createPayment({ simulate: "decline" });
    const capture = await request(app).post(`/v1/payments/${res.body.id}/capture`).set(auth()).send({});
    expect(capture.status).toBe(409);
  });

  it("returns 404 for another tenant's payment", async () => {
    const payment = await authorize();
    const other = await request(app)
      .post("/v1/merchants")
      .send({ name: "Other", email: "other@example.com", default_currency: "USD" });
    const res = await request(app)
      .post(`/v1/payments/${payment.id}/capture`)
      .set("authorization", `Bearer ${other.body.apiKey.api_key}`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("void", () => {
  it("voids an authorized payment and writes no ledger entries", async () => {
    const created = await createPayment();
    const res = await request(app).post(`/v1/payments/${created.body.id}/void`).set(auth()).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("VOIDED");
    expect((await pool.query("SELECT count(*) FROM ledger_entries")).rows[0].count).toBe("0");
  });

  it("cannot void a captured payment", async () => {
    const created = await createPayment();
    await request(app).post(`/v1/payments/${created.body.id}/capture`).set(auth()).send({});
    const res = await request(app).post(`/v1/payments/${created.body.id}/void`).set(auth()).send({});
    expect(res.status).toBe(409);
  });
});

describe("refunds", () => {
  const captured = async (amount = "1000") => {
    const created = await createPayment({ amount_minor: amount });
    await request(app).post(`/v1/payments/${created.body.id}/capture`).set(auth()).send({});
    return created.body.id as string;
  };

  it("refunds fully, reversing the fee, and nets every account to zero", async () => {
    const id = await captured("1000");
    const res = await request(app)
      .post(`/v1/payments/${id}/refunds`)
      .set(auth())
      .send({ amount_minor: "1000" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("REFUNDED");
    expect(res.body.refunded_amount_minor).toBe("1000");
    expect(await balance("MERCHANT_PAYABLE")).toBe(0n);
    expect(await balance("FEE_REVENUE")).toBe(0n);
    expect(await balance("PSP_CLEARING")).toBe(0n);
  });

  it("handles partial refunds with proportional fee reversal", async () => {
    const id = await captured("1000"); // fee 20
    const res = await request(app)
      .post(`/v1/payments/${id}/refunds`)
      .set(auth())
      .send({ amount_minor: "400" });

    expect(res.body.status).toBe("PARTIALLY_REFUNDED");
    // fee reversal = floor(20 * 400 / 1000) = 8
    expect(await balance("MERCHANT_PAYABLE")).toBe(980n - 392n);
    expect(await balance("FEE_REVENUE")).toBe(12n);
    expect(await balance("PSP_CLEARING")).toBe(600n);
  });

  it("refunds cannot exceed the captured amount", async () => {
    const id = await captured("1000");
    const res = await request(app)
      .post(`/v1/payments/${id}/refunds`)
      .set(auth())
      .send({ amount_minor: "1001" });
    expect(res.status).toBe(422);
  });

  it("cannot refund an authorized-only payment", async () => {
    const created = await createPayment();
    const res = await request(app)
      .post(`/v1/payments/${created.body.id}/refunds`)
      .set(auth())
      .send({ amount_minor: "100" });
    expect(res.status).toBe(409);
  });

  it("blocks concurrent refunds that would together exceed the captured amount", async () => {
    const id = await captured("1000");
    const results = await Promise.all([
      request(app).post(`/v1/payments/${id}/refunds`).set(auth()).send({ amount_minor: "600" }),
      request(app).post(`/v1/payments/${id}/refunds`).set(auth()).send({ amount_minor: "600" }),
    ]);

    const ok = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status >= 400);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.status).toBe(422);

    // Money check: never more than captured was refunded, and the ledger agrees.
    const payment = await pool.query<{ refunded_amount: string; refund_reserved_minor: string }>(
      "SELECT refunded_amount, refund_reserved_minor FROM payments WHERE id = $1",
      [id],
    );
    expect(BigInt(payment.rows[0]!.refunded_amount)).toBeLessThanOrEqual(1000n);
    expect(payment.rows[0]!.refund_reserved_minor).toBe("0");
    expect(await balance("MERCHANT_PAYABLE")).toBe(980n - 600n + 12n);
  });

  it("supports repeated partial refunds up to the captured amount", async () => {
    const id = await captured("1000");
    await request(app).post(`/v1/payments/${id}/refunds`).set(auth()).send({ amount_minor: "400" });
    await request(app).post(`/v1/payments/${id}/refunds`).set(auth()).send({ amount_minor: "600" });

    const final = await request(app).get(`/v1/payments/${id}`).set(auth());
    expect(final.body.status).toBe("REFUNDED");
    expect(await balance("MERCHANT_PAYABLE")).toBe(0n);
    expect(await balance("FEE_REVENUE")).toBe(0n);
  });
});

describe("reads and audit trail", () => {
  it("lists payments for the tenant only, newest first", async () => {
    await createPayment({ amount_minor: "100" });
    await createPayment({ amount_minor: "200" });
    const other = await request(app)
      .post("/v1/merchants")
      .send({ name: "Other", email: "other2@example.com", default_currency: "USD" });
    await request(app)
      .post("/v1/payments")
      .set("authorization", `Bearer ${other.body.apiKey.api_key}`)
      .send({ amount_minor: "300", currency: "USD" });

    const res = await request(app).get("/v1/payments").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    expect(res.body.payments[0].amount_minor).toBe("200");
  });

  it("exposes the full event history, and it is append-only", async () => {
    const created = await createPayment();
    await request(app).post(`/v1/payments/${created.body.id}/capture`).set(auth()).send({});

    const res = await request(app).get(`/v1/payments/${created.body.id}/events`).set(auth());
    expect(res.body.events.map((e: { event_type: string }) => e.event_type)).toEqual([
      "PAYMENT_CREATED",
      "AUTHORIZED",
      "CAPTURE_REQUESTED",
      "CAPTURED",
    ]);

    await expect(pool.query("UPDATE payment_events SET event_type = 'x'")).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM payment_events")).rejects.toThrow(/append-only/);
  });

  it("returns 404 for an unknown payment", async () => {
    const res = await request(app).get("/v1/payments/does-not-exist").set(auth());
    expect(res.status).toBe(404);
  });
});
