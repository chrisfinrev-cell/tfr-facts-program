-- FACTS / Financial Revolution — committed schema
-- Reconstructed from migrate.js, module migrations, and server.js SQL.
-- Live Neon was not reachable from this environment (no DATABASE_URL).
-- Refresh with: DATABASE_URL=... npm run schema:export

BEGIN;

CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  password_hash VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  stripe_subscription_id VARCHAR(255),
  subscription_status VARCHAR(50),
  subscription_plan VARCHAR(255),
  subscription_expires_at TIMESTAMPTZ,
  subscription_updated_at TIMESTAMPTZ,
  pricing_tier VARCHAR(64),
  subscription_tier VARCHAR(64),
  plan VARCHAR(64),
  phone VARCHAR(32),
  phone_verified_at TIMESTAMPTZ,
  referred_by_affiliate_id INTEGER,
  phase_zero_completed_at TIMESTAMPTZ,
  pz_deadline_lockout_until TIMESTAMPTZ,
  heartbeat_in_truth BOOLEAN DEFAULT TRUE,
  heartbeat_consecutive_passes INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS users_stripe_subscription_id_idx ON users (stripe_subscription_id);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_token_uidx ON password_reset_tokens (token);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name VARCHAR(255),
  timezone VARCHAR(64) DEFAULT 'America/Los_Angeles',
  household_role VARCHAR(32),
  phone VARCHAR(32),
  avatar_url TEXT,
  day_zero_snapshot JSONB,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nda_acceptances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nda_version VARCHAR(64) NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address VARCHAR(64),
  UNIQUE (user_id, nda_version)
);
CREATE INDEX IF NOT EXISTS nda_acceptances_user_idx ON nda_acceptances (user_id);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_allocations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  percentage NUMERIC(6,2) NOT NULL DEFAULT 0,
  is_temporary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, category_id, is_temporary)
);
CREATE INDEX IF NOT EXISTS user_allocations_user_idx ON user_allocations (user_id);

CREATE TABLE IF NOT EXISTS permanent_allocations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  percentage NUMERIC(6,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, category_id)
);

-- Dynamic per-user buckets (orphan split / live remaining)
CREATE TABLE IF NOT EXISTS user_bucket_state (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_slug TEXT NOT NULL,
  target_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  deposited_cents INTEGER NOT NULL DEFAULT 0,
  spent_cents INTEGER NOT NULL DEFAULT 0,
  remaining_cents INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, bucket_slug)
);
CREATE INDEX IF NOT EXISTS user_bucket_state_user_idx ON user_bucket_state (user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  type VARCHAR(32) NOT NULL DEFAULT 'income',
  description TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transactions_user_idx ON transactions (user_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS transaction_allocations (
  id SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  bucket_slug TEXT,
  percentage NUMERIC(6,2),
  amount_cents INTEGER
);
CREATE INDEX IF NOT EXISTS transaction_allocations_txn_idx ON transaction_allocations (transaction_id);

-- Append-only money movements across dynamic buckets
CREATE TABLE IF NOT EXISTS ledgers (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_slug TEXT NOT NULL,
  entry_type VARCHAR(32) NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ledgers_user_bucket_idx ON ledgers (user_id, bucket_slug, created_at DESC);

CREATE TABLE IF NOT EXISTS user_activity_events (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_analyses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_address VARCHAR(64),
  status VARCHAR(32) NOT NULL DEFAULT 'processing',
  analysis JSONB,
  raw_text TEXT,
  access_token TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_analyses_access_token_uidx
  ON credit_analyses (access_token) WHERE access_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS credit_analyses_user_idx ON credit_analyses (user_id);

CREATE TABLE IF NOT EXISTS ip_scan_log (
  id SERIAL PRIMARY KEY,
  ip_address VARCHAR(64) NOT NULL,
  analysis_id INTEGER REFERENCES credit_analyses(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS junior_profiles (
  id SERIAL PRIMARY KEY,
  parent_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  avatar_emoji VARCHAR(16),
  access_code VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS junior_profiles_parent_idx ON junior_profiles (parent_user_id);

CREATE TABLE IF NOT EXISTS households (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS household_members (
  id SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (household_id, user_id)
);
CREATE TABLE IF NOT EXISTS household_invites (
  id SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  code VARCHAR(64) NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  max_uses INTEGER DEFAULT 1,
  use_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS household_links (
  id SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  linked_household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (household_id, linked_household_id)
);
CREATE TABLE IF NOT EXISTS household_permissions (
  id SERIAL PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  granter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grantee_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_slug TEXT,
  can_view BOOLEAN NOT NULL DEFAULT TRUE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (household_id, granter_user_id, grantee_user_id, category_slug)
);

CREATE TABLE IF NOT EXISTS business_pro_heartbeats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audit_month DATE NOT NULL,
  bank_balance_cents INTEGER NOT NULL,
  ledger_balance_cents INTEGER NOT NULL,
  variance_cents INTEGER NOT NULL,
  in_truth BOOLEAN NOT NULL,
  signer_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, audit_month)
);

CREATE TABLE IF NOT EXISTS affiliates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_master_node BOOLEAN NOT NULL DEFAULT FALSE,
  orphans_assigned_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orphan_assignment_events (
  id SERIAL PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  new_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_to_id INTEGER NOT NULL,
  tier_level SMALLINT NOT NULL,
  destination VARCHAR(16) NOT NULL,
  split_label VARCHAR(16),
  next_index INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS orphan_assignment_events_affiliate_idx
  ON orphan_assignment_events (affiliate_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS orphan_assignment_events_new_user_uniq
  ON orphan_assignment_events (new_user_id);

CREATE SCHEMA IF NOT EXISTS core;
CREATE TABLE IF NOT EXISTS core.module_flags (
  id SERIAL PRIMARY KEY,
  module_id TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'disabled',
  UNIQUE (module_id, user_id)
);

CREATE SCHEMA IF NOT EXISTS session;
CREATE TABLE IF NOT EXISTS session.express_sessions (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE SCHEMA IF NOT EXISTS mod_plaid;
CREATE TABLE IF NOT EXISTS mod_plaid.user_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  institution_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS mod_plaid.account_balances (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT,
  account_id TEXT,
  current_cents INTEGER,
  available_cents INTEGER,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS mod_plaid.synced_transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plaid_transaction_id TEXT UNIQUE,
  amount_cents INTEGER,
  name TEXT,
  date DATE,
  pending BOOLEAN DEFAULT FALSE
);

CREATE SCHEMA IF NOT EXISTS mod_income;
CREATE TABLE IF NOT EXISTS mod_income.paycheck_entries (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  calculation_mode VARCHAR(8) NOT NULL DEFAULT 'GROSS',
  gross_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  employer_match NUMERIC(12,2) NOT NULL DEFAULT 0,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS mod_income.income_deductions (
  id SERIAL PRIMARY KEY,
  paycheck_id INTEGER NOT NULL REFERENCES mod_income.paycheck_entries(id) ON DELETE CASCADE,
  label TEXT,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  target_bucket TEXT
);

CREATE SCHEMA IF NOT EXISTS mod_coaching;
CREATE TABLE IF NOT EXISTS mod_coaching.client_readiness_scores (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  rubric JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SCHEMA IF NOT EXISTS mod_shopping;
CREATE TABLE IF NOT EXISTS mod_shopping.stores (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  category TEXT,
  chain TEXT,
  price_count INTEGER DEFAULT 0,
  avg_price_cents INTEGER
);
CREATE TABLE IF NOT EXISTS mod_shopping.products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  upc TEXT,
  category TEXT,
  community_avg_price NUMERIC(12,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS mod_shopping.shopping_lists (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store_id INTEGER REFERENCES mod_shopping.stores(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SCHEMA IF NOT EXISTS mod_brokerage;
CREATE TABLE IF NOT EXISTS mod_brokerage.assets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT,
  name TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO categories (slug, name, sort_order) VALUES
  ('necessities', 'Necessities', 1),
  ('reserve', 'Reserve', 2),
  ('velocity', 'Velocity', 3),
  ('growth', 'Growth', 4),
  ('lifestyle', 'Lifestyle', 5),
  ('legacy', 'Legacy', 6)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
