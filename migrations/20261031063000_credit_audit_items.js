/**
 * Persistent strike-through checklist items for forensic credit analyses.
 */
module.exports = {
  name: 'credit_audit_items',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS credit_audit_items (
        id SERIAL PRIMARY KEY,
        analysis_id INTEGER NOT NULL REFERENCES credit_analyses(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        item_key VARCHAR(64) NOT NULL,
        item_type VARCHAR(32) NOT NULL,
        label TEXT NOT NULL,
        details TEXT,
        bureau VARCHAR(64),
        creditor TEXT,
        amount NUMERIC(12,2),
        resolved BOOLEAN NOT NULL DEFAULT FALSE,
        resolved_at TIMESTAMPTZ,
        letter_type VARCHAR(32),
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (analysis_id, item_key)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS credit_audit_items_analysis_idx
        ON credit_audit_items (analysis_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS credit_audit_items_user_idx
        ON credit_audit_items (user_id)
    `);
  }
};
