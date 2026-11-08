import type { MigrationBuilder } from "node-pg-migrate";

/**
 * 0003 -- payments, payment events, PSP interactions
 *
 * Key modelling decisions:
 *  - Amounts are separate columns (amount / authorized / captured / refunded),
 *    never one mutable "balance", because each is a different fact with its own
 *    lifecycle.
 *  - CHECK constraints encode the monotonic invariants: you can never capture
 *    more than you authorised, never refund more than you captured.
 *  - `version` supports optimistic concurrency for read-modify-write flows that
 *    do not want to hold a row lock.
 *  - payment_events is append-only: it is the audit trail of every state change.
 *  - psp_transactions records every call we make to the provider, with our
 *    idempotency reference, so UNKNOWN outcomes can be investigated and repaired.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE payments (
      id                 varchar(26) PRIMARY KEY,
      merchant_id        varchar(26) NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      amount_minor       bigint      NOT NULL,
      currency           varchar(3)  NOT NULL,
      authorized_amount  bigint      NOT NULL DEFAULT 0,
      captured_amount    bigint      NOT NULL DEFAULT 0,
      refunded_amount    bigint      NOT NULL DEFAULT 0,
      status             varchar(20) NOT NULL,
      -- Our reference sent to the PSP; unique so a retry can never create a
      -- second charge for the same intent.
      psp_reference      varchar(40) NOT NULL,
      psp_ref            varchar(64),
      decline_code       varchar(40),
      description        varchar(200),
      metadata           jsonb       NOT NULL DEFAULT '{}'::jsonb,
      version            integer     NOT NULL DEFAULT 1,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.addConstraint("payments", "payments_amount_positive", { check: "amount_minor > 0" });
  pgm.addConstraint("payments", "payments_currency_check", { check: "currency ~ '^[A-Z]{3}$'" });
  pgm.addConstraint("payments", "payments_status_check", {
    check: `status IN (
      'CREATED','RISK_REJECTED','AUTH_PENDING','AUTHORIZED','DECLINED','UNKNOWN',
      'VOIDED','CAPTURE_PENDING','CAPTURED','PARTIALLY_REFUNDED','REFUNDED')`,
  });
  // Monotonic money invariants. These are the last line of defence against a
  // concurrent double-capture / over-refund that slipped past app-level locking.
  pgm.addConstraint("payments", "payments_authorized_within_amount", {
    check: "authorized_amount >= 0 AND authorized_amount <= amount_minor",
  });
  pgm.addConstraint("payments", "payments_captured_within_authorized", {
    check: "captured_amount >= 0 AND captured_amount <= authorized_amount",
  });
  pgm.addConstraint("payments", "payments_refunded_within_captured", {
    check: "refunded_amount >= 0 AND refunded_amount <= captured_amount",
  });
  // A refund can only exist once there is a capture; a capture only after auth.
  pgm.addConstraint("payments", "payments_refund_requires_capture", {
    check: "refunded_amount = 0 OR captured_amount > 0",
  });
  pgm.addConstraint("payments", "payments_psp_reference_unique", { unique: ["psp_reference"] });

  // Tenant query pattern: "my payments, newest first".
  pgm.createIndex("payments", ["merchant_id", "created_at"], {
    name: "payments_merchant_created_idx",
  });
  // The recovery sweeper looks for stuck payments; status first is selective.
  pgm.createIndex("payments", ["status", "updated_at"], { name: "payments_status_updated_idx" });
  pgm.createIndex("payments", "psp_ref", { name: "payments_psp_ref_idx" });

  pgm.sql(`
    CREATE TABLE payment_events (
      id              bigserial   PRIMARY KEY,
      payment_id      varchar(26) NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
      merchant_id     varchar(26) NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      event_type      varchar(40) NOT NULL,
      from_status     varchar(20),
      to_status       varchar(20),
      detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
      correlation_id  varchar(128),
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.createIndex("payment_events", ["payment_id", "id"], { name: "payment_events_payment_idx" });

  // The audit trail must be append-only, exactly like the ledger.
  pgm.sql(`
    CREATE TRIGGER payment_events_append_only
      BEFORE UPDATE OR DELETE ON payment_events
      FOR EACH ROW EXECUTE FUNCTION clearwell_forbid_mutation();
  `);

  pgm.sql(`
    CREATE TABLE psp_transactions (
      id                bigserial   PRIMARY KEY,
      payment_id        varchar(26) NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
      operation         varchar(20) NOT NULL,
      our_reference     varchar(40) NOT NULL,
      psp_ref           varchar(64),
      request           jsonb       NOT NULL DEFAULT '{}'::jsonb,
      response          jsonb,
      http_status       integer,
      outcome           varchar(20) NOT NULL,
      attempt           integer     NOT NULL DEFAULT 1,
      latency_ms        integer,
      error_message     text,
      created_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.addConstraint("psp_transactions", "psp_transactions_operation_check", {
    check: "operation IN ('AUTHORIZE','CAPTURE','VOID','REFUND','STATUS_INQUIRY')",
  });
  pgm.addConstraint("psp_transactions", "psp_transactions_outcome_check", {
    check: "outcome IN ('SUCCESS','DECLINED','TIMEOUT','ERROR')",
  });
  pgm.createIndex("psp_transactions", ["payment_id", "id"], { name: "psp_transactions_payment_idx" });
  // A retried call must reuse the same our_reference; this index lets the
  // simulator (and our recovery code) find what we already sent.
  pgm.createIndex("psp_transactions", ["our_reference", "operation"], {
    name: "psp_transactions_ref_op_idx",
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DROP TABLE IF EXISTS psp_transactions;`);
  pgm.sql(`DROP TRIGGER IF EXISTS payment_events_append_only ON payment_events;`);
  pgm.sql(`DROP TABLE IF EXISTS payment_events;`);
  pgm.sql(`DROP TABLE IF EXISTS payments;`);
};
