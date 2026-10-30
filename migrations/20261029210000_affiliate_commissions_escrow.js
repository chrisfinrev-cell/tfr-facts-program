'use strict';

/**
 * Escrow-aware affiliate commission rows for forensic remediation hold/release.
 */
module.exports = {
  name: 'affiliate_commissions_escrow',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS affiliate_commissions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        affiliate_id INTEGER,
        amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
        payout_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_escrow
        ON affiliate_commissions (payout_status, affiliate_id)
    `);
  }
};
