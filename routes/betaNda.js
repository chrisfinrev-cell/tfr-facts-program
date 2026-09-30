const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');

function getDb(req) {
  return req.app.get('db') || pool;
}

// --- HELPER: GENERATE UNIQUE 8-CHAR REFERRAL CODE ---
function generateReferralCode() {
  return 'FACTS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// --- MIDDLEWARE: ENFORCE NDA ACCEPTANCE ON PROTECTED ROUTES ---
async function enforceNda(req, res, next) {
  // If beta NDA flag is disabled globally, skip check
  if (process.env.REQUIRE_BETA_NDA === 'false') {
    return next();
  }

  // Ensure user is authenticated
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }

  // Exclude NDA page and NDA submit endpoint from redirect loop
  if (req.path === '/nda' || req.path === '/nda.html' || req.path === '/api/nda/accept') {
    return next();
  }

  if (req.session.ndaAcceptedAt) {
    return next();
  }

  try {
    const db = getDb(req);
    const result = await db.query(
      'SELECT nda_accepted_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    const acceptedAt = result.rows[0] && result.rows[0].nda_accepted_at;
    if (acceptedAt) {
      req.session.ndaAcceptedAt = acceptedAt;
      return next();
    }
  } catch (err) {
    console.error('NDA enforcement check failed:', err);
  }

  return res.redirect('/nda');
}

// --- 1. POST /api/auth/register-beta ---
router.post('/api/auth/register-beta', async (req, res) => {
  const { email, password, inviteCode } = req.body;
  const db = getDb(req);

  if (!email || !password || !inviteCode) {
    return res.status(400).json({ error: 'Email, password, and invite code are required.' });
  }

  try {
    let referrerId = null;

    // Check if inviteCode is a Master Beta Code
    const masterCodeRes = await db.query(
      'SELECT * FROM beta_codes WHERE code = $1 AND uses_count < max_uses',
      [inviteCode.trim()]
    );

    if (masterCodeRes.rows.length > 0) {
      // Valid master code: Increment usage
      await db.query('UPDATE beta_codes SET uses_count = uses_count + 1 WHERE id = $1', [masterCodeRes.rows[0].id]);
    } else {
      // Check if inviteCode is a User Referral Code
      const userCodeRes = await db.query(
        'SELECT id, monthly_invites_remaining FROM users WHERE referral_code = $1 AND monthly_invites_remaining > 0',
        [inviteCode.trim()]
      );

      if (userCodeRes.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid or expired invite code.' });
      }

      referrerId = userCodeRes.rows[0].id;
      // Deduct 1 invite from referrer
      await db.query(
        'UPDATE users SET monthly_invites_remaining = monthly_invites_remaining - 1 WHERE id = $1',
        [referrerId]
      );
    }

    // Generate unique referral code for the new user
    const newUserReferralCode = generateReferralCode();
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert New User
    const newUserRes = await db.query(
      `INSERT INTO users (email, password_hash, referral_code, referrer_id, is_beta_tester)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id, email, nda_accepted_at`,
      [email.toLowerCase(), passwordHash, newUserReferralCode, referrerId]
    );

    const newUser = newUserRes.rows[0];

    // Invited testers can join income programs. Admin accounts cannot.
    const { isAdminIncomeBlockedUser } = require('../config/adminIncomePolicy');
    const roleRes = await db.query(
      'SELECT is_admin, is_creator, email FROM users WHERE id = $1',
      [newUser.id]
    );
    if (!isAdminIncomeBlockedUser(roleRes.rows[0])) {
      await db.query(
        `INSERT INTO affiliate_houses (user_id, house_number, status) VALUES ($1, 1, 'active'), ($1, 2, 'active')`,
        [newUser.id]
      );
    }

    // Set Session
    req.session.userId = newUser.id;
    req.session.ndaAcceptedAt = newUser.nda_accepted_at;

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      referralCode: newUserReferralCode,
      requiresNda: !newUser.nda_accepted_at
    });

  } catch (err) {
    console.error('Beta registration error:', err);
    return res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

// --- 2. POST /api/nda/accept ---
router.post('/api/nda/accept', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  const db = getDb(req);

  try {
    const typedSignature = String(
      (req.body && (req.body.typedSignature || req.body.ndaSignature || req.body.signature)) || ''
    ).trim();
    const userAgent = String(req.headers['user-agent'] || '');
    const forwarded = req.headers['x-forwarded-for'];
    const ipAddress = (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.ip || '')
      .toString()
      .split(',')[0]
      .trim() || null;

    let result;
    try {
      result = await db.query(
        `UPDATE users
         SET nda_accepted_at = NOW(),
             nda_version = '1.0',
             nda_typed_signature = COALESCE(NULLIF($2, ''), nda_typed_signature),
             nda_user_agent = COALESCE(NULLIF($3, ''), nda_user_agent),
             nda_signed_ip = COALESCE($4, nda_signed_ip)
         WHERE id = $1
         RETURNING nda_accepted_at`,
        [req.session.userId, typedSignature, userAgent, ipAddress]
      );
    } catch (columnErr) {
      console.warn('NDA audit columns missing; recording acceptance without signature metadata.', columnErr && columnErr.message);
      result = await db.query(
        `UPDATE users
         SET nda_accepted_at = NOW(), nda_version = '1.0'
         WHERE id = $1
         RETURNING nda_accepted_at`,
        [req.session.userId]
      );
    }

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'User not found.' });
    }

    await db.query(
      `INSERT INTO nda_acceptances (user_id, accepted_at, nda_version, ip_address)
       VALUES ($1, NOW(), $2, $3)
       ON CONFLICT (user_id, nda_version) DO UPDATE SET accepted_at = NOW()`,
      [req.session.userId, 'v1', ipAddress]
    );

    // Update Session
    req.session.ndaAcceptedAt = result.rows[0].nda_accepted_at;

    return res.json({ success: true, redirectUrl: '/dashboard' });
  } catch (err) {
    console.error('NDA Acceptance Error:', err);
    return res.status(500).json({ error: 'Failed to record NDA acceptance.' });
  }
});

module.exports = { router, enforceNda };
