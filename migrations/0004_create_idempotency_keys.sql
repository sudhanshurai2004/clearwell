-- Up Migration

-- Idempotency Keys Table
CREATE TABLE idempotency_keys (
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    status VARCHAR(50) NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETED', 'FAILED')),
    response_code INT NULL,
    response_body JSONB NULL,
    payment_id UUID NULL REFERENCES payments(id) ON DELETE SET NULL,
    locked_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (merchant_id, key)
);

CREATE INDEX idx_idempotency_merchant_key ON idempotency_keys(merchant_id, key);
CREATE INDEX idx_idempotency_locked_until ON idempotency_keys(locked_until);

-- Down Migration
DROP TABLE IF EXISTS idempotency_keys CASCADE;
