'use strict';

const { FOUNDER_ADMIN_EMAIL } = require('../config/adminAccess');

/**
 * Give the founder account admin status after a reset.
 * Updates an existing row only. Does not create a login or replace a password.
 */
async function promoteFounderAdmin(db) {
  if (!db || typeof db.query !== 'function') {
    return { email: FOUNDER_ADMIN_EMAIL, updated: 0, skipped: true };
  }

  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(32) DEFAULT 'member'`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_creator BOOLEAN DEFAULT FALSE`);

  let result;
  try {
    result = await db.query(
      `UPDATE users
          SET role = 'ADMIN',
              is_admin = TRUE,
              is_creator = TRUE,
              updated_at = NOW()
        WHERE LOWER(email) = LOWER($1)`,
      [FOUNDER_ADMIN_EMAIL]
    );
  } catch (err) {
    if (!err || err.code !== '42703') throw err;
    result = await db.query(
      `UPDATE users
          SET role = 'ADMIN',
              is_admin = TRUE,
              is_creator = TRUE
        WHERE LOWER(email) = LOWER($1)`,
      [FOUNDER_ADMIN_EMAIL]
    );
  }

  return {
    email: FOUNDER_ADMIN_EMAIL,
    updated: result.rowCount || 0
  };
}

module.exports = { promoteFounderAdmin };
