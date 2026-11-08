import type { MigrationBuilder } from "node-pg-migrate";

/**
 * 0002 -- double-entry ledger core
 *
 * Two tables, one invariant:
 *
 *   ledger_transactions  = a journal entry header (what business event happened)
 *   ledger_entries       = the debit/credit lines of that entry
 *
 * INVARIANT: for every transaction, SUM(debits) == SUM(credits).
 *
 * This is enforced in three independent places, exactly as the spec requires:
 *   1. Application code refuses to build an unbalanced posting (fast, good errors).
 *   2. A DEFERRABLE INITIALLY DEFERRED constraint trigger checks the whole
 *      transaction at COMMIT time. "Deferred" is the key word: a posting is
 *      inserted line by line, so the balance is only true at the very end. An
 *      immediate trigger would fire on the first INSERT and always fail.
 *   3. Rows are append-only: UPDATE and DELETE are rejected by trigger, so a
 *      balanced history cannot be silently rewritten later.
 */
export const up = (pgm: MigrationBuilder): void => {
  pgm.sql(`
    CREATE TABLE ledger_transactions (
      id              varchar(26) PRIMARY KEY,
      kind            varchar(24) NOT NULL,
      merchant_id     varchar(26) NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      payment_id      varchar(26),
      payout_id       varchar(26),
      sequence        integer     NOT NULL DEFAULT 1,
      currency        varchar(3)  NOT NULL,
      amount_minor    bigint      NOT NULL,
      description     varchar(200) NOT NULL,
      correlation_id  varchar(128),
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.addConstraint("ledger_transactions", "ledger_transactions_kind_check", {
    check: "kind IN ('CAPTURE','REFUND','PAYOUT','FEE_ADJUSTMENT')",
  });
  pgm.addConstraint("ledger_transactions", "ledger_transactions_currency_check", {
    check: "currency ~ '^[A-Z]{3}$'",
  });
  pgm.addConstraint("ledger_transactions", "ledger_transactions_amount_check", {
    check: "amount_minor > 0",
  });
  pgm.addConstraint("ledger_transactions", "ledger_transactions_sequence_check", {
    check: "sequence >= 1",
  });
  // Exactly one business object per entry.
  pgm.addConstraint("ledger_transactions", "ledger_transactions_subject_check", {
    check: "(payment_id IS NOT NULL)::int + (payout_id IS NOT NULL)::int = 1",
  });

  /**
   * RETRY-SAFE POSTING KEYS.
   *
   * (payment_id, kind, sequence) is the idempotency key of the ledger itself.
   * A capture is sequence 1; the first refund sequence 1, the second 2, ...
   * If a worker crashes after writing the ledger but before marking the payment
   * captured, the retry hits this unique index and becomes a no-op instead of
   * posting money twice. Partial indexes because payment_id / payout_id are
   * mutually exclusive.
   */
  pgm.sql(`
    CREATE UNIQUE INDEX ledger_transactions_payment_uniq
      ON ledger_transactions (payment_id, kind, sequence)
      WHERE payment_id IS NOT NULL;
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX ledger_transactions_payout_uniq
      ON ledger_transactions (payout_id, kind, sequence)
      WHERE payout_id IS NOT NULL;
  `);
  pgm.createIndex("ledger_transactions", ["merchant_id", "created_at"], {
    name: "ledger_transactions_merchant_created_idx",
  });

  pgm.sql(`
    CREATE TABLE ledger_entries (
      id              bigserial   PRIMARY KEY,
      transaction_id  varchar(26) NOT NULL
                      REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
      account_id      varchar(26) NOT NULL
                      REFERENCES accounts(id) ON DELETE RESTRICT,
      direction       varchar(6)  NOT NULL,
      amount_minor    bigint      NOT NULL,
      currency        varchar(3)  NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.addConstraint("ledger_entries", "ledger_entries_direction_check", {
    check: "direction IN ('DEBIT','CREDIT')",
  });
  // Money is positive + a direction. A negative amount would make "debits equal
  // credits" ambiguous and hides bugs, so it is banned at the column level.
  pgm.addConstraint("ledger_entries", "ledger_entries_amount_check", {
    check: "amount_minor > 0",
  });
  pgm.addConstraint("ledger_entries", "ledger_entries_currency_check", {
    check: "currency ~ '^[A-Z]{3}$'",
  });
  pgm.createIndex("ledger_entries", "transaction_id", {
    name: "ledger_entries_transaction_id_idx",
  });
  // Supports "give me this account's statement, newest first" and balance sums.
  pgm.createIndex("ledger_entries", ["account_id", "id"], {
    name: "ledger_entries_account_id_idx",
  });

  // ---------- invariant 2: deferred balance check ----------
  pgm.sql(`
    CREATE FUNCTION clearwell_assert_ledger_balanced() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      total_debits  bigint;
      total_credits bigint;
    BEGIN
      SELECT COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'DEBIT'), 0),
             COALESCE(SUM(amount_minor) FILTER (WHERE direction = 'CREDIT'), 0)
        INTO total_debits, total_credits
        FROM ledger_entries
       WHERE transaction_id = NEW.transaction_id;

      IF total_debits <> total_credits THEN
        RAISE EXCEPTION
          'unbalanced ledger transaction %: debits=% credits=%',
          NEW.transaction_id, total_debits, total_credits
          USING ERRCODE = 'check_violation',
                HINT = 'every ledger transaction must have SUM(debits) = SUM(credits)';
      END IF;

      RETURN NULL;
    END;
    $$;
  `);

  pgm.sql(`
    CREATE CONSTRAINT TRIGGER ledger_entries_balanced
      AFTER INSERT ON ledger_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION clearwell_assert_ledger_balanced();
  `);

  // ---------- invariant 3: append-only ----------
  pgm.sql(`
    CREATE FUNCTION clearwell_forbid_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION
        '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
    END;
    $$;
  `);

  pgm.sql(`
    CREATE TRIGGER ledger_entries_append_only
      BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION clearwell_forbid_mutation();
  `);
  pgm.sql(`
    CREATE TRIGGER ledger_transactions_append_only
      BEFORE UPDATE OR DELETE ON ledger_transactions
      FOR EACH ROW EXECUTE FUNCTION clearwell_forbid_mutation();
  `);

  /**
   * Balances are DERIVED, never stored, so they can never drift from the
   * entries. Sign convention follows accounting:
   *   ASSET / EXPENSE     -> debit increases  (debit = +)
   *   LIABILITY / REVENUE -> credit increases (credit = +)
   * So "MERCHANT_PAYABLE balance" is the money we owe the merchant, and
   * "PSP_CLEARING balance" is cash we are holding at the provider.
   */
  pgm.sql(`
    CREATE VIEW account_balances AS
    SELECT a.id            AS account_id,
           a.merchant_id,
           a.code,
           a.type,
           a.currency,
           a.is_system,
           COALESCE(SUM(
             CASE
               WHEN a.type IN ('ASSET','EXPENSE')
                 THEN CASE WHEN e.direction = 'DEBIT' THEN e.amount_minor
                           ELSE -e.amount_minor END
               ELSE   CASE WHEN e.direction = 'CREDIT' THEN e.amount_minor
                           ELSE -e.amount_minor END
             END
           ), 0)::bigint AS balance_minor
      FROM accounts a
      LEFT JOIN ledger_entries e ON e.account_id = a.id
     GROUP BY a.id, a.merchant_id, a.code, a.type, a.currency, a.is_system;
  `);
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.sql(`DROP VIEW IF EXISTS account_balances;`);
  pgm.sql(`DROP TRIGGER IF EXISTS ledger_transactions_append_only ON ledger_transactions;`);
  pgm.sql(`DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;`);
  pgm.sql(`DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries;`);
  pgm.sql(`DROP FUNCTION IF EXISTS clearwell_forbid_mutation();`);
  pgm.sql(`DROP FUNCTION IF EXISTS clearwell_assert_ledger_balanced();`);
  pgm.sql(`DROP TABLE IF EXISTS ledger_entries;`);
  pgm.sql(`DROP TABLE IF EXISTS ledger_transactions;`);
};
