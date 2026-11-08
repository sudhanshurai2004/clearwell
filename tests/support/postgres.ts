import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";

const exec = promisify(execFile);

/**
 * Test database strategy.
 *
 * Preferred: Testcontainers spins up a throwaway PostgreSQL 16 container, so
 * tests are hermetic and never touch a developer's real data. This is the path
 * used on the user's Windows machine (Docker) and in CI.
 *
 * Fallback: if Docker is not reachable (e.g. this agent sandbox has no Docker),
 * we use TEST_DATABASE_URL when it is set. Every run gets its OWN database with
 * a random name and is dropped afterwards -- we never run tests against the
 * developer database, because tests truncate tables.
 *
 * Honesty note: the fallback is real PostgreSQL 16, not a mock. If neither is
 * available the suite fails loudly instead of pretending to pass.
 */
export type TestDatabase = {
  readonly url: string;
  readonly pool: pg.Pool;
  readonly close: () => Promise<void>;
};

export type StartedDatabase = TestDatabase;

export async function startTestDatabase(): Promise<StartedDatabase> {
  const externalUrl = process.env.TEST_DATABASE_URL;

  if (externalUrl) {
    const dbName = `cw_test_${Math.random().toString(36).slice(2, 10)}`;
    const adminUrl = new URL(externalUrl);
    const pool = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
    await pool.query(`CREATE DATABASE ${dbName}`);
    await pool.end();

    const testUrl = new URL(externalUrl);
    testUrl.pathname = `/${dbName}`;
    const testPool = new pg.Pool({ connectionString: testUrl.toString(), max: 5 });

    return {
      url: testUrl.toString(),
      pool: testPool,
      close: async () => {
        await testPool.end();
        const cleanup = new pg.Pool({ connectionString: adminUrl.toString(), max: 1 });
        await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await cleanup.end();
      },
    };
  }

  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("clearwell_test")
      .withUsername("clearwell")
      .withPassword("clearwell_test_password")
      .start();
  } catch (err) {
    throw new Error(
      [
        "Could not start PostgreSQL for tests.",
        "Either start Docker Desktop (Testcontainers needs it) or set TEST_DATABASE_URL",
        "to an existing PostgreSQL 16 server.",
        `Original error: ${(err as Error).message}`,
      ].join("\n"),
    );
  }

  const url = container.getConnectionUri();
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  return {
    url,
    pool,
    close: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

/** Applies every migration to the test database, exactly like `npm run db:migrate`. */
export async function migrateTestDatabase(databaseUrl: string): Promise<void> {
  await exec(
    "npx",
    ["node-pg-migrate", "up", "-m", "migrations", "--migrations-table", "schema_migrations"],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, cwd: process.cwd() },
  );
}

/** Wipes data between tests, keeping migrations and the seeded system accounts. */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(
    `TRUNCATE merchants, api_keys, accounts RESTART IDENTITY CASCADE`,
  );
  await pool.query(
    `INSERT INTO accounts (id, merchant_id, code, name, type, currency, is_system) VALUES
       ('00000000000000000000000001', NULL, 'PSP_CLEARING', 'PSP clearing', 'ASSET',   'USD', true),
       ('00000000000000000000000002', NULL, 'FEE_REVENUE',  'Platform fee', 'REVENUE', 'USD', true)
     ON CONFLICT DO NOTHING`,
  );
}
