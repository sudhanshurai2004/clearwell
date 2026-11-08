import { readFileSync } from "node:fs";
import type { Express } from "express";
import pg from "pg";
import { createApp } from "../../src/app";
import type { PspOutcome } from "../../src/modules/payment/psp/psp-client";
import { createLogger } from "../../src/modules/common/logger";
import { HttpPspClient } from "../../src/modules/payment/psp/http-psp-client";
import type { PspClient } from "../../src/modules/payment/psp/psp-client";

export const TEST_API_KEY_SECRET = "test-api-key-hash-secret";

/**
 * Resolves the test database URL written by globalSetup.
 *
 * Integration tests call this in beforeAll, so a missing database surfaces as a
 * clear per-suite failure with the real reason -- never a silent skip.
 */
let cachedUrl: string | undefined;

export async function resolveTestDatabaseUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl;

  const stateFile = process.env.CLEARWELL_TEST_STATE_FILE;
  if (stateFile) {
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as {
      status: "ready" | "unavailable";
      url?: string;
      error?: string;
    };
    if (state.status === "ready" && state.url) {
      cachedUrl = state.url;
      return cachedUrl;
    }
    throw new Error(`Integration tests need PostgreSQL, but none could be started:\n${state.error}`);
  }

  // Running this file directly (not through the suite): start a throwaway DB.
  const { startTestDatabase, migrateTestDatabase } = await import("./postgres");
  const started = await startTestDatabase();
  await migrateTestDatabase(started.url);
  cachedUrl = started.url;
  return cachedUrl;
}

export type TestApp = {
  readonly app: Express;
  readonly pool: pg.Pool;
  readonly url: string;
  dispose: () => Promise<void>;
};

/**
 * A fake PspClient whose behaviour each test controls. Used where the point of
 * the test is OUR logic (state machine, ledger sums) rather than the network.
 */
export class ScriptedPspClient implements PspClient {
  public calls: string[] = [];
  public authorizeOutcome: PspOutcome<{ pspRef: string; status: "AUTHORIZED" | "DECLINED"; declineCode?: string }> = {
    kind: "SUCCESS",
    data: { pspRef: "psp_test_1", status: "AUTHORIZED" },
    raw: {},
    latencyMs: 1,
  };
  public captureOutcome: PspOutcome<{ pspRef: string; capturedAmount: bigint; status: "CAPTURED" }> = {
    kind: "SUCCESS",
    data: { pspRef: "psp_test_1", capturedAmount: 0n, status: "CAPTURED" },
    raw: {},
    latencyMs: 1,
  };
  public refundOutcome: PspOutcome<{ refundedAmount: bigint; status: "REFUNDED" | "PARTIALLY_REFUNDED" }> = {
    kind: "SUCCESS",
    data: { refundedAmount: 0n, status: "PARTIALLY_REFUNDED" },
    raw: {},
    latencyMs: 1,
  };
  public voidOutcome: PspOutcome<{ status: "VOIDED" }> = { kind: "SUCCESS", data: { status: "VOIDED" }, raw: {}, latencyMs: 1 };

  async authorize(request: { amount: bigint }) {
    this.calls.push(`authorize:${request.amount}`);
    return this.authorizeOutcome;
  }
  async capture(request: { amount: bigint }) {
    this.calls.push(`capture:${request.amount}`);
    return this.captureOutcome;
  }
  async void() {
    this.calls.push("void");
    return this.voidOutcome;
  }
  async refund(request: { amount: bigint }) {
    this.calls.push(`refund:${request.amount}`);
    return this.refundOutcome;
  }
  async inquire() {
    this.calls.push("inquire");
    return { kind: "ERROR" as const, message: "not implemented", latencyMs: 1 };
  }
}

/**
 * Builds the real Express app against the real test database. No route is
 * faked -- these are integration tests, which is the only way an idempotency
 * or locking bug shows up.
 */
export async function createTestApp(options: { pspClient?: PspClient } = {}): Promise<TestApp> {
  const url = await resolveTestDatabaseUrl();
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const logger = createLogger("silent", false);
  // Default: a provider that always approves instantly. Suites that care about
  // provider behaviour pass their own real simulator harness instead.
  const pspClient =
    options.pspClient ??
    (new HttpPspClient({
      baseUrl: "http://127.0.0.1:9", // unreachable on purpose; replaced per suite
      timeoutMs: 50,
      logger,
    }) as unknown as PspClient);
  const app = createApp({
    logger,
    pool,
    apiKeyHashSecret: TEST_API_KEY_SECRET,
    nodeEnv: "test",
    pspClient,
  });
  return {
    app,
    pool,
    url,
    dispose: async () => {
      await pool.end();
    },
  };
}

/**
 * Cleans the database between tests. Runs a single TRUNCATE over every table we
 * create, then re-seeds the system accounts, so each test starts from the same
 * known state. CASCADE + FORCE-free TRUNCATE is safe because tests are serial.
 */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
  if (tables.length > 0) {
    await pool.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
  if (rows.some((r) => r.tablename === "accounts")) {
    await pool.query(
      `INSERT INTO accounts (id, merchant_id, code, name, type, currency, is_system) VALUES
         ('00000000000000000000000001', NULL, 'PSP_CLEARING', 'PSP clearing', 'ASSET',   'USD', true),
         ('00000000000000000000000002', NULL, 'FEE_REVENUE',  'Platform fee', 'REVENUE', 'USD', true),
         ('00000000000000000000000003', NULL, 'PSP_CLEARING', 'PSP clearing', 'ASSET',   'INR', true),
         ('00000000000000000000000004', NULL, 'FEE_REVENUE',  'Platform fee', 'REVENUE', 'INR', true)
       ON CONFLICT DO NOTHING`,
    );
  }
}

/** Removes a stray database left behind by a crashed run (defensive, best effort). */
export function dropStrayDatabases(url: string, prefix = "cw_test_"): void {
  try {
    const parsed = new URL(url);
    const dbName = parsed.pathname.replace(/^\//, "");
    if (!dbName.startsWith(prefix)) return;
    const admin = new URL(url);
    admin.pathname = "/postgres";
    execFileSync("psql", [admin.toString(), "-c", `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`], {
      stdio: "ignore",
    });
  } catch {
    // psql may not exist; purely a hygiene helper.
  }
}
