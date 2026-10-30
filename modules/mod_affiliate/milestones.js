'use strict';

/**
 * Record partner milestone achievements when a referred user hits key FACTS events.
 */

const DEFAULT_REWARD_UNITS = 10.0;

/**
 * @param {import('pg').Pool} pool
 * @param {number|string} referredUserId
 * @param {string} milestoneType  e.g. 'bucket_setup_complete', 'reserve_protocol_active'
 * @param {number} [rewardUnits]
 * @returns {Promise<{ recorded: boolean, partnerId?: number, milestoneId?: number, reason?: string }>}
 */
async function recordAffiliateMilestone(pool, referredUserId, milestoneType, rewardUnits) {
  const userId = parseInt(referredUserId, 10);
  const type = String(milestoneType || '').trim();
  const units = rewardUnits == null ? DEFAULT_REWARD_UNITS : Number(rewardUnits);

  if (!pool || !userId || !type) {
    return { recorded: false, reason: 'invalid_args' };
  }

  try {
    const referralCheck = await pool.query(
      `SELECT partner_id
         FROM affiliate_referrals
        WHERE referred_user_id = $1
        ORDER BY id ASC
        LIMIT 1`,
      [userId]
    );

    if (!referralCheck.rows.length) {
      return { recorded: false, reason: 'no_referral' };
    }

    const partnerId = referralCheck.rows[0].partner_id;

    // Idempotent: one row per partner + referred user + milestone type
    const existing = await pool.query(
      `SELECT id FROM affiliate_milestones
        WHERE partner_id = $1
          AND referred_user_id = $2
          AND milestone_type = $3
        LIMIT 1`,
      [partnerId, userId, type]
    );
    if (existing.rows[0]) {
      return {
        recorded: false,
        reason: 'already_recorded',
        partnerId,
        milestoneId: existing.rows[0].id
      };
    }

    const inserted = await pool.query(
      `INSERT INTO affiliate_milestones
         (partner_id, referred_user_id, milestone_type, reward_units)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [partnerId, userId, type, Number.isFinite(units) ? units : DEFAULT_REWARD_UNITS]
    );

    // Keep referral status in sync for funnel reporting
    await pool.query(
      `UPDATE affiliate_referrals
          SET status = CASE
                WHEN $2 = 'bucket_setup_complete' THEN 'active_bucket_set'
                WHEN status = 'registered' THEN 'onboarded'
                ELSE status
              END,
              conversion_date = COALESCE(conversion_date, NOW())
        WHERE partner_id = $1 AND referred_user_id = $3`,
      [partnerId, type, userId]
    ).catch(function () { /* non-fatal */ });

    return {
      recorded: true,
      partnerId,
      milestoneId: inserted.rows[0].id
    };
  } catch (err) {
    console.error('[recordAffiliateMilestone]', err.message);
    return { recorded: false, reason: 'error', error: err.message };
  }
}

module.exports = {
  recordAffiliateMilestone,
  DEFAULT_REWARD_UNITS
};
