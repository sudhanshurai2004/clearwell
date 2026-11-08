import { Pool, types } from "pg";
import { config } from "./config";

// Configure pg to parse Postgres BIGINT (INT8, OID 20) as JavaScript BigInt
types.setTypeParser(20, (val: string) => (val === null ? null : BigInt(val)));

// Enable BigInt JSON serialization as string for API safety
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle PostgreSQL client", err);
});

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
