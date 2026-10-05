'use strict';

/**
 * Ensure auth/login columns exist on users.
 * Safe to re-run (IF NOT EXISTS).
 */
const { Client } = require('pg');

const STATEMENTS = [
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
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(120)`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_color VARCHAR(32)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_user_id_lower_uidx ON users (LOWER(user_id)) WHERE user_id IS NOT NULL`
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  for (const sql of STATEMENTS) {
    try {
      await client.query(sql);
      console.log('OK', sql.slice(0, 72));
    } catch (err) {
      console.error('FAIL', sql.slice(0, 72), err.message);
      throw err;
    }
  }
  // Smoke the exact login SELECT
  await client.query(
    `SELECT id, email, name, password_hash, plan, paid_until, is_creator,
            promo_code_used, promo_grace_expired, two_factor_enabled,
            verification_method, verified_phone
     FROM users
     WHERE LOWER(email) = $1 OR LOWER(user_id) = $1`,
    ['smoke@example.com']
  );
  console.log('LOGIN_SELECT_OK');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
