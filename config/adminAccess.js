'use strict';

// Accounts that can open the admin dashboard from inside the app.
// users.is_admin remains sufficient. These emails stay admin when that flag
// was never written. Personal owner addresses are not included.
const FOUNDER_ADMIN_EMAIL = 'chris.finrev@gmail.com';

const ADMIN_EMAILS = [
  FOUNDER_ADMIN_EMAIL,
  'ecci2760@gmail.com',
  'wtrchrisparks@gmail.com',
  'admin@factsmoney.com',
  'admin@thefinancialrevolution.net'
];

function adminEmailSet() {
  const emails = new Set(ADMIN_EMAILS);
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(function (email) { return email.trim().toLowerCase(); })
    .filter(Boolean)
    .forEach(function (email) { emails.add(email); });
  return emails;
}

function isFounderAdminEmail(email) {
  return String(email || '').trim().toLowerCase() === FOUNDER_ADMIN_EMAIL;
}

function isAllowlistedAdminEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  return adminEmailSet().has(normalized) || isFounderAdminEmail(normalized);
}

function roleIsAdmin(role) {
  const name = String(role || '').trim().toUpperCase();
  return name === 'ADMIN' || name === 'SUPER_ADMIN';
}

function userIsAdminAccount(row) {
  if (!row) return false;
  return !!(row.is_admin || roleIsAdmin(row.role) || isAllowlistedAdminEmail(row.email));
}

/** Where a successful login should land. Allowlisted admins stay on the admin panel. */
function loginRedirectFor(user) {
  return userIsAdminAccount(user) ? '/admin' : '/app';
}

async function loadAdminFlags(db, userId) {
  if (!db || !userId) return null;
  try {
    const result = await db.query(
      'SELECT email, is_admin, is_creator, role FROM users WHERE id = $1',
      [userId]
    );
    return result.rows[0] || null;
  } catch (err) {
    if (err && err.code !== '42703') throw err;
    const result = await db.query(
      'SELECT email, is_admin, is_creator FROM users WHERE id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }
}

async function userCanOpenAdmin(db, userId) {
  const row = await loadAdminFlags(db, userId);
  return userIsAdminAccount(row);
}

module.exports = {
  FOUNDER_ADMIN_EMAIL,
  ADMIN_EMAILS,
  isFounderAdminEmail,
  isAllowlistedAdminEmail,
  roleIsAdmin,
  userIsAdminAccount,
  loadAdminFlags,
  userCanOpenAdmin,
  loginRedirectFor
}
