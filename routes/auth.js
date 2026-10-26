'use strict';

/**
 * Authentication routes and middleware.
 * Mounted at /api/auth so existing clients keep calling /api/auth/login, /me, etc.
 * (A bare /auth mount would break the live app.)
 *
 * Also exports requireAuth for other routers, and bindAuthRuntime() so server.js
 * can hand over helpers that still live in the legacy god file.
 */

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const path = require('path');
const twilio = require('twilio');
const { pool } = require('../db/pool');
const { sendEmail, emailConfigured } = require('../lib/mailer');
const { applyPrivateCache } = require('../lib/privateCache');
const { SAFE_MODE } = require('../lib/safeMode');
const {
  isAllowlistedAdminEmail,
  userIsAdminAccount,
  loginRedirectFor,
  isFounderAdminEmail
} = require('../config/adminAccess');
const { isAdminIncomeBlockedUser } = require('../config/adminIncomePolicy');
const {
  sendVerification: twilioSendVerification,
  checkVerification: twilioCheckVerification
} = require('../services/twilio');

const router = express.Router();
const pageRouter = express.Router();

const E164 = /^\+[1-9]\d{6,14}$/;
const OTP = /^\d{6}$/;
const runtime = {};

function bindAuthRuntime(helpers) {
  Object.assign(runtime, helpers || {});
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.userId = req.session.userId;
  next();
}

function optionalAuth(req, res, next) {
  if (req.session && req.session.userId) {
    req.userId = req.session.userId;
  }
  next();
}

function normalizePhone(value) {
  if (value == null) return '';
  return String(value).trim();
}

function getVerifyClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_ID;
  if (!accountSid || !authToken || !serviceSid) return null;
  return {
    client: twilio(accountSid, authToken),
    serviceSid
  };
}

async function startVerification(phone) {
  if (typeof runtime.startVerification === 'function') return runtime.startVerification(phone);
  const tw = getVerifyClient();
  if (!tw) {
    const err = new Error('SMS verification is not configured');
    err.status = 503;
    throw err;
  }
  try {
    const verification = await tw.client.verify.v2
      .services(tw.serviceSid)
      .verifications.create({ to: phone, channel: 'sms' });
    return { success: true, status: verification.status };
  } catch (err) {
    console.error('[auth] Twilio Verify start failed:', err.message);
    const failed = new Error('Failed to send verification code. Please try again.');
    failed.status = 502;
    throw failed;
  }
}

async function checkVerification(phone, code) {
  if (typeof runtime.checkVerification === 'function') return runtime.checkVerification(phone, code);
  const tw = getVerifyClient();
  if (!tw) {
    const err = new Error('SMS verification is not configured');
    err.status = 503;
    throw err;
  }
  try {
    const check = await tw.client.verify.v2
      .services(tw.serviceSid)
      .verificationChecks.create({ to: phone, code });
    if (check.status === 'approved') return { success: true, status: 'approved' };
    const incorrect = new Error('Incorrect verification code.');
    incorrect.status = 401;
    throw incorrect;
  } catch (err) {
    if (err.status) throw err;
    console.error('[auth] Twilio Verify check failed:', err.message);
    const failed = new Error('Verification failed. Please try again.');
    failed.status = 502;
    throw failed;
  }
}

function sendVerification(phone) {
  return twilioSendVerification(phone);
}

function validatePassword(password) {
  if (typeof runtime.validatePassword === 'function') return runtime.validatePassword(password);
  const errors = [];
  if (!password || String(password).length < 8) errors.push('Password must be at least 8 characters');
  return { valid: errors.length === 0, errors };
}

function hasProAccess(userOrId) {
  if (typeof runtime.hasProAccess === 'function') return runtime.hasProAccess(userOrId);
  return Promise.resolve(false);
}

function buildProResponse(user, hasPro) {
  if (typeof runtime.buildProResponse === 'function') return runtime.buildProResponse(user, hasPro);
  return { plan: hasPro ? 'paid' : 'free', has_pro: !!hasPro, is_creator: !!(user && user.is_creator) };
}

function calculatePromoGraceStatus(user) {
  if (typeof runtime.calculatePromoGraceStatus === 'function') return runtime.calculatePromoGraceStatus(user);
  return { active: false, expired: false, daysRemaining: 0 };
}

function calculateTrialStatus(user) {
  if (typeof runtime.calculateTrialStatus === 'function') return runtime.calculateTrialStatus(user);
  return { active: false, expired: false, daysRemaining: 0, planType: 'individual' };
}

function isCreator(userOrId) {
  if (typeof runtime.isCreator === 'function') return runtime.isCreator(userOrId);
  return Promise.resolve(false);
}

function hasIncubatorSubAccess(userId) {
  if (typeof runtime.hasIncubatorSubAccess === 'function') return runtime.hasIncubatorSubAccess(userId);
  return Promise.resolve(false);
}

function ensureFgBalance(userId) {
  if (typeof runtime.ensureFgBalance === 'function') return runtime.ensureFgBalance(userId);
  return Promise.resolve();
}

function generateUniqueReferralCode() {
  if (typeof runtime.generateUniqueReferralCode === 'function') return runtime.generateUniqueReferralCode();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'FACTS-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return Promise.resolve(code);
}

const CREATOR_EMAIL = String(process.env.CREATOR_EMAIL || 'owner@example.com').toLowerCase();
const NDA_LAUNCH_DATE = process.env.NDA_LAUNCH_DATE
  ? new Date(process.env.NDA_LAUNCH_DATE)
  : new Date('2026-06-30T23:59:00');
const NDA_VERSION = 'v1';
const RESET_EMAIL_SENT = 'Check your email for a link to choose a new password. It expires in one hour.';

function passwordResetBaseUrl(req) {
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || String(req.get('host') || '').trim();
  const local = !host || host.startsWith('localhost') || host.startsWith('127.0.0.1');
  if (!local) {
    const proto = String(req.get('x-forwarded-proto') || 'https').split(',')[0].trim() || 'https';
    return `${proto}://${host}`;
  }
  return String(process.env.APP_URL || 'https://factsmoney.com').replace(/\/$/, '');
}


// ── 2FA HELPER FUNCTIONS ──────────────────────────────────────────────────────

// Parse a specific cookie from the Cookie header (no cookie-parser dependency)
function getCookieValue(req, name) {
  const cookieHeader = req.headers.cookie || '';
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.substring(0, eqIdx).trim();
    if (key === name) {
      try { return decodeURIComponent(trimmed.substring(eqIdx + 1)); }
      catch { return trimmed.substring(eqIdx + 1); }
    }
  }
  return null;
}

// Mask email for display: f***@example.com
function maskEmail(email) {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const masked = local.length <= 2 ? local[0] + '*'.repeat(local.length - 1) : local[0] + '*'.repeat(local.length - 2) + local[local.length - 1];
  return `${masked}@${domain}`;
}

// Generate and store a 6-digit OTP; return the plaintext code
async function send2faCode(userId) {
  // Rate limit: max 3 code requests per hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await pool.query(
    `SELECT COUNT(*) as count FROM two_factor_codes WHERE user_id = $1 AND created_at > $2`,
    [userId, oneHourAgo]
  );
  if (parseInt(recent.rows[0].count) >= 3) {
    const err = new Error('RATE_LIMIT');
    err.code = 'RATE_LIMIT';
    throw err;
  }

  // Invalidate old unused codes
  await pool.query(
    `UPDATE two_factor_codes SET used = TRUE WHERE user_id = $1 AND used = FALSE`,
    [userId]
  );

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  await pool.query(
    `INSERT INTO two_factor_codes (user_id, code, expires_at) VALUES ($1, $2, $3)`,
    [userId, code, expiresAt]
  );

  // Fetch email
  const userResult = await pool.query('SELECT email, name FROM users WHERE id = $1', [userId]);
  if (!userResult.rows.length) throw new Error('User not found');
  const { email, name } = userResult.rows[0];

  const appName = 'FACTS';
  try {
    await sendEmail({
        to: email,
        subject: `${code} is your ${appName} verification code`,
        text: `Your ${appName} login verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, someone may be trying to access your account. You can ignore this email.`,
        html: `
          <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0a0f1a;border-radius:16px;">
            <h2 style="color:#10b981;margin:0 0 8px;font-size:1.4rem;">${appName} Verification Code</h2>
            <p style="color:#94a3b8;margin:0 0 28px;font-size:0.95rem;">Hi ${name || 'there'},</p>
            <p style="color:#e2e8f0;margin:0 0 24px;font-size:0.95rem;line-height:1.6;">
              Use the code below to complete your sign-in. It expires in <strong style="color:#f59e0b;">10 minutes</strong>.
            </p>
            <div style="background:#1a2332;border:2px solid #10b981;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;">
              <span style="font-size:2.5rem;font-weight:700;letter-spacing:12px;color:#10b981;font-family:'Courier New',monospace;">${code}</span>
            </div>
            <p style="color:#64748b;font-size:0.85rem;line-height:1.5;">
              If you didn't try to sign in, someone may have your password. Consider changing it immediately at <a href="${process.env.APP_URL || 'https://app.factsmoney.com'}" style="color:#10b981;">app.factsmoney.com</a>.
            </p>
          </div>`
    });
  } catch (emailErr) {
    console.error('[2FA] Email send error:', emailErr.message);
  }

  return code;
}

// Complete the login session after credentials verified (and optionally 2FA)
async function completeLogin(req, res, user) {
  // Clear pending 2FA state
  delete req.session.pending2faUserId;
  delete req.session.pending2faEmail;

  req.session.userId = user.id;
  req.session.email = user.email;

  // Best-effort login metadata — never block auth if optional columns are missing.
  try {
    await pool.query(
      `UPDATE users SET last_login = NOW(), scheduled_deletion_at = NULL, inactivity_warnings_sent = 0 WHERE id = $1`,
      [user.id]
    );
  } catch (metaErr) {
    console.error('[auth] last_login update skipped:', metaErr.message);
  }

  // Award 10 TFR Points on daily login (max once per calendar day) + login streak tracking
  try {
    await ensureFgBalance(user.id);
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    // Fetch current balance row for streak info
    const balRow = (await pool.query(
      'SELECT last_daily_points_date, login_streak_days, longest_login_streak, last_login_streak_date, monthly_points_earned, monthly_cap_reset_month FROM fg_points_balances WHERE user_id = $1',
      [user.id]
    )).rows[0] || {};
    const alreadyAwarded = balRow.last_daily_points_date && balRow.last_daily_points_date.toISOString
      ? balRow.last_daily_points_date.toISOString().split('T')[0] === today
      : String(balRow.last_daily_points_date || '').split('T')[0] === today;

    if (!alreadyAwarded) {
      // Monthly cap check
      const currentMonth = today.substring(0, 7); // YYYY-MM
      let monthEarned = 0;
      if (balRow.monthly_cap_reset_month === currentMonth) {
        monthEarned = parseInt(balRow.monthly_points_earned) || 0;
      }
      const MONTHLY_CAP = 5000;
      const remainingCap = MONTHLY_CAP - monthEarned;
      const LOGIN_PTS = 10;
      const pointsToAward = Math.min(LOGIN_PTS, Math.max(0, remainingCap));

      // Calculate new login streak
      const lastStreakDate = balRow.last_login_streak_date
        ? String(balRow.last_login_streak_date).split('T')[0]
        : null;
      let newLoginStreak = lastStreakDate === yesterday
        ? (parseInt(balRow.login_streak_days) || 0) + 1
        : 1;
      const newLongestLogin = Math.max(newLoginStreak, parseInt(balRow.longest_login_streak) || 0);

      if (pointsToAward > 0) {
        await pool.query(
          `UPDATE fg_points_balances
           SET balance = balance + $2,
               total_earned = total_earned + $2,
               last_daily_points_date = $3,
               monthly_points_earned = CASE WHEN monthly_cap_reset_month = $4 THEN monthly_points_earned + $2 ELSE $2 END,
               monthly_cap_reset_month = $4,
               login_streak_days = $5,
               last_login_streak_date = $3,
               longest_login_streak = $6,
               updated_at = NOW()
           WHERE user_id = $1`,
          [user.id, pointsToAward, today, currentMonth, newLoginStreak, newLongestLogin]
        );
        await pool.query(
          `INSERT INTO fg_earning_events (user_id, activity_type, description, points)
           VALUES ($1, 'daily_login', 'Daily login — 10 FACTS Points', $2)`,
          [user.id, pointsToAward]
        );
      } else {
        // Still update streak even if cap reached
        await pool.query(
          `UPDATE fg_points_balances
           SET last_daily_points_date = $2,
               login_streak_days = $3,
               last_login_streak_date = $2,
               longest_login_streak = $4,
               monthly_cap_reset_month = $5,
               updated_at = NOW()
           WHERE user_id = $1`,
          [user.id, today, newLoginStreak, newLongestLogin, currentMonth]
        );
      }

      // Login streak bonuses: 7-day → 50 pts, 14-day → 100 pts, 30-day → 250 pts
      const LOGIN_STREAK_BONUSES = { 7: 50, 14: 100, 30: 250 };
      if (LOGIN_STREAK_BONUSES[newLoginStreak]) {
        const bonusPts = LOGIN_STREAK_BONUSES[newLoginStreak];
        const capAfterLogin = monthEarned + pointsToAward;
        const bonusRemaining = Math.max(0, MONTHLY_CAP - capAfterLogin);
        const bonusToAward = Math.min(bonusPts, bonusRemaining);
        if (bonusToAward > 0) {
          await pool.query(
            `UPDATE fg_points_balances
             SET balance = balance + $2,
                 total_earned = total_earned + $2,
                 monthly_points_earned = CASE WHEN monthly_cap_reset_month = $3 THEN monthly_points_earned + $2 ELSE $2 END,
                 monthly_cap_reset_month = $3,
                 updated_at = NOW()
             WHERE user_id = $1`,
            [user.id, bonusToAward, currentMonth]
          );
          await pool.query(
            `INSERT INTO fg_earning_events (user_id, activity_type, description, points)
             VALUES ($1, 'login_streak_bonus', $2, $3)`,
            [user.id, `${newLoginStreak}-Day Login Streak Bonus!`, bonusToAward]
          );
          // Record streak achievement
          await pool.query(
            `INSERT INTO rewards_achievements (user_id, achievement_key, points_awarded)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [user.id, `login_streak_${newLoginStreak}`, bonusToAward]
          );
        }
      }
    }
  } catch (pointsErr) {
    // Non-fatal — don't block login if points award fails
    console.error('[Rewards] daily login points error:', pointsErr.message);
  }

  const hasPro = await hasProAccess(user);
  const proFields = buildProResponse(user, hasPro);

  // Explicitly save session to PostgreSQL BEFORE responding.
  // Without this, the session store write is async and the browser's
  // next request (to /app) can arrive before the session row exists,
  // causing requireAuth to see an empty session — especially on mobile
  // where round-trips are fast relative to DB write latency.
  let landing = loginRedirectFor(user);
  if (landing === '/admin') {
    req.session.adminToolsUntil = Date.now() + (12 * 60 * 60 * 1000);
  } else {
    // Incomplete Phase Zero → resume onboarding (do not dump unfinished beta users on /app).
    try {
      const pz = await pool.query(
        'SELECT phase_zero_completed_at FROM users WHERE id = $1',
        [user.id]
      );
      if (pz.rows[0] && !pz.rows[0].phase_zero_completed_at) {
        landing = '/phase-zero';
        delete req.session.pzComplete;
      } else {
        req.session.pzComplete = true;
      }
    } catch (pzErr) {
      console.error('[auth] phase-zero redirect check skipped:', pzErr.message);
    }
  }

  await new Promise((resolve, reject) => {
    req.session.save(err => err ? reject(err) : resolve());
  });

  // Return JSON so the client does a full-page navigation.
  // Admins land on /admin. Incomplete Phase Zero → /phase-zero. Else /app.
  // A 303 redirect broke on DuckDuckGo Android because fetch's automatic
  // redirect following doesn't reliably include the Set-Cookie.
  return res.json({ success: true, redirect: landing });
}

// ─────────────────────────────────────────────────────────────────────────────


// ── Twilio Verify / phone OTP (legacy createAuthRouter routes) ──
// router already created above

  router.post('/send-otp', async (req, res) => {
    try {
      if (!getVerifyClient()) {
        return res.status(503).json({ error: 'SMS verification is not configured' });
      }
      const phone = normalizePhone(req.body && req.body.phone);
      if (!E164.test(phone)) {
        return res.status(400).json({ error: 'Phone number must be in E.164 format, e.g. +12025551234' });
      }
      const result = await startVerification(phone);
      if (req.session) {
        req.session.pendingVerifyPhone = phone;
      }
      res.json({ success: true, status: result.status });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to send verification code' });
    }
  });

  router.post('/verify-otp', async (req, res) => {
    try {
      if (!getVerifyClient()) {
        return res.status(503).json({ error: 'SMS verification is not configured' });
      }
      const phone = normalizePhone((req.body && req.body.phone) || (req.session && req.session.pendingVerifyPhone));
      const code = String((req.body && req.body.code) || '').trim();
      if (!E164.test(phone)) {
        return res.status(400).json({ error: 'Phone number must be in E.164 format, e.g. +12025551234' });
      }
      if (!OTP.test(code)) {
        return res.status(400).json({ error: 'Please enter a valid 6-digit code.' });
      }
      await checkVerification(phone, code);
      if (req.session) {
        req.session.verifiedPhone = phone;
        delete req.session.pendingVerifyPhone;
      }
      res.json({ success: true, status: 'approved', phone });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Verification failed' });
    }
  });

  router.post('/verify/start', async (req, res) => {
    try {
      const phone = normalizePhone(req.body && req.body.phone);
      if (!E164.test(phone)) {
        return res.status(400).json({ error: 'Phone number must be in E.164 format, e.g. +12025551234' });
      }
      const result = await startVerification(phone);
      if (req.session) {
        req.session.pendingVerifyPhone = phone;
      }
      res.json({ success: true, status: result.status });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to start verification' });
    }
  });

  router.post('/verify/check', async (req, res) => {
    try {
      const phone = normalizePhone((req.body && req.body.phone) || (req.session && req.session.pendingVerifyPhone));
      const code = String((req.body && req.body.code) || '').trim();
      if (!E164.test(phone)) {
        return res.status(400).json({ error: 'Phone number must be in E.164 format, e.g. +12025551234' });
      }
      if (!OTP.test(code)) {
        return res.status(400).json({ error: 'Please enter a valid 6-digit code.' });
      }
      await checkVerification(phone, code);
      if (req.session) {
        req.session.verifiedPhone = phone;
        delete req.session.pendingVerifyPhone;
      }
      res.json({ success: true, status: 'approved', phone });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Verification failed' });
    }
  });

  router.post('/phone/send', requireAuth, async (req, res) => {
    try {
      const phone = normalizePhone(req.body && req.body.phone);
      if (!E164.test(phone)) {
        return res.status(400).json({ error: 'Phone number must be in E.164 format, e.g. +12025551234' });
      }
      const result = await startVerification(phone);
      req.session.pendingVerifyPhone = phone;
      res.json({ success: true, status: result.status });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to send verification code' });
    }
  });

  router.post('/phone/verify', requireAuth, async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({ error: 'Service temporarily unavailable. Please try again in a moment.' });
      }
      const phone = normalizePhone((req.body && req.body.phone) || req.session.pendingVerifyPhone);
      const code = String((req.body && req.body.code) || '').trim();
      if (!E164.test(phone)) {
        return res.status(400).json({ error: 'Phone number must be in E.164 format, e.g. +12025551234' });
      }
      if (!OTP.test(code)) {
        return res.status(400).json({ error: 'Please enter a valid 6-digit code.' });
      }
      await checkVerification(phone, code);
      await pool.query(
        `UPDATE users
            SET verification_method = 'sms',
                verified_phone = $1,
                phone_verified_at = NOW(),
                updated_at = NOW()
          WHERE id = $2`,
        [phone, req.userId]
      );
      delete req.session.pendingVerifyPhone;
      req.session.verifiedPhone = phone;
      res.json({ success: true, method: 'sms', phone });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to verify phone' });
    }
  });

  

pageRouter.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});
pageRouter.get('/login', (req, res) => res.redirect('/login.html'));
pageRouter.get('/signup.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'signup.html'));
});
pageRouter.get('/signup', (req, res) => res.redirect('/signup.html'));
pageRouter.get('/forgot-password.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'forgot-password.html'));
});
pageRouter.get('/forgot-password', (req, res) => res.redirect('/forgot-password.html'));
pageRouter.get('/reset-password.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'reset-password.html'));
});
pageRouter.get('/reset-password', (req, res) => res.redirect('/reset-password.html'));

// ── Core auth API ──
router.post('/signup', async (req, res) => {
  // Guard: database unavailable → return 503 instead of crashing
  if (!pool) {
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again in a moment.' });
  }
  try {
    const { email, password, name, user_id, ref_code, disclaimer_accepted } = req.body;
    const invite_code = (req.body && (req.body.invite_code || req.body.inviteCode)) || '';

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const { valid, errors } = validatePassword(password);
    if (!valid) {
      return res.status(400).json({ error: errors[0], errors });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const normalizedUserId = user_id ? user_id.toLowerCase().trim() : null;

    // Validate user_id format if provided
    if (normalizedUserId) {
      if (normalizedUserId.length < 3 || normalizedUserId.length > 30) {
        return res.status(400).json({ error: 'User ID must be between 3 and 30 characters' });
      }
      if (!/^[a-z0-9_]+$/.test(normalizedUserId)) {
        return res.status(400).json({ error: 'User ID can only contain lowercase letters, numbers, and underscores' });
      }

      // Check if user_id is already taken
      const userIdCheck = await pool.query(
        'SELECT id FROM users WHERE LOWER(user_id) = $1',
        [normalizedUserId]
      );
      if (userIdCheck.rows.length > 0) {
        return res.status(409).json({ error: 'This User ID is already taken. Please choose another.' });
      }
    }

    // Determine if this is the creator email (for is_creator flag on new users)
    const isCreatorEmail = normalizedEmail === CREATOR_EMAIL;

    // During beta, a code is required. Set BETA_INVITE_ONLY=false to open public signup.
    const betaInviteOnly = String(process.env.BETA_INVITE_ONLY || 'true').toLowerCase() !== 'false';
    const suppliedInvite = (invite_code && String(invite_code).trim())
      || (betaInviteOnly && ref_code && String(ref_code).trim())
      || '';
    let effectiveRefCode = ref_code;
    if (betaInviteOnly && !suppliedInvite && !isCreatorEmail && !isAllowlistedAdminEmail(normalizedEmail)) {
      return res.status(403).json({
        code: 'BETA_INVITE_REQUIRED',
        error: 'FACTS is in beta testing and is invite only. A beta code is required to create an account.'
      });
    }

    // ─── INVITE CODE: Optional — validate only if provided ───────────────
    // Shared admin invite_codes first, then promo / targeted / member referral.
    let pendingInviteCode = null;
    let pendingBeta = null;
    if (suppliedInvite) {
      const {
        findInviteCode,
        findActiveBetaInvite,
        findMemberReferralInvite,
        INVALID_INVITE_ERROR
      } = require('../lib/inviteCodes');

      const sharedInvite = await findInviteCode(pool, suppliedInvite);
      if (sharedInvite) {
        if (sharedInvite.status !== 'ACTIVE') {
          return res.status(400).json({ error: INVALID_INVITE_ERROR });
        }
        pendingInviteCode = sharedInvite;
      } else {
        const promoCheck = await pool.query(
          'SELECT id, status FROM promo_codes WHERE UPPER(code) = UPPER($1)',
          [suppliedInvite]
        );

        if (promoCheck.rows.length === 0) {
          pendingBeta = await findActiveBetaInvite(pool, suppliedInvite);
          if (!pendingBeta) {
            const referral = await findMemberReferralInvite(pool, suppliedInvite);
            if (referral && referral.remaining <= 0) {
              return res.status(400).json({
                error: `This referral code has already brought in ${referral.limit} people this month. Ask them again next month, or ask for a beta code.`
              });
            }
            if (referral) {
              pendingBeta = { kind: 'referral', row: referral.user };
              effectiveRefCode = referral.user.referral_code;
            }
          }
          if (!pendingBeta) {
            return res.status(400).json({ error: INVALID_INVITE_ERROR });
          }
        } else if (promoCheck.rows[0].status !== 'active') {
          return res.status(400).json({ error: INVALID_INVITE_ERROR });
        }
      }
    }
    // No code: allowed only when BETA_INVITE_ONLY=false, or for creator/admin emails.

    // Check if user already exists with a password (registered account)
    const existingUser = await pool.query(
      'SELECT id, password_hash FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );

    if (existingUser.rows.length > 0 && existingUser.rows[0].password_hash) {
      return res.status(409).json({ error: 'An account with this email already exists. Please log in.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let userId;
      if (existingUser.rows.length > 0) {
        // User exists (maybe from subscription) but no password — set password
        await client.query(
          `UPDATE users SET password_hash = $1, name = $2, user_id = $3, updated_at = NOW() WHERE id = $4`,
          [passwordHash, name || null, normalizedUserId, existingUser.rows[0].id]
        );
        userId = existingUser.rows[0].id;
      } else {
        // Create new user (isCreatorEmail was already checked above for launch gate)
        const result = await client.query(
          `INSERT INTO users (email, password_hash, name, user_id, is_creator, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           RETURNING id`,
          [normalizedEmail, passwordHash, name || null, normalizedUserId, isCreatorEmail]
        );
        userId = result.rows[0].id;
      }

      // Seed default allocation percentages for this user
      await seedUserAllocations(client, userId);

      // ─── Redeem invite code if provided ───────────────────────────────
      if (suppliedInvite) {
        if (pendingInviteCode) {
          const { redeemInviteCode, INVALID_INVITE_ERROR } = require('../lib/inviteCodes');
          const redeemed = await redeemInviteCode(client, suppliedInvite, userId);
          if (!redeemed) {
            const used = new Error(INVALID_INVITE_ERROR);
            used.status = 400;
            throw used;
          }
          await client.query('SAVEPOINT beta_claim_user');
          try {
            await client.query(
              `UPDATE users SET is_beta_tester = TRUE, updated_at = NOW() WHERE id = $1`,
              [userId]
            );
            await client.query('RELEASE SAVEPOINT beta_claim_user');
          } catch (betaFlagErr) {
            await client.query('ROLLBACK TO SAVEPOINT beta_claim_user');
            console.warn('[Signup] is_beta_tester update skipped:', betaFlagErr.message);
          }
        }

        // Re-validate code in transaction (double-check it's still active)
        const promoResult = pendingInviteCode
          ? { rows: [] }
          : await client.query(
          'SELECT id, status FROM promo_codes WHERE UPPER(code) = UPPER($1)',
          [suppliedInvite]
        );

        if (promoResult.rows.length > 0 && promoResult.rows[0].status === 'active') {
          const promoId = promoResult.rows[0].id;

          // Mark promo code as redeemed
          await client.query(
            `UPDATE promo_codes
             SET status = 'redeemed', redeemed_by = $1, redeemed_at = NOW()
             WHERE id = $2`,
            [userId, promoId]
          );

          // Grant Pro access to user
          await client.query(
            `UPDATE users
             SET promo_code_used = $1, updated_at = NOW()
             WHERE id = $2`,
            [suppliedInvite.toUpperCase(), userId]
          );
        } else if (pendingBeta) {
        if (pendingBeta.kind === 'invite') {
          const claimed = await client.query(
            `UPDATE beta_invites
             SET uses_count = uses_count + 1,
                 claimed_by_user_id = COALESCE(claimed_by_user_id, $2),
                 claimed_at = COALESCE(claimed_at, NOW())
             WHERE id = $1 AND uses_count < max_uses
             RETURNING id`,
            [pendingBeta.row.id, userId]
          );
          if (claimed.rows.length === 0) {
            const used = new Error('This invite code has already been used.');
            used.status = 400;
            throw used;
          }
        } else if (pendingBeta.kind === 'referral') {
          await client.query(
            'INSERT INTO beta_referral_signups (referrer_user_id, user_id) VALUES ($1, $2)',
            [pendingBeta.row.id, userId]
          );
        } else {
          const claimed = await client.query(
            `UPDATE beta_codes
             SET uses_count = uses_count + 1
             WHERE id = $1 AND uses_count < max_uses
             RETURNING id`,
            [pendingBeta.row.id]
          );
          if (claimed.rows.length === 0) {
            const used = new Error('This invite code has already been used.');
            used.status = 400;
            throw used;
          }
        }
        await client.query('SAVEPOINT beta_claim_user');
        try {
          await client.query(
            `UPDATE users SET is_beta_tester = TRUE, updated_at = NOW() WHERE id = $1`,
            [userId]
          );
          await client.query('RELEASE SAVEPOINT beta_claim_user');
        } catch (betaFlagErr) {
          await client.query('ROLLBACK TO SAVEPOINT beta_claim_user');
          console.warn('[Signup] is_beta_tester update skipped:', betaFlagErr.message);
        }
        }

      }

      // ─── Generate unique referral code for new user ───────────────────
      try {
        const refCode = await generateUniqueReferralCode();
        await client.query(
          'UPDATE users SET referral_code = $1 WHERE id = $2 AND referral_code IS NULL',
          [refCode, userId]
        );
      } catch (refErr) {
        console.error('[Signup] Failed to generate referral code:', refErr.message);
        // Non-fatal — user can still sign up; code generated on next login
      }

      // ─── Set referred_by_user_id if a valid referral code was provided ──
      let signupReferrerId = null; // hoisted so we can use it after COMMIT
      if (effectiveRefCode && effectiveRefCode.trim() && !isCreatorEmail) {
        try {
          const refOwner = await client.query(
            'SELECT id FROM users WHERE referral_code = $1',
            [effectiveRefCode.trim().toUpperCase()]
          );
          if (refOwner.rows.length > 0) {
            signupReferrerId = refOwner.rows[0].id;
            if (signupReferrerId !== userId) {
              // ── Beta Phase Invite Taper ──────────────────────────────────────
              // Check the referrer's affiliate invite quota (5-4-3-2-1 by tier).
              // If they've used all their invites (beta_invites_remaining = 0),
              // the new user goes to the orphan pool instead of being linked.
              // NULL = unlimited (Company / Tier 0 / master node).
              try {
                const refAff = await client.query(
                  `SELECT id, beta_invites_remaining
                   FROM affiliates
                   WHERE user_id = $1 AND status != 'revoked'
                   LIMIT 1`,
                  [signupReferrerId]
                );
                if (refAff.rows.length > 0) {
                  const { id: affId, beta_invites_remaining } = refAff.rows[0];
                  if (beta_invites_remaining !== null && beta_invites_remaining <= 0) {
                    // Quota exhausted — decouple from this referrer; user goes to orphan pool
                    console.log(`[InviteTaper] Referrer affiliate #${affId} has no invites left — orphan-pooling new user ${userId}`);
                    signupReferrerId = null;
                  } else {
                    // Quota OK — link and decrement
                    await client.query(
                      `UPDATE users SET referred_by_user_id = $1, updated_at = NOW()
                       WHERE id = $2 AND referred_by_user_id IS NULL`,
                      [signupReferrerId, userId]
                    );
                    if (beta_invites_remaining !== null) {
                      // Decrement (NULL = unlimited, skip decrement)
                      await client.query(
                        `UPDATE affiliates
                         SET beta_invites_remaining = GREATEST(0, beta_invites_remaining - 1),
                             updated_at = NOW()
                         WHERE id = $1`,
                        [affId]
                      );
                    }
                  }
                } else {
                  // Referrer is not an affiliate — still link the user (no quota to check)
                  await client.query(
                    `UPDATE users SET referred_by_user_id = $1, updated_at = NOW()
                     WHERE id = $2 AND referred_by_user_id IS NULL`,
                    [signupReferrerId, userId]
                  );
                }
              } catch (taperErr) {
                console.error('[InviteTaper] quota check error (non-fatal):', taperErr.message);
                // Fall through — still link the user if quota check fails
                await client.query(
                  `UPDATE users SET referred_by_user_id = $1, updated_at = NOW()
                   WHERE id = $2 AND referred_by_user_id IS NULL`,
                  [signupReferrerId, userId]
                );
              }
            }
          }
        } catch (refErr) {
          console.error('[Signup] Failed to set referred_by_user_id:', refErr.message);
          // Non-fatal
        }
      }

      // ─── Log disclaimer acceptance if provided ────────────────────────
      if (disclaimer_accepted) {
        try {
          await client.query(
            `INSERT INTO disclaimer_acceptances (user_id, acceptance_type, page, ip_address, user_agent)
             VALUES ($1, 'signup', '/signup', $2, $3)`,
            [userId, req.ip || req.connection?.remoteAddress || null, (req.headers['user-agent'] || '').substring(0, 500)]
          );
          await client.query(
            'UPDATE users SET disclaimer_accepted_at = NOW() WHERE id = $1',
            [userId]
          );
        } catch (disclaimerErr) {
          console.error('[Signup] Failed to log disclaimer acceptance:', disclaimerErr.message);
          // Non-fatal — don't block signup
        }
      }

      await client.query('COMMIT');

      // ─── Ghost Slot / Orphan Pool ─────────────────────────────────────────
      // After signup: place free users in tree or holding tank (non-fatal, async)
      if (signupReferrerId && signupReferrerId !== userId) {
        // User came via referral link → ghost slot in referrer's tree
        createGhostSlotForReferral(userId, signupReferrerId).catch(() => {});
      } else if (!isCreatorEmail) {
        // No referral → add to Holding Tank (orphan pool)
        addToOrphanPool(userId).catch(() => {});
      }

      // Get user details including Pro status
      const userResult = await pool.query(
        'SELECT id, email, name, is_creator, promo_code_used, plan, paid_until, referral_code FROM users WHERE id = $1',
        [userId]
      );
      const user = userResult.rows[0];

      // Set session — same contract as login so Phase Zero APIs see requireAuth.
      req.session.userId = userId;
      req.session.email = normalizedEmail;
      delete req.session.pzComplete;

      // Use centralized Pro access check (single source of truth)
      const hasPro = await hasProAccess(user);
      const proFields = buildProResponse(user, hasPro);

      // Explicitly save session before responding (prevents race condition
      // where browser navigates before session row exists in PostgreSQL)
      await new Promise((resolve, reject) => {
        req.session.save(err => err ? reject(err) : resolve());
      });

      // New accounts always start Phase Zero (unless already completed — e.g. password set on existing row)
      let redirect = '/phase-zero';
      try {
        const pz = await pool.query(
          'SELECT phase_zero_completed_at FROM users WHERE id = $1',
          [userId]
        );
        if (pz.rows[0] && pz.rows[0].phase_zero_completed_at) {
          redirect = loginRedirectFor(user);
          req.session.pzComplete = true;
          await new Promise((resolve, reject) => {
            req.session.save(err => err ? reject(err) : resolve());
          });
        }
      } catch (pzErr) {
        console.error('[Signup] phase-zero redirect check skipped:', pzErr.message);
      }

      // Return JSON so client does a full-page navigation (not fetch-follow redirect)
      res.json({ success: true, redirect, userId });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/auth/signup error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.post('/login', async (req, res) => {
  // Guard: database unavailable → return 503 instead of crashing
  if (!pool) {
    return res.status(503).json({ error: 'Service temporarily unavailable. Please try again in a moment.' });
  }
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email or User ID and password are required' });
    }

    const normalizedIdentifier = email.toLowerCase().trim();

    // Prefer email/user_id lookup; fall back to email-only if optional columns are missing.
    let result;
    try {
      result = await pool.query(
        `SELECT id, email, name, password_hash, plan, paid_until, is_creator, promo_code_used,
                COALESCE(promo_grace_expired, false) AS promo_grace_expired,
                COALESCE(two_factor_enabled, false) AS two_factor_enabled,
                verification_method, verified_phone
         FROM users
         WHERE LOWER(email) = $1 OR LOWER(user_id) = $1
         ORDER BY CASE WHEN LOWER(email) = $1 THEN 0 ELSE 1 END
         LIMIT 1`,
        [normalizedIdentifier]
      );
    } catch (selectErr) {
      console.error('[auth] full login SELECT failed, falling back to email-only:', selectErr.message);
      result = await pool.query(
        `SELECT id, email, password_hash FROM users WHERE LOWER(email) = $1`,
        [normalizedIdentifier]
      );
    }

    if (result.rows.length === 0 || !result.rows[0].password_hash) {
      return res.status(401).json({ error: 'Invalid email/User ID or password' });
    }

    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email/User ID or password' });
    }

    // ── 2FA CHECK ──────────────────────────────────────────────────────────────
    if (user.two_factor_enabled) {
      // Admin / founder accounts skip 2FA so the admin panel can open even when
      // email or SMS is not configured.
      if (user.is_creator || userIsAdminAccount(user) || isAllowlistedAdminEmail(user.email)) {
        return await completeLogin(req, res, user);
      }

      // Check "remember this device" cookie — skip 2FA if trusted
      const trustCookie = getCookieValue(req, 'facts_trust');
      if (trustCookie) {
        const trustResult = await pool.query(
          `SELECT id FROM device_trust_tokens
           WHERE user_id = $1 AND token = $2 AND expires_at > NOW()`,
          [user.id, trustCookie]
        );
        if (trustResult.rows.length > 0) {
          // Trusted device — complete login without 2FA
          return await completeLogin(req, res, user);
        }
      }

      // Store pending 2FA state in session (not yet authenticated)
      req.session.pending2faUserId = user.id;
      req.session.pending2faEmail = user.email;
      req.session.pending2faMethod = user.verification_method || 'email';
      req.session.pending2faPhone = user.verified_phone || null;

      // Auto-send code — email or SMS based on user preference
      const method2fa = user.verification_method || 'email';
      if (method2fa === 'sms' && user.verified_phone) {
        const smsResult = await sendVerification(user.verified_phone);
        if (!smsResult.success && !smsResult.stub) {
          // SMS failed — fall back to email and notify user
          console.error('[2FA] SMS send failed, falling back to email for user', user.id);
          req.session.pending2faMethod = 'email';
          await send2faCode(user.id);
          return res.json({
            requires_2fa: true,
            email: maskEmail(user.email),
            method: 'email',
            sms_fallback: true
          });
        }
      } else {
        await send2faCode(user.id);
      }

      return res.json({
        requires_2fa: true,
        email: maskEmail(user.email),
        method: method2fa === 'sms' && user.verified_phone ? 'sms' : 'email',
        phone_hint: method2fa === 'sms' && user.verified_phone
          ? `***-***-${user.verified_phone.slice(-4)}`
          : null
      });
    }
    // ──────────────────────────────────────────────────────────────────────────

    await completeLogin(req, res, user);
  } catch (err) {
    console.error('POST /api/auth/login error:', err.message);
    const safe = String(err && err.message || 'unknown').slice(0, 180);
    res.status(500).json({ error: 'Login failed', detail: safe });
  }
});

router.post('/logout', (req, res) => {
  applyPrivateCache(res);
  const cookieOpts = {
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  };
  function finish(err) {
    res.clearCookie('connect.sid', cookieOpts);
    if (err) {
      console.error('Logout error:', err.message || err);
      return res.status(500).json({ success: false, error: 'Logout failed' });
    }
    res.json({ success: true });
  }
  if (!req.session) return finish();
  req.session.destroy(finish);
});

router.post('/sandbox-login', requireAuth, async (req, res) => {
  try {
    // Only the creator can use this
    const callerResult = await pool.query(
      'SELECT id, email, is_creator FROM users WHERE id = $1',
      [req.userId]
    );
    if (!callerResult.rows.length || !callerResult.rows[0].is_creator) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Find sandbox account
    const sandboxResult = await pool.query(
      "SELECT id, email, name, plan, paid_until, is_creator FROM users WHERE LOWER(email) = 'sandbox@financial-revolution.app' LIMIT 1"
    );
    if (!sandboxResult.rows.length) {
      return res.status(404).json({ error: 'Sandbox account not found. Contact support.' });
    }

    const sandboxUser = sandboxResult.rows[0];

    // Store original user ID so they can return later
    const originalUserId = req.session.userId;

    // Switch session to sandbox user
    req.session.userId = sandboxUser.id;
    req.session.sandboxMode = true;
    req.session.originalUserId = originalUserId;

    // Save session explicitly
    await new Promise((resolve, reject) => {
      req.session.save(err => err ? reject(err) : resolve());
    });

    res.json({
      success: true,
      sandbox: true,
      user: {
        id: sandboxUser.id,
        email: sandboxUser.email,
        name: sandboxUser.name,
        plan: 'paid',
        is_pro: true,
        is_creator: true,
      }
    });
  } catch (err) {
    console.error('POST /api/auth/sandbox-login error:', err.message);
    res.status(500).json({ error: 'Failed to switch to sandbox account' });
  }
});

router.post('/sandbox-exit', requireAuth, async (req, res) => {
  try {
    if (!req.session.sandboxMode || !req.session.originalUserId) {
      return res.status(400).json({ error: 'Not in sandbox mode' });
    }

    const originalUserId = req.session.originalUserId;

    // Restore original session
    req.session.userId = originalUserId;
    req.session.sandboxMode = false;
    req.session.originalUserId = null;

    await new Promise((resolve, reject) => {
      req.session.save(err => err ? reject(err) : resolve());
    });

    res.json({ success: true, restored: true });
  } catch (err) {
    console.error('POST /api/auth/sandbox-exit error:', err.message);
    res.status(500).json({ error: 'Failed to exit sandbox' });
  }
});

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Enter the email on your FACTS account.' });
    }

    if (!pool) {
      return res.status(503).json({ error: 'Password reset is unavailable right now. Please try again.' });
    }

    const { ensurePasswordResetSchema } = require('../lib/ensureAuthSchema');
    await ensurePasswordResetSchema(pool);

    const normalizedEmail = email.toLowerCase().trim();

    // Check rate limit: max 3 reset requests per hour per email
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentRequests = await pool.query(
      `SELECT COUNT(*) as count FROM password_reset_tokens
       WHERE user_id IN (SELECT id FROM users WHERE LOWER(email) = $1)
       AND created_at > $2`,
      [normalizedEmail, oneHourAgo]
    );

    if (parseInt(recentRequests.rows[0].count, 10) >= 3) {
      return res.json({
        success: true,
        message: RESET_EMAIL_SENT
      });
    }

    const userResult = await pool.query(
      'SELECT id, email FROM users WHERE LOWER(email) = $1',
      [normalizedEmail]
    );

    // Same reply when no account exists, so the form does not reveal who is registered.
    if (userResult.rows.length === 0) {
      return res.json({
        success: true,
        message: RESET_EMAIL_SENT
      });
    }

    const user = userResult.rows[0];

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    const inserted = await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3) RETURNING id',
      [user.id, token, expiresAt]
    );
    const tokenId = inserted.rows[0].id;

    const resetUrl = `${passwordResetBaseUrl(req)}/reset-password.html?token=${token}`;

    if (!emailConfigured()) {
      await pool.query('DELETE FROM password_reset_tokens WHERE id = $1', [tokenId]);
      console.error('POST /api/auth/forgot-password: RESEND_API_KEY is not set');
      return res.status(503).json({ error: 'We could not send the reset email. Please try again.' });
    }

    let emailResult;
    try {
      emailResult = await sendEmail({
          to: user.email,
          subject: 'Reset Your FACTS Password',
          text: `You requested a password reset for your FACTS account.\n\nClick this link to reset your password:\n${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, you can safely ignore this email.`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #10b981; margin-bottom: 24px;">Reset Your Password</h2>
              <p style="color: #333; line-height: 1.6; margin-bottom: 20px;">
                You requested a password reset for your FACTS account.
              </p>
              <p style="margin-bottom: 24px;">
                <a href="${resetUrl}" style="display: inline-block; background: #10b981; color: #000; padding: 12px 32px; text-decoration: none; border-radius: 8px; font-weight: 600;">
                  Reset Password
                </a>
              </p>
              <p style="color: #666; font-size: 14px; line-height: 1.6;">
                Or copy this link into your browser:<br>
                <a href="${resetUrl}" style="color: #10b981;">${resetUrl}</a>
              </p>
              <p style="color: #666; font-size: 14px; line-height: 1.6;">
                This link expires in 1 hour.
              </p>
              <p style="color: #666; font-size: 14px; line-height: 1.6; margin-top: 24px;">
                If you didn't request this, you can safely ignore this email.
              </p>
            </div>
          `
      });
    } catch (emailErr) {
      await pool.query('DELETE FROM password_reset_tokens WHERE id = $1', [tokenId]);
      console.error('Error sending reset email:', emailErr.message);
      return res.status(503).json({ error: 'We could not send the reset email. Please try again.' });
    }

    if (!emailResult.sent) {
      await pool.query('DELETE FROM password_reset_tokens WHERE id = $1', [tokenId]);
      console.error('Email send failed:', emailResult.error);
      return res.status(503).json({ error: 'We could not send the reset email. Please try again.' });
    }

    res.json({
      success: true,
      message: RESET_EMAIL_SENT
    });
  } catch (err) {
    console.error('POST /api/auth/forgot-password error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Reset token is required' });
    }

    // Validate password
    const { valid, errors } = validatePassword(password);
    if (!valid) {
      return res.status(400).json({ error: errors[0], errors });
    }

    // Find valid token
    const tokenResult = await pool.query(
      `SELECT prt.id, prt.user_id, prt.expires_at, prt.used, u.email
       FROM password_reset_tokens prt
       JOIN users u ON u.id = prt.user_id
       WHERE prt.token = $1`,
      [token]
    );

    if (tokenResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }

    const resetToken = tokenResult.rows[0];

    // Check if token is expired
    if (new Date(resetToken.expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired. Please request a new one.' });
    }

    // Check if token was already used
    if (resetToken.used) {
      return res.status(400).json({ error: 'This reset link has already been used. Please request a new one.' });
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Update password
      await client.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [passwordHash, resetToken.user_id]
      );

      // Mark token as used
      await client.query(
        'UPDATE password_reset_tokens SET used = TRUE WHERE id = $1',
        [resetToken.id]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Password reset successful. You can now log in with your new password.'
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/auth/reset-password error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

router.get('/me', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.json({ authenticated: false });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, name, display_name, avatar_url, avatar_color, plan, paid_until, is_creator, is_admin, income_programs_blocked, promo_code_used, referral_code, affiliate_code, affiliate_tier, is_affiliate_disabled, created_at, promo_grace_started_at, promo_grace_expired, trial_used, trial_started_at, trial_expires_at, trial_plan_type, pricing_tier, business_path_type, survival_burn_cents, bucket_cert_completed FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      return res.json({ authenticated: false });
    }

    const user = result.rows[0];
    if (isAllowlistedAdminEmail(user.email) && !user.is_admin) {
      user.is_admin = true;
      pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1 AND (is_admin IS NOT TRUE)', [user.id])
        .catch(function (healErr) { console.error('Auto-heal is_admin flag failed:', healErr.message); });
    }
    // Use centralized Pro access check (single source of truth)
    const hasPro = await hasProAccess(user);
    const proFields = buildProResponse(user, hasPro);

    // Calculate promo grace period status (for banner display on frontend)
    const graceStatus = calculatePromoGraceStatus(user);

    // Calculate 21-day free trial status (for trial countdown banner)
    const trialStatus = calculateTrialStatus(user);

    // Check NDA acceptance status
    const creatorStatus = await isCreator(user);
    const now = new Date();
    const ndaRequired = now < NDA_LAUNCH_DATE && !creatorStatus;
    let ndaAccepted = !ndaRequired;
    if (ndaRequired) {
      const ndaResult = await pool.query(
        'SELECT id FROM nda_acceptances WHERE user_id = $1 AND nda_version = $2',
        [user.id, NDA_VERSION]
      );
      ndaAccepted = ndaResult.rows.length > 0;
    }

    // Check Family Incubator sub-account status (educational access only — Levels 1-3)
    const isIncubatorSub = !hasPro ? await hasIncubatorSubAccess(user.id) : false;
    let incubatorSubInfo = null;
    if (isIncubatorSub) {
      const subRes = await pool.query(`
        SELECT hm.id as member_id, h.id as household_id, h.name as household_name,
               hm.commission_eligible, hm.broke_away_at,
               head.name as head_name, head.email as head_email
        FROM household_members hm
        JOIN households h ON h.id = hm.household_id
        JOIN users head ON head.id = h.owner_id
        WHERE hm.user_id = $1 AND hm.is_sub_account = true AND hm.broke_away_at IS NULL
        LIMIT 1
      `, [user.id]);
      if (subRes.rows.length > 0) {
        const sub = subRes.rows[0];
        incubatorSubInfo = {
          household_id: sub.household_id,
          household_name: sub.household_name,
          head_name: sub.head_name,
          commission_eligible: sub.commission_eligible
        };
      }
    }

    return res.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        display_name: user.display_name || null,
        avatar_url: user.avatar_url || null,
        avatar_color: user.avatar_color || '#10b981',
        referral_code: user.referral_code || null,
        nda_required: ndaRequired,
        nda_accepted: ndaAccepted,
        ...proFields,
        // Promo grace period info (used by frontend banner)
        promo_grace_active: graceStatus.active,
        promo_grace_expired: graceStatus.expired,
        promo_grace_days_remaining: graceStatus.daysRemaining,
        // 21-day free trial info (Habitual Handshake)
        trial_active: trialStatus.active,
        trial_expired: trialStatus.expired,
        trial_days_remaining: trialStatus.daysRemaining,
        trial_plan_type: trialStatus.planType,
        trial_used: user.trial_used || false,
        trial_expires_at: user.trial_expires_at || null,
        // Family Incubator sub-account status
        is_incubator_sub: isIncubatorSub,
        incubator_info: incubatorSubInfo,
        // Pricing tier — used for feature gating
        pricing_tier: user.pricing_tier || 'none',
        // Individual plan: family features are disabled (single-user only)
        has_household_features: user.pricing_tier !== 'individual_pro',
        // Business Pro onboarding fields
        business_path_type: user.business_path_type || null,
        survival_burn_cents: user.survival_burn_cents || null,
        bucket_cert_completed: user.bucket_cert_completed || false,
        is_admin: !!(user.is_admin || isAllowlistedAdminEmail(user.email)),
        affiliate_code: user.affiliate_code || null,
        affiliate_tier: user.affiliate_tier || null,
        is_affiliate_disabled: !!user.is_affiliate_disabled || String(user.affiliate_tier || '').toUpperCase() === 'EXCLUDED',
        affiliate_eligible: !(!!user.is_affiliate_disabled || String(user.affiliate_tier || '').toUpperCase() === 'EXCLUDED' || isAdminIncomeBlockedUser(user)),
        can_join_income_programs: !isAdminIncomeBlockedUser(user)
      }
    });
  } catch (err) {
    console.error('GET /api/auth/me error:', err.message);
    try {
      const slim = await pool.query(
        'SELECT id, email, name, is_admin, is_creator FROM users WHERE id = $1',
        [req.session.userId]
      );
      if (!slim.rows.length) return res.json({ authenticated: false });
      const user = slim.rows[0];
      return res.json({
        authenticated: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          is_admin: !!(user.is_admin || isAllowlistedAdminEmail(user.email)),
          is_creator: !!user.is_creator
        }
      });
    } catch (fallbackErr) {
      console.error('GET /api/auth/me fallback error:', fallbackErr.message);
      return res.json({ authenticated: false });
    }
  }
});

router.post('/migrate-data', requireAuth, async (req, res) => {
  try {
    const { transactions } = req.body;
    const userId = req.userId;

    if (!Array.isArray(transactions)) {
      return res.json({ migrated: 0 });
    }

    const client = await pool.connect();
    let migrated = 0;

    try {
      await client.query('BEGIN');

      for (const txn of transactions) {
        if (!txn.type || !txn.amount) continue;

        // Find category_id by slug or name if provided
        let categoryId = txn.category_id || null;
        if (!categoryId && txn.category_slug) {
          const catResult = await client.query(
            'SELECT id FROM categories WHERE slug = $1',
            [txn.category_slug]
          );
          if (catResult.rows.length > 0) categoryId = catResult.rows[0].id;
        }

        await client.query(
          `INSERT INTO transactions (user_id, type, amount, description, category_id, subcategory, payment_method, transaction_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            userId,
            txn.type,
            parseFloat(txn.amount),
            txn.description || null,
            categoryId,
            txn.subcategory || null,
            txn.payment_method || null,
            txn.transaction_date || new Date().toISOString().split('T')[0]
          ]
        );
        migrated++;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ migrated });
  } catch (err) {
    console.error('POST /api/auth/migrate-data error:', err.message);
    res.status(500).json({ error: 'Failed to migrate data' });
  }
});

router.get('/2fa/status', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT two_factor_enabled FROM users WHERE id = $1', [req.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, enabled: result.rows[0].two_factor_enabled });
  } catch (err) {
    console.error('GET /api/auth/2fa/status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch 2FA status' });
  }
});

router.post('/2fa/enable', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required to enable 2FA' });

    const result = await pool.query('SELECT password_hash, email FROM users WHERE id = $1', [req.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    const { password_hash, email } = result.rows[0];
    if (!password_hash) return res.status(400).json({ error: 'No password set on this account' });

    const match = await bcrypt.compare(password, password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });

    await pool.query('UPDATE users SET two_factor_enabled = TRUE, updated_at = NOW() WHERE id = $1', [req.userId]);
    res.json({ success: true, message: 'Two-factor authentication enabled. Verification codes will be sent to ' + maskEmail(email) + ' on each login.' });
  } catch (err) {
    console.error('POST /api/auth/2fa/enable error:', err.message);
    res.status(500).json({ error: 'Failed to enable 2FA' });
  }
});

router.post('/2fa/disable', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required to disable 2FA' });

    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });

    const match = await bcrypt.compare(password, result.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });

    await pool.query('UPDATE users SET two_factor_enabled = FALSE, updated_at = NOW() WHERE id = $1', [req.userId]);
    // Revoke all trust tokens for this user
    await pool.query('DELETE FROM device_trust_tokens WHERE user_id = $1', [req.userId]);
    res.json({ success: true, message: 'Two-factor authentication disabled.' });
  } catch (err) {
    console.error('POST /api/auth/2fa/disable error:', err.message);
    res.status(500).json({ error: 'Failed to disable 2FA' });
  }
});

router.post('/2fa/send-code', async (req, res) => {
  try {
    const userId = req.session && req.session.pending2faUserId;
    const method2fa = (req.session && req.session.pending2faMethod) || 'email';
    const phone2fa = req.session && req.session.pending2faPhone;

    if (!userId) return res.status(401).json({ error: 'No pending 2FA session. Please log in again.' });

    if (method2fa === 'sms' && phone2fa) {
      const smsResult = await sendVerification(phone2fa);
      if (!smsResult.success && !smsResult.stub) {
        return res.status(500).json({ error: smsResult.error || 'Failed to send SMS code.' });
      }
    } else {
      await send2faCode(userId);
    }

    res.json({ success: true, message: 'Verification code sent.' });
  } catch (err) {
    if (err.code === 'RATE_LIMIT') {
      return res.status(429).json({ error: 'Too many code requests. Please wait before requesting a new code.' });
    }
    console.error('POST /api/auth/2fa/send-code error:', err.message);
    res.status(500).json({ error: 'Failed to send code' });
  }
});

router.post('/2fa/verify', async (req, res) => {
  try {
    const { code, remember_device } = req.body;
    const userId = req.session && req.session.pending2faUserId;
    const userEmail = req.session && req.session.pending2faEmail;
    const method2fa = (req.session && req.session.pending2faMethod) || 'email';
    const phone2fa = req.session && req.session.pending2faPhone;

    if (!userId) return res.status(401).json({ error: 'No pending 2FA session. Please log in again.' });
    if (!code || !/^\d{6}$/.test(code.toString().trim())) {
      return res.status(400).json({ error: 'Please enter a valid 6-digit code.' });
    }

    const cleanCode = code.toString().trim();

    // ── SMS path via Twilio Verify ─────────────────────────────────────────
    if (method2fa === 'sms' && phone2fa) {
      const smsCheck = await checkVerification(phone2fa, cleanCode);
      if (!smsCheck.success) {
        return res.status(401).json({ error: smsCheck.error || 'Incorrect verification code.' });
      }

      const userResult = await pool.query(
        'SELECT id, email, name, password_hash, plan, paid_until, is_creator, promo_code_used, promo_grace_expired FROM users WHERE id = $1',
        [userId]
      );
      if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });

      if (remember_device) {
        const trustToken = crypto.randomBytes(40).toString('hex');
        const trustExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
        await pool.query(
          `INSERT INTO device_trust_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
          [userId, trustToken, trustExpiry]
        );
        res.cookie('facts_trust', trustToken, {
          httpOnly: true, secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/'
        });
      }

      return await completeLogin(req, res, userResult.rows[0]);
    }

    // ── Email path via two_factor_codes table ──────────────────────────────

    // Get the latest valid (unused, unexpired) code for this user
    const codeResult = await pool.query(
      `SELECT id, code, attempts FROM two_factor_codes
       WHERE user_id = $1 AND used = FALSE AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (!codeResult.rows.length) {
      return res.status(400).json({ error: 'Code expired or not found. Please request a new code.' });
    }

    const record = codeResult.rows[0];

    // Max 5 attempts
    if (record.attempts >= 5) {
      await pool.query('UPDATE two_factor_codes SET used = TRUE WHERE id = $1', [record.id]);
      return res.status(429).json({ error: 'Too many failed attempts. Please request a new code.' });
    }

    if (record.code !== cleanCode) {
      await pool.query('UPDATE two_factor_codes SET attempts = attempts + 1 WHERE id = $1', [record.id]);
      const remaining = 4 - record.attempts;
      return res.status(401).json({ error: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.` });
    }

    // Code matches — mark as used
    await pool.query('UPDATE two_factor_codes SET used = TRUE WHERE id = $1', [record.id]);

    // "Remember this device" — 30-day trust token stored in HttpOnly cookie
    if (remember_device) {
      const trustToken = crypto.randomBytes(40).toString('hex');
      const trustExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO device_trust_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`,
        [userId, trustToken, trustExpiry]
      );
      res.cookie('facts_trust', trustToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: '/'
      });
    }

    // Fetch full user object to complete login
    const userResult = await pool.query(
      'SELECT id, email, name, password_hash, plan, paid_until, is_creator, promo_code_used, promo_grace_expired FROM users WHERE id = $1',
      [userId]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });

    await completeLogin(req, res, userResult.rows[0]);
  } catch (err) {
    console.error('POST /api/auth/2fa/verify error:', err.message);
    res.status(500).json({ error: 'Verification failed' });
  }
});

module.exports = {
  router,
  pageRouter,
  requireAuth,
  optionalAuth,
  startVerification,
  checkVerification,
  bindAuthRuntime,
  createAuthRouter: function createAuthRouter() { return router; },
  SAFE_MODE
};
