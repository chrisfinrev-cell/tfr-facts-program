'use strict';

/**
 * Forensic audit report history + affiliate milestone cadence columns.
 */
module.exports = {
  name: 'forensic_audit_reports_and_affiliate_cadence',
  up: async (client) => {
    // 1. Create table to store historical forensic audit reports and status
    await client.query(`
      CREATE TABLE IF NOT EXISTS forensic_audit_reports (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        audit_type VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        bucket_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
        flags JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_audit_reports_user_created
        ON forensic_audit_reports (user_id, created_at DESC)
    `);

    // 2. Add milestone tracking columns to affiliates if not already present
    await client.query(`
      ALTER TABLE affiliates
        ADD COLUMN IF NOT EXISTS account_created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        ADD COLUMN IF NOT EXISTS audit_cadence VARCHAR(32) DEFAULT 'INITIAL',
        ADD COLUMN IF NOT EXISTS last_audit_status VARCHAR(32) DEFAULT 'PENDING'
    `);
  }
};
