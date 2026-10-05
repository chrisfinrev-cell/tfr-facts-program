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
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_invites_remaining INT DEFAULT 5`
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

  return { ok: true };
}

module.exports = { ensureAuthSchema };
