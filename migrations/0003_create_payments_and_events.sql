-- Up Migration

-- Payments Table
CREATE TABLE payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
    amount BIGINT NOT NULL CHECK (amount > 0),
    currency VARCHAR(3) NOT NULL,
    status VARCHAR(50) NOT NULL CHECK (
        status IN (
            'CREATED',
            'RISK_REJECTED',
            'AUTH_PENDING',
            'AUTHORIZED',
            'DECLINED',
            'UNKNOWN',
            'CAPTURE_PENDING',
            'CAPTURED',
            'PARTIALLY_REFUNDED',
            'REFUNDED',
            'VOIDED'
        )
    ),
    authorized_amount BIGINT NOT NULL DEFAULT 0,
    captured_amount BIGINT NOT NULL DEFAULT 0,
    refunded_amount BIGINT NOT NULL DEFAULT 0,
    psp_ref VARCHAR(100) NULL,
    version INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_captured_le_authorized CHECK (captured_amount <= authorized_amount),
    CONSTRAINT chk_refunded_le_captured CHECK (refunded_amount <= captured_amount)
);

CREATE INDEX idx_payments_merchant_id ON payments(merchant_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_psp_ref ON payments(psp_ref);

-- Payment Events Table (Append-only state audit log)
CREATE TABLE payment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    previous_status VARCHAR(50) NULL,
    new_status VARCHAR(50) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_events_payment_id ON payment_events(payment_id);
CREATE INDEX idx_payment_events_event_type ON payment_events(event_type);

-- Down Migration
DROP TABLE IF EXISTS payment_events CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
