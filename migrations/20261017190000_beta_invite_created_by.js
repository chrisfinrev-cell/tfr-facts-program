'use strict';

/**
 * Extra identity fields for master beta_codes and targeted beta_invites
 * so admin create forms can store createdBy / recipient details.
 */
module.exports = {
  name: 'beta_invite_created_by',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS beta_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(64) UNIQUE NOT NULL,
        max_uses INT DEFAULT 5,
        uses_count INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE beta_codes ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`);
    await client.query(`ALTER TABLE beta_codes ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER`);
    await client.query(`ALTER TABLE beta_codes ADD COLUMN IF NOT EXISTS name VARCHAR(255)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS beta_codes_code_key ON beta_codes (code)`);

    await client.query(`ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS created_by VARCHAR(255)`);
    await client.query(`ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER`);
    await client.query(`ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS sent_to_name VARCHAR(255)`);
    await client.query(`ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS sent_to_email VARCHAR(255)`);
    await client.query(`ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS recipient_metadata JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS last_emailed_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS last_email_error TEXT`);
  }
};
