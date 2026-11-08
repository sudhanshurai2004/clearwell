import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import pg from "pg";
import { createTestApp, resetDatabase, type TestApp } from "../support/test-context";
import { startPspHarness, type PspHarness } from "../support/psp-harness";
import { canonicalJson, fingerprint, requestFingerprint } from "../../src/modules/common/idempotency";

/**
 * THE FAILURE SCENARIO THESE TESTS PROVE:
 *   the client sends a payment, we charge the customer, the connection drops
 *   before the response arrives, and the client retries. The customer must be
 *   charged exactly once in every one of those cases.
 */
let ctx: TestApp;
let psp: PspHarness;
let app: Express;
let pool: pg.Pool;
let apiKey: string;

beforeAll(async () => {
  // Generous provider timeout: these tests are about the idempotency lease, not
  // about the timeout contract (which payments.test.ts covers).
  psp = await startPspHarness({ timeoutMs: 5_000 });
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
    .send({ name: "Idem Co", email: "idem@example.com", default_currency: "USD" });
  apiKey = res.body.apiKey.api_key;
});

const create = (key: string, body: Record<string, unknown> = {}) =>
  request(app)
    .post("/v1/payments")
    .set("authorization", `Bearer ${apiKey}`)
    .set("idempotency-key", key)
    .send({ amount_minor: "1000", currency: "USD", ...body });

const paymentCount = async () =>
  Number((await pool.query<{ count: string }>("SELECT count(*) FROM payments")).rows[0]!.count);
const providerCharges = () => psp.store.all();

describe("fingerprinting", () => {
  it("is stable across key order and ignores undefined", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(fingerprint("POST", "/v1/payments", { a: 1, b: 2 })).toBe(
      fingerprint("post", "/v1/payments", { b: 2, a: 1 }),
    );
  });

  it("changes with method, path and body", () => {
    const base = fingerprint("POST", "/v1/payments", { amount_minor: "100" });
    expect(fingerprint("PUT", "/v1/payments", { amount_minor: "100" })).not.toBe(base);
    expect(fingerprint("POST", "/v1/payments/x", { amount_minor: "100" })).not.toBe(base);
    expect(fingerprint("POST", "/v1/payments", { amount_minor: "101" })).not.toBe(base);
  });
});

describe("required key", () => {
  it("rejects a mutating request without an Idempotency-Key", async () => {
    const res = await request(app)
      .post("/v1/payments")
      .set("authorization", `Bearer ${apiKey}`)
      .send({ amount_minor: "1000", currency: "USD" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details[0].field).toBe("Idempotency-Key");
    await expect(paymentCount()).resolves.toBe(0);
  });

  it("rejects a malformed key", async () => {
    const res = await create("short");
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Malformed");
  });
});

describe("replay", () => {
  it("replays the stored response without charging again", async () => {
    const first = await create("order-abc-12345");
    const second = await create("order-abc-12345");

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(first.headers["idempotent-replay"]).toBeUndefined();

    await expect(paymentCount()).resolves.toBe(1);
    expect(providerCharges()).toHaveLength(1);
  });

  it("rejects key reuse with a different body (422)", async () => {
    await create("order-def-12345", { amount_minor: "1000" });
    const res = await create("order-def-12345", { amount_minor: "2000" });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain("different request body");
    // The original payment is untouched; no second charge.
    await expect(paymentCount()).resolves.toBe(1);
    expect(providerCharges()).toHaveLength(1);
  });

  it("scopes keys per merchant: two tenants can use the same key value", async () => {
    const other = await request(app)
      .post("/v1/merchants")
      .send({ name: "Other Co", email: "other@example.com", default_currency: "USD" });

    const mine = await create("shared-key-12345");
    const theirs = await request(app)
      .post("/v1/payments")
      .set("authorization", `Bearer ${other.body.apiKey.api_key}`)
      .set("idempotency-key", "shared-key-12345")
      .send({ amount_minor: "1000", currency: "USD" });

    expect(mine.status).toBe(201);
    expect(theirs.status).toBe(201);
    expect(theirs.body.id).not.toBe(mine.body.id);
    expect(theirs.headers["idempotent-replay"]).toBeUndefined();
    await expect(paymentCount()).resolves.toBe(2);
  });

  it("replays on capture too, so a retried capture is not a 409", async () => {
    const created = await create("cap-key-123456");
    const capture = () =>
      request(app)
        .post(`/v1/payments/${created.body.id}/capture`)
        .set("authorization", `Bearer ${apiKey}`)
        .set("idempotency-key", "capture-key-123456")
        .send({});

    const first = await capture();
    const second = await capture();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.captured_amount_minor).toBe("1000");
    // One capture posting only.
    const entries = await pool.query("SELECT count(*) FROM ledger_entries");
    expect(entries.rows[0].count).toBe("3");
  });
});

describe("concurrency", () => {
  it("two simultaneous identical requests: one executes, one replays", async () => {
    const [a, b] = await Promise.all([create("race-key-123456"), create("race-key-123456")]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 201]);
    expect(a.body.id).toBe(b.body.id);
    await expect(paymentCount()).resolves.toBe(1);
    expect(providerCharges()).toHaveLength(1);
  });

  it("ten simultaneous identical requests still produce exactly one payment", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => create("storm-key-12345")),
    );
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    await expect(paymentCount()).resolves.toBe(1);
    expect(providerCharges()).toHaveLength(1);
    // Every response is either the original or a replay.
    expect(results.every((r) => r.status === 201)).toBe(true);
  });

  it("returns 409 while an identical request is still in flight", async () => {
    // Slow the provider so the first request holds the key for a while.
    await fetch(`${psp.baseUrl}/psp/_faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ latency_ms: 2_500 }),
    });

    const first = create("slow-key-123456").then((r) => r);
    await new Promise((r) => setTimeout(r, 100));
    const second = await create("slow-key-123456");
    const firstResponse = await first;

    expect(firstResponse.status).toBe(201);
    // The duplicate waited its 2s budget while the original was still running,
    // then gave up with 409 -- it must NOT silently start a second charge.
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    await expect(paymentCount()).resolves.toBe(1);

    await fetch(`${psp.baseUrl}/psp/_faults`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ latency_ms: 0 }),
    });
  });
});

describe("stale locks", () => {
  it("takes over an abandoned in-flight key instead of hanging forever", async () => {
    // Simulate a process that claimed the key and then died.
    const created = await create("stale-key-123456");
    const merchant = await pool.query<{ merchant_id: string }>(
      "SELECT merchant_id FROM payments WHERE id = $1",
      [created.body.id],
    );
    await pool.query(
      `INSERT INTO idempotency_keys (merchant_id, key, request_hash, method, path, status, locked_until)
       VALUES ($1, 'crashed-key-1234', 'deadbeef', 'POST', '/v1/payments', 'IN_PROGRESS', now() - interval '5 minutes')`,
      [merchant.rows[0]!.merchant_id],
    );

    // The stored hash is what production would compute for this request.
    // Our earlier seed was a placeholder, so first prove the body check works
    // by retrying with a DIFFERENT body -> 422 while the key is in progress.
    const differentBody = await create("crashed-key-1234", { amount_minor: "999" });
    expect(differentBody.status).toBe(422);

    const requestHash = requestFingerprint({
      method: "POST",
      originalUrl: "/v1/payments",
      body: { amount_minor: "1000", currency: "USD" },
    });
    await pool.query(
      `UPDATE idempotency_keys SET request_hash = $1 WHERE key = 'crashed-key-1234'`,
      [requestHash],
    );
    const taken = await create("crashed-key-1234");
    expect(taken.status).toBe(201);
    const row = await pool.query<{ status: string; attempts: number }>(
      "SELECT status, attempts FROM idempotency_keys WHERE key = 'crashed-key-1234'",
    );
    expect(row.rows[0]!.status).toBe("COMPLETED");
    expect(row.rows[0]!.attempts).toBeGreaterThan(1);
  });

  it("keeps a live lease and reports 409 rather than running twice", async () => {
    const created = await create("live-lease-1234");
    const merchant = await pool.query<{ merchant_id: string }>(
      "SELECT merchant_id FROM payments WHERE id = $1",
      [created.body.id],
    );
    const requestHash = requestFingerprint({
      method: "POST",
      originalUrl: "/v1/payments",
      body: { amount_minor: "1000", currency: "USD" },
    });
    await pool.query(
      `INSERT INTO idempotency_keys (merchant_id, key, request_hash, method, path, status, locked_until)
       VALUES ($1, 'busy-key-123456', $2, 'POST', '/v1/payments', 'IN_PROGRESS', now() + interval '1 minute')`,
      [merchant.rows[0]!.merchant_id, requestHash],
    );

    const res = await create("busy-key-123456");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    await expect(paymentCount()).resolves.toBe(1); // only the earlier payment
  });
});

describe("failed requests do not poison the key", () => {
  it("a validation failure can be retried with the same key", async () => {
    const bad = await create("retry-after-400", { amount_minor: "10.50" });
    expect(bad.status).toBe(400);

    const good = await create("retry-after-400", { amount_minor: "1050" });
    expect(good.status).toBe(201);
    expect(good.body.amount_minor).toBe("1050");
  });

  it("a provider failure can be retried with the same key", async () => {
    const timedOut = await create("retry-after-timeout", { simulate: "timeout" });
    expect(timedOut.status).toBe(202);
    expect(timedOut.body.status).toBe("UNKNOWN");

    // Same key, same body: this is a replay of the UNKNOWN outcome, not a new
    // charge -- exactly what the merchant needs to see.
    const replay = await create("retry-after-timeout", { simulate: "timeout" });
    expect(replay.status).toBe(202);
    expect(replay.body.id).toBe(timedOut.body.id);
    await expect(paymentCount()).resolves.toBe(1);
  });
});
