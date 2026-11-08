import type { MigrationBuilder } from "node-pg-migrate";

/**
 * 0005 -- idempotency keys
 *
 * THE FAILURE SCENARIO THIS EXISTS FOR
 *
 *   A client sends POST /v1/payments. The provider call succeeds, we charge the
 *   customer, and then the connection drops before the response reaches them.
 *   Every sane client retries. Without idempotency the retry charges again.
 *
 * THE MECHANISM
 *
 *   1. Claim the key atomically:  INSERT ... ON CONFLICT DO NOTHING
 *      - inserted   -> we own this key, execute the request
 *      - conflict   -> somebody already ran (or is running) this request
 *   2. Compare the stored request_hash with the incoming one:
 *      - same hash    -> replay the stored response (200/201 semantics preserved)
 *      - different    -> 422: the same key was reused for a different request
 *   3. If the first request is still in flight (status = IN_PROGRESS and
 *      locked_until in the future) the duplicate waits briefly, then gets 409.
 *   4. If the lock is STALE (process died) we do NOT blindly re-run: we first
 *      look at the payment's real state and only then decide.
 *
 * Primary key is (merchant_id, key): one key space per tenant, so two merchants
 * cannot collide or probe each other's keys.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE idempotency_keys (
      merchant_id    varchar(26) NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      key            varchar(255) NOT NULL,
      -- method + path + body hash: the same key on a different endpoint or with
      -- a different body is a client bug, not a retry.
      request_hash   varchar(64) NOT NULL,
      method         varchar(10) NOT NULL,
      path           varchar(255) NOT NULL,
      status         varchar(20) NOT NULL,
      response_code  integer,
      response_body  jsonb,
      payment_id     varchar(26),
      -- Lease on the in-flight request. A dead process leaves a stale lock that
      -- the next caller may take over after checking the real state.
      locked_until   timestamptz,
      attempts       integer NOT NULL DEFAULT 1,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (merchant_id, key)
    );
  `);

  pgm.addConstraint("idempotency_keys", "idempotency_keys_status_check", {
    check: "status IN ('IN_PROGRESS','COMPLETED','FAILED')",
  });
  // Completed keys must carry a response; in-progress ones must carry a lease.
  pgm.addConstraint("idempotency_keys", "idempotency_keys_completed_shape", {
    check: `(status = 'IN_PROGRESS' AND locked_until IS NOT NULL)
         OR (status IN ('COMPLETED','FAILED') AND response_code IS NOT NULL)`,
  });

  // Housekeeping: expired completed keys can be pruned by a maintenance job.
  pgm.createIndex("idempotency_keys", "created_at", { name: "idempotency_keys_created_idx" });
  pgm.createIndex("idempotency_keys", "payment_id", {
    name: "idempotency_keys_payment_idx",
    where: "payment_id IS NOT NULL",
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DROP TABLE IF EXISTS idempotency_keys;`);
};
