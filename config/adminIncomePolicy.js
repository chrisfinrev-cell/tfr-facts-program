'use strict';

const INCOME_BLOCK_ERROR =
  'This account is not eligible for income-generating programs.';

function creatorEmail() {
  return String(process.env.CREATOR_EMAIL || 'chris.finrev@gmail.com').toLowerCase();
}

function isFounderAdmin(user) {
  if (!user) return false;
  if (user.is_admin === true || user.is_creator === true) return true;
  const email = user.email && String(user.email).toLowerCase();
  return !!(email && email === creatorEmail());
}

function isAdminIncomeBlockedUser(user) {
  if (!user) return false;
  if (isFounderAdmin(user)) return true;
  return user.income_programs_blocked === true;
}

async function loadIncomeBlockFlags(db, userId) {
  if (!db || !userId) {
    return { is_admin: false, is_creator: false, email: null, income_programs_blocked: false, blocked: false };
  }
  try {
    const result = await db.query(
      `SELECT is_admin, is_creator, email, income_programs_blocked FROM users WHERE id = $1`,
      [userId]
    );
    const user = result.rows[0] || {};
    return {
      is_admin: !!user.is_admin,
      is_creator: !!user.is_creator,
      email: user.email || null,
      income_programs_blocked: !!user.income_programs_blocked,
      blocked: isAdminIncomeBlockedUser(user)
    };
  } catch (err) {
    const fallback = await db.query(
      `SELECT is_admin, is_creator, email FROM users WHERE id = $1`,
      [userId]
    ).catch(() => ({ rows: [] }));
    const user = fallback.rows[0] || {};
    return {
      is_admin: !!user.is_admin,
      is_creator: !!user.is_creator,
      email: user.email || null,
      income_programs_blocked: false,
      blocked: isAdminIncomeBlockedUser(user)
    };
  }
}

async function userBlockedFromIncomePrograms(db, userId) {
  const flags = await loadIncomeBlockFlags(db, userId);
  return flags.blocked;
}

async function blockAdminIncomePrograms(req, res, next) {
  if (!req.session || !req.session.userId) {
    return next();
  }
  const db = (req.app && req.app.get('db')) || null;
  try {
    if (await userBlockedFromIncomePrograms(db, req.session.userId)) {
      return res.status(403).json({
        error: INCOME_BLOCK_ERROR,
        code: 'ADMIN_INCOME_BLOCKED'
      });
    }
  } catch (err) {
    console.error('Admin income-program check failed:', err.message);
  }
  return next();
}

module.exports = {
  INCOME_BLOCK_ERROR,
  isFounderAdmin,
  isAdminIncomeBlockedUser,
  loadIncomeBlockFlags,
  userBlockedFromIncomePrograms,
  blockAdminIncomePrograms
};
