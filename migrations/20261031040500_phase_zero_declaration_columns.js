/**
 * Phase Zero declaration + deadline columns.
 * Fixes /api/phase-zero/accept-declaration 500 ("Server error") when
 * declaration_accepted_at / phase_zero_started_at are missing on users.
 */
module.exports = {
  name: 'phase_zero_declaration_columns',
  up: async (client) => {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS declaration_accepted_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phase_zero_started_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pz_deadline_locked_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_guided_setup BOOLEAN`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_setup_answers JSONB`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_necessities NUMERIC(5,2)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_velocity NUMERIC(5,2)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_reserve NUMERIC(5,2)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_lifestyle NUMERIC(5,2)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_growth NUMERIC(5,2)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_legacy NUMERIC(5,2)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_status VARCHAR(32)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_day_count INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_start_date TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_last_activity_date TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_completed_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_attempts INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_lockout_until TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_otp VARCHAR(16)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_otp_expires_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_otp_attempts INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_otp_window_start TIMESTAMPTZ`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pz_lockout_overrides (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        admin_email VARCHAR(255) NOT NULL,
        overridden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        days_remaining_at_override NUMERIC(6,2),
        prior_state VARCHAR(64),
        notes TEXT
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS pz_lockout_overrides_user_idx
        ON pz_lockout_overrides (user_id, overridden_at DESC)
    `);
  }
};
