import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Express } from "express";
import pg from "pg";
import { createTestApp, resetDatabase, type TestApp } from "../support/test-context";
import { LedgerService } from "../../src/modules/ledger/ledger.service";

let ctx: TestApp;
let app: Express;
let pool: pg.Pool;
let ledger: LedgerService;

let merchantId: string;
let apiKey: string;
let payableAccountId: string;

beforeAll(async () => {
  ctx = await createTestApp();
  app = ctx.app;
  pool = ctx.pool;
  ledger = new LedgerService(pool);
});

afterAll(async () => {
  await ctx.dispose();
});

beforeEach(async () => {
  await resetDatabase(pool);
  const res = await request(app)
    .post("/v1/merchants")
    .send({ name: "Ledger Co", email: "ledger@example.com", default_currency: "USD" });
  merchantId = res.body.merchant.id;
  apiKey = res.body.apiKey.api_key;
  const account = await pool.query<{ id: string }>(
    "SELECT id FROM accounts WHERE merchant_id = $1 AND code = 'MERCHANT_PAYABLE'",
    [merchantId],
  );
  payableAccountId = account.rows[0]!.id;
});

const balanceOf = async (accountId: string): Promise<bigint> => {
  const res = await pool.query<{ balance_minor: string }>(
    "SELECT balance_minor FROM account_balances WHERE account_id = $1",
    [accountId],
  );
  return BigInt(res.rows[0]!.balance_minor);
};
const accountIdOf = async (code: string, currency = "USD"): Promise<string> => {
  const res = await pool.query<{ id: string }>(
    "SELECT id FROM accounts WHERE code = $1 AND currency = $2 AND merchant_id IS NULL",
    [code, currency],
  );
  return res.rows[0]!.id;
};

const captureOnce = async (paymentId: string, gross: bigint) =>
  ledger.inTransaction((client, service) =>
    service.postCapture(client, { merchantId, paymentId, currency: "USD", gross }),
  );

describe("ledger posting: capture", () => {
  it("debits clearing and credits payable + fee revenue, balanced", async () => {
    const result = await captureOnce("pay_1", 1050n);
    expect(result.posted).toBe(true);

    const clearing = await accountIdOf("PSP_CLEARING");
    const fee = await accountIdOf("FEE_REVENUE");

    expect(await balanceOf(clearing)).toBe(1050n);
    expect(await balanceOf(payableAccountId)).toBe(1029n); // 10.50 - 0.21
    expect(await balanceOf(fee)).toBe(21n);

    // The three legs add up: gross = net + fee.
    expect(await balanceOf(payableAccountId) + (await balanceOf(fee))).toBe(1050n);
  });

  it("sums debits and credits to the same total in the database", async () => {
    await captureOnce("pay_2", 999n);
    const { rows } = await pool.query<{ debits: string; credits: string }>(
      `SELECT SUM(amount_minor) FILTER (WHERE direction='DEBIT')  AS debits,
              SUM(amount_minor) FILTER (WHERE direction='CREDIT') AS credits
         FROM ledger_entries`,
    );
    expect(rows[0]!.debits).toBe(rows[0]!.credits);
    expect(rows[0]!.debits).toBe("999");
  });

  it("skips the zero-fee line instead of inserting amount 0", async () => {
    // 49 minor units -> 2% = 0.98 -> floor 0. Only two legs, still balanced.
    await captureOnce("pay_3", 49n);
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id",
    );
    expect(rows[0]!.count).toBe("2");
    expect(await balanceOf(payableAccountId)).toBe(49n);
  });

  it("rejects a capture with zero or negative amount before touching the database", async () => {
    await expect(captureOnce("pay_4", 0n)).rejects.toThrow(/positive/);
    await expect(captureOnce("pay_5", -100n)).rejects.toThrow(/positive/);
    const { rows } = await pool.query("SELECT count(*) FROM ledger_transactions");
    expect(rows[0]!.count).toBe("0");
  });
});

describe("ledger posting: retry safety", () => {
  it("a retried capture is a no-op, money is posted exactly once", async () => {
    const first = await captureOnce("pay_retry", 1000n);
    const second = await captureOnce("pay_retry", 1000n);
    const third = await captureOnce("pay_retry", 1000n);

    expect(first.posted).toBe(true);
    expect(second.posted).toBe(false);
    expect(third.posted).toBe(false);

    expect(await balanceOf(payableAccountId)).toBe(980n);
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM ledger_transactions WHERE payment_id = 'pay_retry'",
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("concurrent identical captures still post once (unique index + transaction)", async () => {
    const attempts = 10;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => captureOnce("pay_race", 500n)),
    );

    const posted = results.filter((r) => r.status === "fulfilled" && r.value.posted).length;
    expect(posted).toBe(1);

    // 500 * 2% = 10 fee, 490 net.
    expect(await balanceOf(payableAccountId)).toBe(490n);
    const { rows } = await pool.query<{ count: string }>(
      "SELECT count(*) FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.payment_id = 'pay_race'",
    );
    expect(rows[0]!.count).toBe("3");
  });
});

describe("ledger posting: refund", () => {
  it("mirrors the capture and nets to zero after a full refund", async () => {
    await captureOnce("pay_ref", 1000n);
    await ledger.inTransaction((client, service) =>
      service.postRefund(client, {
        merchantId,
        paymentId: "pay_ref",
        currency: "USD",
        refund: 1000n,
        feeReversal: 20n,
        sequence: 1,
      }),
    );

    expect(await balanceOf(await accountIdOf("PSP_CLEARING"))).toBe(0n);
    expect(await balanceOf(await accountIdOf("FEE_REVENUE"))).toBe(0n);
    expect(await balanceOf(payableAccountId)).toBe(0n);
  });

  it("partial refunds leave the correct residual balances", async () => {
    await captureOnce("pay_partial", 1000n); // fee 20, net 980
    await ledger.inTransaction((client, service) =>
      service.postRefund(client, {
        merchantId,
        paymentId: "pay_partial",
        currency: "USD",
        refund: 400n,
        feeReversal: 8n,
        sequence: 1,
      }),
    );

    expect(await balanceOf(payableAccountId)).toBe(980n - 392n); // 588
    expect(await balanceOf(await accountIdOf("FEE_REVENUE"))).toBe(12n);
    expect(await balanceOf(await accountIdOf("PSP_CLEARING"))).toBe(600n);
  });

  it("a retried refund (same sequence) is a no-op", async () => {
    await captureOnce("pay_ref2", 1000n);
    const doRefund = () =>
      ledger.inTransaction((client, service) =>
        service.postRefund(client, {
          merchantId,
          paymentId: "pay_ref2",
          currency: "USD",
          refund: 300n,
          feeReversal: 6n,
          sequence: 1,
        }),
      );

    expect((await doRefund()).posted).toBe(true);
    expect((await doRefund()).posted).toBe(false);
    expect(await balanceOf(payableAccountId)).toBe(980n - 294n);
  });

  it("a second refund with sequence 2 is a new posting", async () => {
    await captureOnce("pay_ref3", 1000n);
    const refund = (sequence: number) =>
      ledger.inTransaction((client, service) =>
        service.postRefund(client, {
          merchantId,
          paymentId: "pay_ref3",
          currency: "USD",
          refund: 300n,
          feeReversal: 6n,
          sequence,
        }),
      );
    expect((await refund(1)).posted).toBe(true);
    expect((await refund(2)).posted).toBe(true);
    expect(await balanceOf(await accountIdOf("PSP_CLEARING"))).toBe(400n);
  });
});

describe("database invariants are enforced even if app code is wrong", () => {
  it("rejects an unbalanced posting at COMMIT", async () => {
    const clearing = await accountIdOf("PSP_CLEARING");
    await expect(
      ledger.inTransaction(async (client) => {
        await client.query(
          `INSERT INTO ledger_transactions (id, kind, merchant_id, payment_id, currency, amount_minor, description)
           VALUES ('bad1','CAPTURE',$1,'pay_bad','USD',1000,'bad')`,
          [merchantId],
        );
        await client.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency)
           VALUES ('bad1', $1, 'DEBIT', 1000, 'USD')`,
          [clearing],
        );
        // missing the credit side on purpose
      }),
    ).rejects.toThrow(/unbalanced/i);

    const { rows } = await pool.query("SELECT count(*) FROM ledger_transactions");
    expect(rows[0]!.count).toBe("0");
  });

  it("rejects UPDATE and DELETE on entries (append-only)", async () => {
    await captureOnce("pay_immutable", 100n);
    await expect(pool.query("UPDATE ledger_entries SET amount_minor = 1")).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query("DELETE FROM ledger_entries")).rejects.toThrow(/append-only/);
    await expect(pool.query("UPDATE ledger_transactions SET description = 'x'")).rejects.toThrow(
      /append-only/,
    );
  });

  it("rejects a negative entry amount", async () => {
    const clearing = await accountIdOf("PSP_CLEARING");
    await expect(
      ledger.inTransaction(async (client) => {
        await client.query(
          `INSERT INTO ledger_transactions (id, kind, merchant_id, payment_id, currency, amount_minor, description)
           VALUES ('bad2','CAPTURE',$1,'pay_neg','USD',100,'bad')`,
          [merchantId],
        );
        await client.query(
          `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, currency)
           VALUES ('bad2', $1, 'DEBIT', -100, 'USD')`,
          [clearing],
        );
      }),
    ).rejects.toThrow(/amount_check|positive/i);
  });
});

describe("ledger read API", () => {
  it("returns accounts with derived balances for the tenant", async () => {
    await captureOnce("pay_api", 1000n);
    const res = await request(app).get("/v1/accounts").set("authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    const payable = res.body.accounts.find((a: { code: string }) => a.code === "MERCHANT_PAYABLE");
    expect(payable.balance_minor).toBe("980");
  });

  it("returns a paginated statement, newest first", async () => {
    await captureOnce("pay_stmt1", 1000n);
    await captureOnce("pay_stmt2", 2000n);
    await captureOnce("pay_stmt3", 3000n);

    const first = await request(app)
      .get(`/v1/accounts/${payableAccountId}/ledger?limit=1`)
      .set("authorization", `Bearer ${apiKey}`);
    expect(first.status).toBe(200);
    expect(first.body.entries).toHaveLength(1);
    // Newest first: capture 3000 -> fee 60 -> net 2940 to MERCHANT_PAYABLE.
    expect(first.body.entries[0].amount_minor).toBe("2940");
    expect(first.body.next_cursor).toBeTruthy();

    const second = await request(app)
      .get(`/v1/accounts/${payableAccountId}/ledger?limit=1&cursor=${first.body.next_cursor}`)
      .set("authorization", `Bearer ${apiKey}`);
    expect(second.status).toBe(200);
    expect(second.body.entries[0].amount_minor).toBe("1960");
    expect(second.body.next_cursor).toBeTruthy();

    const third = await request(app)
      .get(`/v1/accounts/${payableAccountId}/ledger?limit=1&cursor=${second.body.next_cursor}`)
      .set("authorization", `Bearer ${apiKey}`);
    expect(third.body.entries[0].amount_minor).toBe("980");
    expect(third.body.next_cursor).toBeNull();
  });

  it("hides another tenant's account behind a 404", async () => {
    const other = await request(app)
      .post("/v1/merchants")
      .send({ name: "Other", email: "other@example.com", default_currency: "USD" });
    const otherAccount = await pool.query<{ id: string }>(
      "SELECT id FROM accounts WHERE merchant_id = $1",
      [other.body.merchant.id],
    );

    const res = await request(app)
      .get(`/v1/accounts/${otherAccount.rows[0]!.id}/ledger`)
      .set("authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("cannot read a system account's ledger through the tenant API", async () => {
    const clearing = await accountIdOf("PSP_CLEARING");
    const res = await request(app)
      .get(`/v1/accounts/${clearing}/ledger`)
      .set("authorization", `Bearer ${apiKey}`)
      .set("x-clearwell-platform", "true"); // header must be ignored, not trusted
    expect(res.status).toBe(404);
  });

  it("validates query parameters", async () => {
    const res = await request(app)
      .get(`/v1/accounts/${payableAccountId}/ledger?limit=9999`)
      .set("authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires the ledger:read scope", async () => {
    const limited = await request(app)
      .post("/v1/merchants/me/api-keys")
      .set("authorization", `Bearer ${apiKey}`)
      .send({ label: "payments only", scopes: ["payments:write"] });
    const res = await request(app)
      .get("/v1/accounts")
      .set("authorization", `Bearer ${limited.body.api_key}`);
    expect(res.status).toBe(403);
  });
});
