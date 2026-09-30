const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');

function getDb(req) {
  return req.app.get('db') || pool;
}

// --- MIDDLEWARE: REQUIRE ADMIN ---
async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  const db = getDb(req);
  try {
    const userRes = await db.query('SELECT is_admin FROM users WHERE id = $1', [req.session.userId]);
    if (userRes.rows.length === 0 || !userRes.rows[0].is_admin) {
      return res.status(403).json({ error: 'Forbidden: Admin access required.' });
    }
    next();
  } catch (err) {
    console.error('Admin verification error:', err);
    return res.status(500).json({ error: 'Server error checking admin credentials.' });
  }
}

// --- 1. POST /api/admin/generate-code ---
// Create master codes with custom limit (e.g., 5, 50, 500 uses)
router.post('/api/admin/generate-code', requireAdmin, async (req, res) => {
  const { code, maxUses } = req.body;
  const db = getDb(req);

  if (!code || !maxUses) {
    return res.status(400).json({ error: 'Code name and maxUses are required.' });
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

// --- 2. GET /api/admin/tracking ---
// Returns master code usage, individual user referral stats, and full referral lineage
router.get('/api/admin/tracking', requireAdmin, async (req, res) => {
  const db = getDb(req);

  try {
    // A. Master Beta Codes Status (e.g., CORSAIR-FACTS-2026)
    const masterCodes = await db.query(
      `SELECT id, code, max_uses, uses_count, created_at 
       FROM beta_codes 
       ORDER BY created_at DESC`
    );

    // B. User Referral Tree & Invite Usage
    const userLineage = await db.query(
      `SELECT 
          u.id AS user_id,
          u.email,
          u.referral_code,
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
      userLineage: userLineage.rows
    });
  } catch (err) {
    console.error('Error fetching admin tracking data:', err);
    return res.status(500).json({ error: 'Failed to retrieve tracking data.' });
  }
});

// --- 3. POST /api/admin/income-eligibility ---
// Admin marks a user ineligible (or eligible again) for income-generating programs.
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

module.exports = { router, requireAdmin };
