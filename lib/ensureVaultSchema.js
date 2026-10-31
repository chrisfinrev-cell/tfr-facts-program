'use strict';

/**
 * Ensure document vault tables/columns exist.
 * Safe to call on every boot (IF NOT EXISTS).
 */
async function ensureVaultSchema(pool) {
  if (!pool) return { skipped: true };

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_documents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category VARCHAR(64) NOT NULL,
      file_name TEXT NOT NULL,
      file_mime_type VARCHAR(128),
      file_size_bytes INTEGER,
      file_data BYTEA,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS category VARCHAR(64)`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS file_name TEXT`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS file_mime_type VARCHAR(128)`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS file_size_bytes INTEGER`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS file_data BYTEA`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS notes TEXT`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS audit_status VARCHAR(32) DEFAULT 'stored'`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS analysis_id INTEGER`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS audit_headline TEXT`);
  await pool.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS audit_severity VARCHAR(16)`);

  try {
    await pool.query(
      `CREATE INDEX IF NOT EXISTS user_documents_user_category_idx
       ON user_documents (user_id, category, created_at DESC)`
    );
  } catch (err) {
    console.warn('[ensureVaultSchema] index note:', err.message);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_benefits_data (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      document_id INTEGER REFERENCES user_documents(id) ON DELETE SET NULL,
      employer_name TEXT,
      employee_contribution_percent NUMERIC(8,4),
      match_rate_percent NUMERIC(8,4),
      match_max_percent NUMERIC(8,4),
      vesting_schedule TEXT,
      hsa_employer_seed_cents INTEGER,
      hsa_plan_type VARCHAR(32),
      hsa_employee_contribution_cents INTEGER,
      dental_annual_max_cents INTEGER,
      dental_used_cents INTEGER DEFAULT 0,
      vision_annual_max_cents INTEGER,
      vision_used_cents INTEGER DEFAULT 0,
      tuition_max_cents INTEGER,
      education_spent_cents INTEGER DEFAULT 0,
      base_salary_cents INTEGER,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_report_uploaded BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_gate_status VARCHAR(32) DEFAULT 'pending'`);

  return { ok: true };
}

module.exports = { ensureVaultSchema };
