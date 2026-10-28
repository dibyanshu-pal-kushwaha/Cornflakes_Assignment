-- Credits & Billing Ledger Database Schema
-- Strict Double-Entry, Append-Only Ledger with PostgreSQL Constraints & Immutability Triggers

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- System Clock Offset Table for Injectable Virtual Time
CREATE TABLE IF NOT EXISTS system_clock_offset (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    offset_seconds BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO system_clock_offset (id, offset_seconds) VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- Wallets
CREATE TABLE IF NOT EXISTS wallets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(128) NOT NULL UNIQUE,
    org_id UUID NULL,
    balance BIGINT NOT NULL DEFAULT 0,
    reserved_balance BIGINT NOT NULL DEFAULT 0,
    receivable_balance BIGINT NOT NULL DEFAULT 0,
    currency VARCHAR(8) NOT NULL DEFAULT 'USD',
    status VARCHAR(32) NOT NULL DEFAULT 'active', -- 'active', 'suspended'
    version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT check_no_negative_balance CHECK (balance >= 0),
    CONSTRAINT check_no_negative_reserved CHECK (reserved_balance >= 0),
    CONSTRAINT check_no_negative_receivable CHECK (receivable_balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_org_id ON wallets(org_id);

-- Credit Buckets (FIFO by Expiry)
CREATE TABLE IF NOT EXISTS credit_buckets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    source VARCHAR(32) NOT NULL, -- 'purchased', 'subscription', 'promo'
    amount_issued BIGINT NOT NULL,
    amount_remaining BIGINT NOT NULL,
    amount_reserved BIGINT NOT NULL DEFAULT 0,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT check_bucket_non_negative CHECK (amount_remaining >= 0 AND amount_reserved >= 0),
    CONSTRAINT check_bucket_reserved_le_remaining CHECK (amount_reserved <= amount_remaining)
);

CREATE INDEX IF NOT EXISTS idx_buckets_wallet_expires ON credit_buckets(wallet_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_buckets_expires ON credit_buckets(expires_at) WHERE amount_remaining > 0;

-- Append-Only Ledger Transactions
CREATE TABLE IF NOT EXISTS ledger_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type VARCHAR(64) NOT NULL,
    reference_id VARCHAR(128),
    idempotency_key VARCHAR(128) UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_tx_idempotency ON ledger_transactions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_reference ON ledger_transactions(reference_id);
CREATE INDEX IF NOT EXISTS idx_ledger_tx_created ON ledger_transactions(created_at);

-- Double-Entry Ledger Entries (Strictly balanced sum(amount) == 0 per transaction_id)
CREATE TABLE IF NOT EXISTS ledger_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID NOT NULL REFERENCES ledger_transactions(id) ON DELETE RESTRICT,
    account_id VARCHAR(128) NOT NULL,
    wallet_id UUID NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    bucket_id UUID NULL REFERENCES credit_buckets(id) ON DELETE RESTRICT,
    amount BIGINT NOT NULL, -- Positive = Credit, Negative = Debit
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_entries_tx ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_wallet ON ledger_entries(wallet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_created ON ledger_entries(created_at);

-- IMMUTABILITY TRIGGERS: Prevent UPDATE or DELETE on ledger tables
CREATE OR REPLACE FUNCTION prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Ledger entries are strictly append-only and immutable. UPDATE and DELETE operations are forbidden.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_ledger_entries_mutation ON ledger_entries;
CREATE TRIGGER trg_prevent_ledger_entries_mutation
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW
    EXECUTE FUNCTION prevent_ledger_mutation();

DROP TRIGGER IF EXISTS trg_prevent_ledger_transactions_mutation ON ledger_transactions;
CREATE TRIGGER trg_prevent_ledger_transactions_mutation
    BEFORE UPDATE OR DELETE ON ledger_transactions
    FOR EACH ROW
    EXECUTE FUNCTION prevent_ledger_mutation();

-- Reservations Table
CREATE TABLE IF NOT EXISTS reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    idempotency_key VARCHAR(128) UNIQUE NOT NULL,
    amount BIGINT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active', -- 'active', 'committed', 'released', 'expired'
    bucket_allocations JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reservations_wallet_status ON reservations(wallet_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_expires ON reservations(expires_at) WHERE status = 'active';

-- Webhook Outbox and Ingestion Table
CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id VARCHAR(128) UNIQUE NOT NULL,
    payment_id VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    raw_body TEXT NOT NULL,
    signature VARCHAR(256) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'parked', 'dead_letter'
    retry_count INT NOT NULL DEFAULT 0,
    park_reason TEXT NULL,
    last_error TEXT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_status_received ON webhook_events(status, received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_payment_id ON webhook_events(payment_id);

-- Processed Payments (Deduplication across different events for same payment)
CREATE TABLE IF NOT EXISTS processed_payments (
    payment_id VARCHAR(128) PRIMARY KEY,
    first_event_id VARCHAR(128) NOT NULL,
    amount BIGINT NOT NULL,
    currency VARCHAR(8) NOT NULL,
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    status VARCHAR(32) NOT NULL DEFAULT 'settled', -- 'settled', 'refunded', 'partially_refunded'
    refunded_amount BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Plans Catalog
CREATE TABLE IF NOT EXISTS plans (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    credits_per_cycle BIGINT NOT NULL,
    price_minor BIGINT NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT 'USD',
    cycle_interval_days INT NOT NULL DEFAULT 30,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    plan_id VARCHAR(64) NOT NULL REFERENCES plans(id),
    status VARCHAR(32) NOT NULL DEFAULT 'active', -- 'active', 'grace_period', 'suspended', 'cancelled'
    current_period_start TIMESTAMPTZ NOT NULL,
    current_period_end TIMESTAMPTZ NOT NULL,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
    dunning_attempt INT NOT NULL DEFAULT 0,
    next_dunning_at TIMESTAMPTZ NULL,
    last_renewed_cycle VARCHAR(64) NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_wallet ON subscriptions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_end ON subscriptions(status, current_period_end);

-- Organizations & Seats
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(128) NOT NULL,
    owner_id VARCHAR(128) NOT NULL,
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    seat_price_minor BIGINT NOT NULL DEFAULT 2000, -- $20 per seat/month
    seat_credits_per_month BIGINT NOT NULL DEFAULT 100, -- 100 credits per seat
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Organization Members / Seats
CREATE TABLE IF NOT EXISTS org_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id VARCHAR(128) NOT NULL,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(32) NOT NULL DEFAULT 'member', -- 'owner', 'admin', 'member'
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    seat_billed_until TIMESTAMPTZ NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_org_user UNIQUE (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON org_members(org_id);

-- Invoices & Tax Line Items
CREATE TABLE IF NOT EXISTS invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id VARCHAR(128) NOT NULL,
    wallet_id UUID NOT NULL REFERENCES wallets(id),
    subtotal_minor BIGINT NOT NULL,
    tax_minor BIGINT NOT NULL,
    total_minor BIGINT NOT NULL,
    currency VARCHAR(8) NOT NULL DEFAULT 'USD',
    line_items JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_wallet ON invoices(wallet_id);
CREATE INDEX IF NOT EXISTS idx_invoices_payment ON invoices(payment_id);

-- Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NULL,
    actor_id VARCHAR(128) NOT NULL,
    action VARCHAR(64) NOT NULL,
    target_type VARCHAR(64) NOT NULL,
    target_id VARCHAR(128) NOT NULL,
    before_state JSONB NULL,
    after_state JSONB NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(org_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id);
