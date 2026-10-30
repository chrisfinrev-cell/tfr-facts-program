'use strict';

/**
 * Partner profiles, referral mappings, and milestone achievement logs
 * for the two-tier affiliate / partner code system.
 */
module.exports = {
  name: 'partners_affiliate_referrals_milestones',
  up: async (client) => {
    // 1. Partners — partner profiles and custom codes
    await client.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id) ON DELETE CASCADE,
        partner_code VARCHAR(50) UNIQUE NOT NULL,
        tier INT DEFAULT 1,
        parent_partner_id INT REFERENCES partners(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_partners_user_id
        ON partners (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_partners_parent
        ON partners (parent_partner_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_partners_status
        ON partners (status)
    `);

    // 2. Affiliate Referrals — maps referred users to partners
    await client.query(`
      CREATE TABLE IF NOT EXISTS affiliate_referrals (
        id SERIAL PRIMARY KEY,
        partner_id INT REFERENCES partners(id) ON DELETE CASCADE,
        referred_user_id INT REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(30) DEFAULT 'registered',
        conversion_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_partner
        ON affiliate_referrals (partner_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_user
        ON affiliate_referrals (referred_user_id)
    `);

    // 3. Affiliate Milestone Logs — reward / tier progression events
    await client.query(`
      CREATE TABLE IF NOT EXISTS affiliate_milestones (
        id SERIAL PRIMARY KEY,
        partner_id INT REFERENCES partners(id) ON DELETE CASCADE,
        referred_user_id INT REFERENCES users(id) ON DELETE CASCADE,
        milestone_type VARCHAR(50) NOT NULL,
        reward_units NUMERIC(12, 2) DEFAULT 0.00,
        achieved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_affiliate_milestones_partner
        ON affiliate_milestones (partner_id, achieved_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_affiliate_milestones_type
        ON affiliate_milestones (milestone_type)
    `);
  }
};
