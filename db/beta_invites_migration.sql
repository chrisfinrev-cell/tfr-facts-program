-- Beta invites with recipient identity markers (Future Gen / affiliate attribution)

CREATE TABLE IF NOT EXISTS beta_invites (
  id SERIAL PRIMARY KEY,
  code VARCHAR(50) UNIQUE NOT NULL,
  parent_code VARCHAR(50),
  sent_to_name VARCHAR(255),
  sent_to_email VARCHAR(255),
  recipient_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  claimed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  max_uses INT NOT NULL DEFAULT 1,
  uses_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS beta_invites_email_idx ON beta_invites (LOWER(sent_to_email));
CREATE INDEX IF NOT EXISTS beta_invites_claimed_by_idx ON beta_invites (claimed_by_user_id);
CREATE INDEX IF NOT EXISTS beta_invites_parent_code_idx ON beta_invites (parent_code);

-- User-side attribution fields populated at registration claim time
ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliate_code VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_code VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliate_tier VARCHAR(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS users_affiliate_code_idx ON users (affiliate_code);
CREATE INDEX IF NOT EXISTS users_referred_by_code_idx ON users (referred_by_code);
