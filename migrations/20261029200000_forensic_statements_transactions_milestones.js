'use strict';

/**
 * Forensic statement batches, parsed transaction staging, and milestone tracking.
 * user_id is UUID-compatible text storage (app may pass numeric user ids as UUID-shaped or cast strings).
 */
module.exports = {
  name: 'forensic_statements_transactions_milestones',
  up: async (client) => {
    // Track uploaded statement batches for forensic baselines
    await client.query(`
      CREATE TABLE IF NOT EXISTS forensic_statements (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL,
        filename VARCHAR(255) NOT NULL,
        file_type VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'PENDING',
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_statements_user
        ON forensic_statements (user_id, uploaded_at DESC)
    `);

    // Parsed transaction staging table for baseline analysis
    await client.query(`
      CREATE TABLE IF NOT EXISTS forensic_transactions (
        id SERIAL PRIMARY KEY,
        statement_id INT REFERENCES forensic_statements(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        txn_date DATE NOT NULL,
        description TEXT NOT NULL,
        amount NUMERIC(12, 2) NOT NULL,
        bucket_assignment VARCHAR(50) DEFAULT 'UNASSIGNED',
        is_anomaly BOOLEAN DEFAULT FALSE,
        anomaly_reason TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_transactions_statement
        ON forensic_transactions (statement_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_transactions_user
        ON forensic_transactions (user_id, txn_date DESC)
    `);

    // Milestone audit tracking table (Day 90, Day 180, Annual)
    await client.query(`
      CREATE TABLE IF NOT EXISTS forensic_milestones (
        id SERIAL PRIMARY KEY,
        user_id UUID NOT NULL,
        milestone_type VARCHAR(50) NOT NULL,
        due_date TIMESTAMP NOT NULL,
        completed_at TIMESTAMP,
        status VARCHAR(50) DEFAULT 'PENDING',
        audit_summary JSONB
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_milestones_user_type
        ON forensic_milestones (user_id, milestone_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_milestones_due
        ON forensic_milestones (status, due_date)
    `);
  }
};
