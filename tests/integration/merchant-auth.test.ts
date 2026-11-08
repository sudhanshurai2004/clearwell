import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import pg from "pg";
import { createTestApp, resetDatabase, type TestApp } from "../support/test-context";

let ctx: TestApp;
let app: Express;
let pool: pg.Pool;

beforeAll(async () => {
  ctx = await createTestApp();
  app = ctx.app;
  pool = ctx.pool;
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await resetDatabase(pool);
});

type Created = { merchant: { id: string; email: string }; apiKey: { api_key: string; key_prefix: string } };

async function createMerchant(email = "merchant@example.com"): Promise<Created> {
  const res = await request(app).post("/v1/merchants").send({
    name: "Acme Store",
    email,
    default_currency: "USD",
  });
  expect(res.status).toBe(201);
  return res.body as Created;
}

describe("POST /v1/merchants", () => {
  it("creates merchant + first api key + payable account atomically", async () => {
    const body = await createMerchant();

    expect(body.merchant.id).toMatch(/^[0-9a-v]{26}$/);
    expect(body.apiKey.api_key).toMatch(/^cw_test_[0-9a-f]{8}_[0-9a-f]{32}$/);
    expect(body.apiKey.key_prefix).toBe(body.apiKey.api_key.slice(0, 16));

    const accounts = await pool.query("SELECT code, type FROM accounts WHERE merchant_id = $1", [
      body.merchant.id,
    ]);
    expect(accounts.rows).toEqual([{ code: "MERCHANT_PAYABLE", type: "LIABILITY" }]);

    // The raw key must never be persisted, only its HMAC.
    const stored = await pool.query<{ key_hash: string }>(
      "SELECT key_hash FROM api_keys WHERE merchant_id = $1",
      [body.merchant.id],
    );
    expect(stored.rows[0]?.key_hash).not.toContain(body.apiKey.api_key);
    expect(stored.rows[0]?.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects invalid payloads with the standard envelope and field details", async () => {
    const res = await request(app)
      .post("/v1/merchants")
      .send({ name: "x", email: "not-an-email", default_currency: "usd" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.correlation_id).toBeTruthy();
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(["name", "email", "default_currency"]));
  });

  it("rejects a duplicate email with 422, not 500", async () => {
    await createMerchant("dupe@example.com");
    const res = await request(app)
      .post("/v1/merchants")
      .send({ name: "Other", email: "dupe@example.com", default_currency: "USD" });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain("already exists");
  });
});

describe("API key authentication", () => {
  it("accepts the issued key", async () => {
    const created = await createMerchant();
    const res = await request(app)
      .get("/v1/merchants/me")
      .set("authorization", `Bearer ${created.apiKey.api_key}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.merchant.id);
    expect(res.body.email).toBe("merchant@example.com");
  });

  it.each([
    ["no header", undefined],
    ["wrong scheme", "Basic abc"],
    ["garbage", "Bearer not-a-key"],
    ["truncated secret", "Bearer cw_test_00000000_00000000000000000000000000000000"],
  ])("rejects %s with 401", async (_label, header) => {
    const created = await createMerchant();
    const req = request(app).get("/v1/merchants/me");
    if (header) req.set("authorization", header);
    const res = await req;

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
    // The response must not reveal whether the prefix existed.
    expect(res.body.error.message).not.toMatch(/prefix|merchant/i);
    expect(created.merchant.id).toBeTruthy();
  });

  it("rejects a key whose secret was tampered with but prefix kept", async () => {
    const created = await createMerchant();
    const prefix = created.apiKey.api_key.slice(0, 16);
    const tampered = `${prefix}_${"0".repeat(32)}`;

    const res = await request(app).get("/v1/merchants/me").set("authorization", `Bearer ${tampered}`);
    expect(res.status).toBe(401);
  });

  it("rejects a revoked key with 401", async () => {
    const created = await createMerchant();
    await pool.query("UPDATE api_keys SET revoked_at = now() WHERE merchant_id = $1", [
      created.merchant.id,
    ]);
    const res = await request(app)
      .get("/v1/merchants/me")
      .set("authorization", `Bearer ${created.apiKey.api_key}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/revoked/i);
  });

  it("returns 403 when the merchant is suspended", async () => {
    const created = await createMerchant();
    await pool.query("UPDATE merchants SET status = 'SUSPENDED' WHERE id = $1", [
      created.merchant.id,
    ]);
    const res = await request(app)
      .get("/v1/merchants/me")
      .set("authorization", `Bearer ${created.apiKey.api_key}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("stores the key hash, never the raw key, in the database", async () => {
    const created = await createMerchant();
    const dump = await pool.query("SELECT * FROM api_keys");
    const serialised = JSON.stringify(dump.rows);
    expect(serialised).not.toContain(created.apiKey.api_key);
  });
});

describe("tenant isolation", () => {
  it("keeps each merchant scoped to its own identity via /merchants/me", async () => {
    const a = await createMerchant("a@example.com");
    const b = await createMerchant("b@example.com");

    const resA = await request(app)
      .get("/v1/merchants/me")
      .set("authorization", `Bearer ${a.apiKey.api_key}`);
    const resB = await request(app)
      .get("/v1/merchants/me")
      .set("authorization", `Bearer ${b.apiKey.api_key}`);

    expect(resA.body.id).toBe(a.merchant.id);
    expect(resB.body.id).toBe(b.merchant.id);
    expect(resA.body.id).not.toBe(resB.body.id);
  });

  it("issues an api key only for the authenticated merchant, not for an id in the body", async () => {
    const victim = await createMerchant("victim@example.com");
    const attacker = await createMerchant("attacker@example.com");

    const res = await request(app)
      .post("/v1/merchants/me/api-keys")
      .set("authorization", `Bearer ${attacker.apiKey.api_key}`)
      .send({ label: "mine", scopes: ["payments:read"], merchant_id: victim.merchant.id });

    // Zod strips unknown keys by default: the body merchant_id is ignored.
    expect(res.status).toBe(201);
    const owner = await pool.query<{ merchant_id: string }>(
      "SELECT merchant_id FROM api_keys WHERE key_prefix = $1",
      [res.body.key_prefix],
    );
    expect(owner.rows[0]?.merchant_id).toBe(attacker.merchant.id);
  });

  it("enforces scopes: a payments-only key cannot mint new keys", async () => {
    const owner = await createMerchant();
    const created = await request(app)
      .post("/v1/merchants/me/api-keys")
      .set("authorization", `Bearer ${owner.apiKey.api_key}`)
      .send({ label: "integration", scopes: ["payments:write", "payments:read"] });
    expect(created.status).toBe(201);

    const res = await request(app)
      .post("/v1/merchants/me/api-keys")
      .set("authorization", `Bearer ${created.body.api_key}`)
      .send({ label: "nested", scopes: ["admin:keys"] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("lets the owner key mint keys (credential rotation works)", async () => {
    const owner = await createMerchant();
    const res = await request(app)
      .post("/v1/merchants/me/api-keys")
      .set("authorization", `Bearer ${owner.apiKey.api_key}`)
      .send({ label: "rotated", scopes: ["payments:read"] });

    expect(res.status).toBe(201);
    expect(res.body.scopes).toEqual(["payments:read"]);
    expect(res.body.api_key).toMatch(/^cw_test_/);

    // The new key actually authenticates.
    const me = await request(app)
      .get("/v1/merchants/me")
      .set("authorization", `Bearer ${res.body.api_key}`);
    expect(me.status).toBe(200);
  });

  it("rejects unknown scopes at the edge", async () => {
    const owner = await createMerchant();
    const res = await request(app)
      .post("/v1/merchants/me/api-keys")
      .set("authorization", `Bearer ${owner.apiKey.api_key}`)
      .send({ label: "x", scopes: ["payments:write", "ledger:write"] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("error envelope and correlation ids", () => {
  it("uses the same envelope for 404s", async () => {
    const res = await request(app).get("/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: "NOT_FOUND" });
    expect(res.body.error.correlation_id).toBeTruthy();
  });

  it("echoes a valid inbound correlation id in header and body", async () => {
    const res = await request(app).get("/v1/does-not-exist").set("x-correlation-id", "corr-alpha-12345");
    expect(res.headers["x-correlation-id"]).toBe("corr-alpha-12345");
    expect(res.body.error.correlation_id).toBe("corr-alpha-12345");
  });

  it("replaces a suspicious inbound correlation id with a generated one", async () => {
    const res = await request(app).get("/v1/does-not-exist").set("x-correlation-id", "bad value!!");
    expect(res.headers["x-correlation-id"]).not.toBe("bad value!!");
    expect(res.headers["x-correlation-id"]).toMatch(/^[0-9a-v]{26}$/);
  });

  it("answers health and readiness separately", async () => {
    const live = await request(app).get("/healthz");
    expect(live.status).toBe(200);
    const ready = await request(app).get("/readyz");
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe("ready");
  });
});
