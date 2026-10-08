'use strict';

// Accounts that can open the admin dashboard from inside the app.
// users.is_admin remains sufficient. These emails stay admin when that flag
// was never written. Personal owner addresses are not included.
const ADMIN_EMAILS = [
  'chris.finrev@gmail.com',
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

function isAllowlistedAdminEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return false;
  return adminEmailSet().has(normalized);
}

function userIsAdminAccount(row) {
  return !!(row && (row.is_admin || isAllowlistedAdminEmail(row.email)));
}

async function userCanOpenAdmin(db, userId) {
  if (!db || !userId) return false;
  const result = await db.query(
    'SELECT is_admin, email FROM users WHERE id = $1',
    [userId]
  );
  return userIsAdminAccount(result.rows[0]);
}

module.exports = {
  ADMIN_EMAILS,
  isAllowlistedAdminEmail,
  userIsAdminAccount,
  userCanOpenAdmin
};
