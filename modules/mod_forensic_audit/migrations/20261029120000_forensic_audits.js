'use strict';

/**
 * mod_forensic_audit — baseline audit result storage
 */
module.exports = {
  name: 'mod_forensic_audit_audits',
  up: async (client) => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS mod_forensic_audit`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS mod_forensic_audit.audits (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        audit_type VARCHAR(64) NOT NULL DEFAULT 'INITIAL_BASELINE',
        source_filename TEXT,
        total_analyzed INTEGER NOT NULL DEFAULT 0,
        bucket_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
        flags JSONB NOT NULL DEFAULT '[]'::jsonb,
        classifications JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_audits_user
        ON mod_forensic_audit.audits (user_id, created_at DESC)
    `);
  }
};
