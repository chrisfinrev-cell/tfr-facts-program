'use strict';

const { mergeProtocolOptions } = require('./reserve-velocity-protocol');

const MISSING_TABLE = '42P01';

async function lockReserveProtocol(client, userId) {
  try {
    await client.query(
      `INSERT INTO user_reserve_protocol (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    const result = await client.query(
      `SELECT celebration_6m_claimed, celebration_12m_claimed, reserve_months,
              discretionary_bucket, lifestyle_cap, discretionary_cap
         FROM user_reserve_protocol
        WHERE user_id = $1
        FOR UPDATE`,
      [userId]
    );
    return result.rows[0] || null;
  } catch (err) {
    if (err.code === MISSING_TABLE) return null;
    throw err;
  }
}

async function persistReserveProtocol(client, userId, state) {
  if (!state) return false;
  try {
    await client.query(
      `INSERT INTO user_reserve_protocol (
         user_id, celebration_6m_claimed, celebration_12m_claimed,
         reserve_months, discretionary_bucket, lifestyle_cap, discretionary_cap, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         celebration_6m_claimed = user_reserve_protocol.celebration_6m_claimed OR EXCLUDED.celebration_6m_claimed,
         celebration_12m_claimed = user_reserve_protocol.celebration_12m_claimed OR EXCLUDED.celebration_12m_claimed,
         reserve_months = EXCLUDED.reserve_months,
         discretionary_bucket = EXCLUDED.discretionary_bucket,
         lifestyle_cap = EXCLUDED.lifestyle_cap,
         discretionary_cap = EXCLUDED.discretionary_cap,
         updated_at = NOW()`,
      [
        userId,
        state.celebration_6m_claimed === true,
        state.celebration_12m_claimed === true,
        state.reserve_months,
        state.discretionary_bucket || 'lifestyle',
        state.lifestyle_cap,
        state.discretionary_cap
      ]
    );
    return true;
  } catch (err) {
    if (err.code === MISSING_TABLE) return false;
    throw err;
  }
}

function optionsForUser(stored, requested) {
  return mergeProtocolOptions(stored, requested);
}

module.exports = {
  lockReserveProtocol,
  persistReserveProtocol,
  optionsForUser
};
