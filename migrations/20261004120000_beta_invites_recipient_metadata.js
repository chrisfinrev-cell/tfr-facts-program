'use strict';

module.exports = {
  name: 'beta_invites_recipient_metadata',
  up: async (client) => {
    await client.query(`
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
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS beta_invites_email_idx ON beta_invites (LOWER(sent_to_email))`);
    await client.query(`CREATE INDEX IF NOT EXISTS beta_invites_claimed_by_idx ON beta_invites (claimed_by_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS beta_invites_parent_code_idx ON beta_invites (parent_code)`);

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliate_code VARCHAR(50)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_code VARCHAR(50)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliate_tier VARCHAR(64)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`CREATE INDEX IF NOT EXISTS users_affiliate_code_idx ON users (affiliate_code)`);
    await client.query(`CREATE INDEX IF NOT EXISTS users_referred_by_code_idx ON users (referred_by_code)`);
  }
};
