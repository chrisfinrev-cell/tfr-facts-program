'use strict';

/**
 * Debt Reduction ledger rows used by /api/debts and the income avalanche sweep.
 * Inferred from routes/debt.js, scripts/seed-sandbox.js, and modules/engine/transactionalEngine.js
 * (no prior migration existed).
 */
module.exports = {
  name: 'create_debts_table',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS debts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
        interest_rate NUMERIC(8, 4) NOT NULL DEFAULT 0,
        minimum_payment NUMERIC(12, 2) NOT NULL DEFAULT 0,
        current_payment NUMERIC(12, 2),
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_debts_user_id
        ON debts (user_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_debts_user_rate_balance
        ON debts (user_id, interest_rate DESC, balance DESC)
    `);
  }
};
