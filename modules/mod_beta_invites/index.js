// mod_beta_invites — member referral invites during the beta
//
// Owns: the member Invites page API. Members invite people with their own
//       referral code; while BETA_INVITE_ONLY is on, each code can bring in
//       MEMBER_MONTHLY_REFERRALS signups per calendar month.
//
// Does NOT own: the beta_invites table, the admin pool (lib/inviteCodes.js,
//               routes/admin.js), or signup, which enforces the limit (server.js).

'use strict';

const crypto = require('crypto');
const express = require('express');
const { pool: sharedPool } = require('../../db/pool');
const { requireAuth } = require('../../routes/auth');
const { betaInviteOnly, memberReferralUsage } = require('../../lib/inviteCodes');
const { sendBetaInviteEmail, appBaseUrl } = require('../../lib/betaInviteEmail');

const router = express.Router();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function getDb(req) {
  return req.app.get('db') || sharedPool;
}

function referralLink(code) {
  return `${appBaseUrl()}/signup.html?ref=${encodeURIComponent(code)}`;
}

async function loadMember(db, userId) {
  const result = await db.query(
    'SELECT id, email, name, is_admin, referral_code FROM users WHERE id = $1',
    [userId]
  );
  const member = result.rows[0];
  if (!member || member.referral_code) return member || null;

  for (let attempt = 0; attempt < 20; attempt++) {
    let code = 'FACTS-';
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    const saved = await db.query(
      `UPDATE users SET referral_code = $1
       WHERE id = $2 AND referral_code IS NULL
         AND NOT EXISTS (SELECT 1 FROM users WHERE referral_code = $1)
       RETURNING referral_code`,
      [code, member.id]
    );
    if (saved.rows[0]) return { ...member, referral_code: saved.rows[0].referral_code };
  }
  return member;
}

async function describe(db, member) {
  const usage = await memberReferralUsage(db, member);
  const unlimited = usage.limit === null;
  return {
    code: member.referral_code,
    link: member.referral_code ? referralLink(member.referral_code) : null,
    betaInviteOnly: betaInviteOnly(),
    unlimited,
    limit: usage.limit,
    usedThisMonth: usage.usedThisMonth,
    remaining: unlimited ? null : usage.remaining
  };
}

// GET /api/mod_beta_invites/mine — the member's referral code, link, and this month's count.
router.get('/mine', requireAuth, async (req, res) => {
  const db = getDb(req);
  try {
    const member = await loadMember(db, req.userId);
    if (!member) return res.status(404).json({ error: 'Account not found.' });
    return res.json({ success: true, ...(await describe(db, member)) });
  } catch (err) {
    console.error('[mod_beta_invites] load error:', err);
    return res.status(500).json({ error: `Could not load your referral code: ${err.message}` });
  }
});

// POST /api/mod_beta_invites/send — emails the member's referral link to someone.
router.post('/send', requireAuth, async (req, res) => {
  const db = getDb(req);
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Enter the email of the person you are inviting.' });
  }
  try {
    const member = await loadMember(db, req.userId);
    if (!member || !member.referral_code) {
      return res.status(404).json({ error: 'Your referral code is not ready yet. Refresh and try again.' });
    }
    const info = await describe(db, member);
    if (info.betaInviteOnly && !info.unlimited && info.remaining <= 0) {
      return res.status(409).json({
        error: `Your code has already brought in ${info.limit} people this month. You can invite more next month.`
      });
    }
    const result = await sendBetaInviteEmail({
      to: email,
      name: body.name ? String(body.name).trim() : '',
      code: member.referral_code,
      signupUrl: info.link
    });
    return res.json({
      success: true,
      emailSent: !!result.sent,
      link: info.link,
      message: result.sent
        ? `Sent your invite link to ${email}.`
        : `The email did not go out (${result.error}). Copy your link and send it yourself.`
    });
  } catch (err) {
    console.error('[mod_beta_invites] send error:', err);
    return res.status(500).json({ error: `Could not send that invite: ${err.message}` });
  }
});

router.get('/health', (req, res) => res.json({ status: 'ok' }));

module.exports = {
  routes: router,
  metadata: {
    name: 'Beta Invites',
    version: '1.1.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true
  },
  healthCheck: async () => ({ status: 'ok', version: '1.1.0', lastMigration: null })
};
