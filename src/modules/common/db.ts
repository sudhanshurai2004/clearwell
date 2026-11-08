import pg from "pg";
import type { Logger } from "./logger";

/**
 * Connection pool wrapper. We keep SQL access explicit (no ORM) because the
 * ledger depends on precise control: row locks, deferred constraints,
 * `FOR UPDATE SKIP LOCKED`. An ORM would hide exactly the things we care about.
 *
 * Money note: node-postgres returns BIGINT (int8) columns as STRINGS by default
 * because a JS number cannot represent values beyond 2^53. We keep that default
 * deliberately -- amounts stay strings on the way out and become `bigint`
 * explicitly at the domain boundary. Never parseInt a money column.
 */
export function createPool(connectionString: string, logger: Logger): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "clearwell-api",
  });

  pool.on("error", (err) => {
    // A pooled client failed while idle (e.g. database restarted). Log it; the
    // pool will create a fresh client for the next query.
    logger.error({ err }, "pg_pool_idle_error");
  });

  return pool;
}

export type Db = pg.Pool;

/**
 * Runs `fn` inside a single transaction, committing on success and rolling back
 * on any thrown error. Every ledger-critical write must go through this.
 *
 * Usage rule enforced later in the ledger module: fn must not perform network
 * I/O. A slow external call inside a transaction holds locks and connections.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection may already be dead; nothing useful to do.
    }
    throw err;
  } finally {
    client.release();
  }
}
