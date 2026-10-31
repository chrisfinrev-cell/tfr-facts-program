/**
 * Document vault table + credit-report gate columns.
 * Fixes /api/vault/documents list+upload 500 when user_documents is missing.
 */
module.exports = {
  name: 'user_documents_vault',
  up: async (client) => {
    await client.query(`
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
    await client.query(
      `CREATE INDEX IF NOT EXISTS user_documents_user_category_idx
       ON user_documents (user_id, category, created_at DESC)`
    );

    await client.query(`
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

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_report_uploaded BOOLEAN DEFAULT FALSE`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS credit_gate_status VARCHAR(32) DEFAULT 'pending'`);
  }
};
