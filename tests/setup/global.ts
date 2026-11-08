/**
 * Vitest global setup.
 *
 * Tries to start ONE PostgreSQL for the whole run (Testcontainers, or
 * TEST_DATABASE_URL when Docker is unavailable), applies migrations and writes
 * the URL to a state file that worker processes can read.
 *
 * If no database can be reached we do NOT fail here: pure unit tests must still
 * run on a machine without Docker. Instead we record the failure in the state
 * file, and every integration test throws it with the real reason. That way a
 * database problem can never be mistaken for "tests passed".
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrateTestDatabase, startTestDatabase, type StartedDatabase } from "../support/postgres";

export type DatabaseState =
  | { status: "ready"; url: string; stateFile: string }
  | { status: "unavailable"; error: string; stateFile: string };

let db: StartedDatabase | undefined;

export async function setup(): Promise<void> {
  const stateFile = path.join(mkdtempSync(path.join(tmpdir(), "clearwell-test-")), "db-state.json");

  let state: DatabaseState;
  try {
    db = await startTestDatabase();
    await migrateTestDatabase(db.url);
    state = { status: "ready", url: db.url, stateFile };
    process.env.DATABASE_URL = db.url;
  } catch (err) {
    state = { status: "unavailable", error: (err as Error).message, stateFile };
  }

  writeFileSync(stateFile, JSON.stringify(state), "utf8");
  process.env.CLEARWELL_TEST_STATE_FILE = stateFile;
}

export async function teardown(): Promise<void> {
  await db?.close();
}
