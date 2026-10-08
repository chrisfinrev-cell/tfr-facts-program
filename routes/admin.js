const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const { pool } = require('../db/pool');
const { createTargetedInvites, invitesToCsv, parseMeta } = require('../lib/inviteCodes');
const { userIsAdminAccount } = require('../config/adminAccess');

const ADMIN_UNLOCK_MS = 12 * 60 * 60 * 1000;

function getDb(req) {
  return req.app.get('db') || pool;
}

function adminToolsUnlocked(req) {
  const until = req.session && req.session.adminToolsUntil;
  return typeof until === 'number' && until > Date.now();
}

async function loadAdminUser(req) {
  const db = getDb(req);
  const userRes = await db.query(
    'SELECT is_admin, email, password_hash FROM users WHERE id = $1',
    [req.session.userId]
  );
  return userRes.rows[0] || null;
}

function isAdminRow(row) {
  return userIsAdminAccount(row);
}

// --- MIDDLEWARE: REQUIRE ADMIN ---
async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  try {
    const row = await loadAdminUser(req);
    if (!isAdminRow(row)) {
      return res.status(403).json({ error: 'Forbidden: Admin access required.' });
    }
    if (!adminToolsUnlocked(req)) {
      if (req.method === 'GET' && (req.originalUrl === '/admin' || req.path === '/admin')) {
        return res.redirect(302, '/app?adminGate=1');
      }
      return res.status(403).json({
        error: 'Enter your password to open admin tools.',
        code: 'admin_locked'
      });
    }
    next();
  } catch (err) {
    console.error('Admin verification error:', err);
    return res.status(500).json({ error: 'Server error checking admin credentials.' });
  }
}

// Password gate for the admin suite. Uses this account's FACTS password.
router.post('/api/admin/unlock', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  const password = String((req.body && req.body.password) || '');
  if (!password) {
    return res.status(400).json({ error: 'Enter your password.' });
  }

  const lockedUntil = req.session.adminUnlockLockedUntil;
  if (typeof lockedUntil === 'number' && lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  }

  try {
    const row = await loadAdminUser(req);
    if (!isAdminRow(row)) {
      return res.status(403).json({ error: 'Forbidden: Admin access required.' });
    }
    if (!row.password_hash) {
      return res.status(400).json({ error: 'No password is set on this account.' });
    }
    const match = await bcrypt.compare(password, row.password_hash);
    if (!match) {
      const fails = (req.session.adminUnlockFails || 0) + 1;
      req.session.adminUnlockFails = fails;
      if (fails >= 8) {
        req.session.adminUnlockLockedUntil = Date.now() + 15 * 60 * 1000;
        req.session.adminUnlockFails = 0;
      }
      return res.status(401).json({ error: 'That password does not match this account.' });
    }
    req.session.adminUnlockFails = 0;
    req.session.adminUnlockLockedUntil = 0;
    req.session.adminToolsUntil = Date.now() + ADMIN_UNLOCK_MS;
    req.session.save(function (err) {
      if (err) {
        console.error('Admin unlock session error:', err);
        return res.status(500).json({ error: 'Could not open admin tools.' });
      }
      return res.json({ ok: true });
    });
  } catch (err) {
    console.error('Admin unlock error:', err);
    return res.status(500).json({ error: 'Could not check that password.' });
  }
});

// --- 1. POST /api/admin/generate-code ---
// Create multi-use master codes in beta_codes (legacy), OR targeted beta_invites when recipient fields present.
router.post('/api/admin/generate-code', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const db = getDb(req);

  const hasRecipient =
    Boolean(body.sentToName || body.name || body.sentToEmail || body.email || body.meta || body.recipientMetadata);

  // Targeted single/multi invites mapped to recipient identity
  if (hasRecipient || body.generateCleanCodes === true || Number(body.count) > 0) {
    try {
      const created = await createTargetedInvites(db, {
        count: body.count || 1,
        name: body.sentToName || body.name,
        email: body.sentToEmail || body.email,
        meta: body.recipientMetadata || body.meta || {},
        parentCode: body.parentCode || body.parent_code,
        maxUses: body.maxUses || 1,
        createdByUserId: req.session.userId
      });
      return res.json({
        success: true,
        invites: created,
        csv: invitesToCsv(created),
        message: `Created ${created.length} targeted invite code(s).`
      });
    } catch (err) {
      console.error('Error generating targeted invites:', err);
      return res.status(500).json({ error: 'Failed to create targeted invite codes.' });
    }
  }

  const { code, maxUses } = body;
  if (!code || !maxUses) {
    return res.status(400).json({
      error: 'Provide code + maxUses for a master code, or recipient name/email/meta for targeted invites.'
    });
  }

  try {
    const formattedCode = code.trim().toUpperCase();
    await db.query(
      `INSERT INTO beta_codes (code, max_uses) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET max_uses = beta_codes.max_uses + EXCLUDED.max_uses`,
      [formattedCode, parseInt(maxUses, 10)]
    );

    return res.json({ success: true, message: `Master code ${formattedCode} created with ${maxUses} uses.` });
  } catch (err) {
    console.error('Error generating admin code:', err);
    return res.status(500).json({ error: 'Failed to create admin invite code.' });
  }
});

// --- 1b. POST /api/admin/generate-invites ---
// Explicit targeted invite creator (name/email/metadata/CSV)
router.post('/api/admin/generate-invites', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const db = getDb(req);
  try {
    const created = await createTargetedInvites(db, {
      count: body.count || 1,
      name: body.sentToName || body.name,
      email: body.sentToEmail || body.email,
      meta: body.recipientMetadata || body.meta || {},
      parentCode: body.parentCode || body.parent_code,
      maxUses: body.maxUses || 1,
      createdByUserId: req.session.userId
    });
    return res.json({
      success: true,
      invites: created,
      csv: invitesToCsv(created),
      message: `Created ${created.length} invite code(s).`
    });
  } catch (err) {
    console.error('Error generating invites:', err);
    return res.status(500).json({ error: 'Failed to create invite codes.' });
  }
});

// --- 2. GET /api/admin/tracking ---
router.get('/api/admin/tracking', requireAdmin, async (req, res) => {
  const db = getDb(req);

  try {
    const masterCodes = await db.query(
      `SELECT id, code, max_uses, uses_count, created_at
       FROM beta_codes
       ORDER BY created_at DESC`
    );

    let targetedInvites = { rows: [] };
    try {
      targetedInvites = await db.query(
        `SELECT id, code, parent_code, sent_to_name, sent_to_email, recipient_metadata,
                claimed_by_user_id, claimed_at, max_uses, uses_count, created_at
         FROM beta_invites
         ORDER BY created_at DESC
         LIMIT 500`
      );
    } catch (inviteErr) {
      console.warn('beta_invites tracking unavailable:', inviteErr.message);
    }

    const userLineage = await db.query(
      `SELECT
          u.id AS user_id,
          u.email,
          u.referral_code,
          u.affiliate_code,
          u.referred_by_code,
          u.affiliate_tier,
          u.monthly_invites_remaining,
          u.lifetime_invites_issued,
          u.nda_accepted_at,
          u.created_at,
          u.is_admin,
          u.income_programs_blocked,
          inviter.email AS invited_by_email,
          (SELECT COUNT(*) FROM users WHERE referrer_id = u.id) AS total_recruits
       FROM users u
       LEFT JOIN users inviter ON u.referrer_id = inviter.id
       ORDER BY u.created_at DESC`
    );

    return res.json({
      success: true,
      masterCodes: masterCodes.rows,
      targetedInvites: targetedInvites.rows,
      userLineage: userLineage.rows
    });
  } catch (err) {
    console.error('Error fetching admin tracking data:', err);
    return res.status(500).json({ error: 'Failed to retrieve tracking data.' });
  }
});

// --- 3. POST /api/admin/income-eligibility ---
router.post('/api/admin/income-eligibility', requireAdmin, async (req, res) => {
  const { userId, blocked } = req.body || {};
  const db = getDb(req);
  const targetId = parseInt(userId, 10);

  if (!targetId || typeof blocked !== 'boolean') {
    return res.status(400).json({ error: 'userId and blocked (boolean) are required.' });
  }

  try {
    const { isFounderAdmin } = require('../config/adminIncomePolicy');
    const target = await db.query(
      'SELECT id, email, is_admin, is_creator FROM users WHERE id = $1',
      [targetId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (isFounderAdmin(target.rows[0])) {
      return res.status(400).json({ error: 'The admin account cannot be made eligible for income programs.' });
    }

    const result = await db.query(
      `UPDATE users
       SET income_programs_blocked = $1
       WHERE id = $2
       RETURNING id, email, income_programs_blocked`,
      [blocked, targetId]
    );

    return res.json({
      success: true,
      user: result.rows[0],
      message: blocked
        ? `${result.rows[0].email} is now ineligible for income-generating programs.`
        : `${result.rows[0].email} is now eligible for income-generating programs.`
    });
  } catch (err) {
    console.error('Error updating income eligibility:', err);
    return res.status(500).json({ error: 'Failed to update income eligibility.' });
  }
});

module.exports = { router, requireAdmin, parseMeta };
