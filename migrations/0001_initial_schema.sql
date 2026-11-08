-- Up Migration
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Merchants Table
CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API Keys Table (Hashed API keys with lookup prefix)
CREATE TABLE api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    key_prefix VARCHAR(32) NOT NULL,
    key_hash VARCHAR(64) NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{"payments:read","payments:write"}',
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX idx_api_keys_merchant_id ON api_keys(merchant_id);

-- Accounts Table (Double-entry account entities)
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NULL REFERENCES merchants(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'REVENUE')),
    name VARCHAR(100) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    balance BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure uniqueness for system accounts (merchant_id is NULL)
CREATE UNIQUE INDEX idx_accounts_system_unique ON accounts (type, name, currency) WHERE merchant_id IS NULL;

-- Ensure uniqueness for merchant-specific accounts
CREATE UNIQUE INDEX idx_accounts_merchant_unique ON accounts (merchant_id, name, currency) WHERE merchant_id IS NOT NULL;

-- Seed default system accounts
INSERT INTO accounts (merchant_id, type, name, currency, balance)
VALUES 
    (NULL, 'ASSET', 'PSP_CLEARING', 'USD', 0),
    (NULL, 'REVENUE', 'FEE_REVENUE', 'USD', 0)
ON CONFLICT DO NOTHING;

-- Down Migration
DROP TABLE IF EXISTS accounts CASCADE;
DROP TABLE IF EXISTS api_keys CASCADE;
DROP TABLE IF EXISTS merchants CASCADE;
