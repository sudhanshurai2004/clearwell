-- Up Migration

-- Ledger Transactions Table
CREATE TABLE ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    reference_id VARCHAR(100) NOT NULL,
    reference_type VARCHAR(50) NOT NULL,
    description TEXT NULL,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_ledger_tx_reference UNIQUE (reference_id, reference_type)
);

CREATE INDEX idx_ledger_tx_reference ON ledger_transactions(reference_id, reference_type);
CREATE INDEX idx_ledger_tx_merchant ON ledger_transactions(merchant_id);

-- Ledger Entries Table (Append-only, strictly positive amount)
CREATE TABLE ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE CASCADE,
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    direction VARCHAR(6) NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ledger_entries_tx ON ledger_entries(transaction_id);
CREATE INDEX idx_ledger_entries_account ON ledger_entries(account_id);

-- Trigger function to enforce debits == credits per transaction per currency at COMMIT time
CREATE OR REPLACE FUNCTION check_ledger_transaction_balanced()
RETURNS TRIGGER AS $$
DECLARE
    unbalanced_record RECORD;
BEGIN
    -- Group by currency and check if sum(DEBIT) != sum(CREDIT)
    SELECT 
        currency,
        SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) AS balance_diff
    INTO unbalanced_record
    FROM ledger_entries
    WHERE transaction_id = NEW.transaction_id
    GROUP BY currency
    HAVING SUM(CASE WHEN direction = 'DEBIT' THEN amount ELSE -amount END) <> 0
    LIMIT 1;

    IF FOUND THEN
        RAISE EXCEPTION 'Double-entry ledger transaction % is unbalanced for currency % (difference: %)',
            NEW.transaction_id, unbalanced_record.currency, unbalanced_record.balance_diff
            USING ERRCODE = '23514'; -- check_violation
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Constraint trigger: DEFERRABLE INITIALLY DEFERRED
-- Checks at COMMIT time so all multi-legged entries can be inserted in the transaction first
CREATE CONSTRAINT TRIGGER trigger_enforce_ledger_balance
AFTER INSERT OR UPDATE ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION check_ledger_transaction_balanced();

-- Down Migration
DROP TRIGGER IF EXISTS trigger_enforce_ledger_balance ON ledger_entries;
DROP FUNCTION IF EXISTS check_ledger_transaction_balanced();
DROP TABLE IF EXISTS ledger_entries CASCADE;
DROP TABLE IF EXISTS ledger_transactions CASCADE;
