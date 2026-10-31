'use strict';

/**
 * Ensure columns required by /api/auth/login + completeLogin exist.
 * Safe to call on every boot (IF NOT EXISTS).
 */
async function ensureAuthSchema(pool) {
  if (!pool) return { skipped: true };
  const statements = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_grace_expired BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_grace_started_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_method VARCHAR(20)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_phone VARCHAR(32)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS user_id VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS inactivity_warnings_sent INT DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_used BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_plan_type VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_creator BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_beta_tester BOOLEAN DEFAULT TRUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS relationship_tag VARCHAR(50) DEFAULT 'STANDARD'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_affiliate_disabled BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliate_tier VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliate_code VARCHAR(50)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_invites_remaining INT DEFAULT 5`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS income_programs_blocked BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(120)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color VARCHAR(32)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS pricing_tier VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS business_path_type VARCHAR(16)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS survival_burn_cents INTEGER`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS bucket_cert_completed BOOLEAN DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS promo_code_used VARCHAR(64)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS paid_until TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(32) DEFAULT 'member'`,
    // Phase Zero declaration + deadline (fixes accept-declaration 500s)
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS declaration_accepted_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phase_zero_started_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS pz_deadline_locked_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_guided_setup BOOLEAN`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_setup_answers JSONB`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_necessities NUMERIC(5,2)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_velocity NUMERIC(5,2)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_reserve NUMERIC(5,2)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_lifestyle NUMERIC(5,2)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_growth NUMERIC(5,2)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS alloc_legacy NUMERIC(5,2)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phase_zero_completed_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_status VARCHAR(32)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_day_count INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_start_date TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_last_activity_date TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_completed_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS audit_lockout_until TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_otp VARCHAR(16)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_otp_expires_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_otp_attempts INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_otp_window_start TIMESTAMPTZ`
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }

  try {
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_user_id_lower_uidx
       ON users (LOWER(user_id))
       WHERE user_id IS NOT NULL`
    );
  } catch (err) {
    // Index create can race on serverless cold starts; ignore.
    console.warn('[ensureAuthSchema] index note:', err.message);
  }

  await ensurePasswordResetSchema(pool);

  try {
    const { promoteFounderAdmin } = require('./promoteFounderAdmin');
    await promoteFounderAdmin(pool);
  } catch (err) {
    console.warn('[ensureAuthSchema] founder admin promote:', err.message);
  }

  return { ok: true };
}

// Password reset used to 500 because this table was never created.
async function ensurePasswordResetSchema(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS user_id INTEGER`);
  await pool.query(`ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS token TEXT`);
  await pool.query(`ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS used BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_token_uidx ON password_reset_tokens (token)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx ON password_reset_tokens (user_id)`);
  } catch (err) {
    console.warn('[ensureAuthSchema] password reset index note:', err.message);
  }
}

module.exports = { ensureAuthSchema, ensurePasswordResetSchema };
