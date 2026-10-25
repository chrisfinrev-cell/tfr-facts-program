'use strict';

/**
 * Permanent single-use flags for the 6-month and 12-month Lifestyle celebrations,
 * plus the reserve months and discretionary choices that drive the velocity ladder.
 */
module.exports = {
  name: 'reserve_velocity_protocol',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_reserve_protocol (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        celebration_6m_claimed BOOLEAN NOT NULL DEFAULT FALSE,
        celebration_12m_claimed BOOLEAN NOT NULL DEFAULT FALSE,
        reserve_months NUMERIC(8,2),
        discretionary_bucket TEXT NOT NULL DEFAULT 'lifestyle',
        lifestyle_cap NUMERIC(5,2),
        discretionary_cap NUMERIC(5,2),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
};
