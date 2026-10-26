'use strict';

/**
 * Household sharing, 1+5 Incubator, breakaway, goals, shared budgets.
 * Mount (URL-preserving):
 *   app.use('/api/households', householdsRouter)
 *   app.use('/api/family-invite', familyInviteRouter)
 *   app.use('/api/goals', goalsRouter)
 *   app.use('/api/shared-budget-expenses', sharedBudgetExpensesRouter)
 */

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');
const { sendEmail, emailConfigured } = require('../lib/mailer');

const householdsRouter = express.Router({ mergeParams: true });
const familyInviteRouter = express.Router();
const goalsRouter = express.Router();
const sharedBudgetExpensesRouter = express.Router();

const runtime = {};
function bindFamilyRuntime(helpers) {
  Object.assign(runtime, helpers || {});
}

function hasProAccess(userOrId) {
  if (typeof runtime.hasProAccess === 'function') return runtime.hasProAccess(userOrId);
  return Promise.resolve(false);
}

// ─── family FINANCIAL FREEDOM CALCULATOR ────────────────────────────

// Helper: check if user is member of a family
async function isHouseholdMember(userId, householdId) {
  const r = await pool.query(
    'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
    [householdId, userId]
  );
  return r.rows.length > 0;
}

// GET /api/households/:household_id/fi-calculator
householdsRouter.get('/:household_id/fi-calculator', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) return res.status(403).json({ error: 'Paid plan required', code: 'PRO_REQUIRED' });

    const householdId = parseInt(req.params.household_id);
    if (!(await isHouseholdMember(req.userId, householdId))) {
      return res.status(403).json({ error: 'Not a member of this family' });
    }

    const result = await pool.query(
      'SELECT * FROM household_fi_calculator WHERE household_id = $1',
      [householdId]
    );
    res.json({ data: result.rows[0] || null });
  } catch (err) {
    console.error('GET family fi-calculator error:', err.message);
    res.status(500).json({ error: 'Failed to fetch family FI data' });
  }
});

// POST /api/households/:household_id/fi-calculator  (save/upsert)
householdsRouter.post('/:household_id/fi-calculator', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) return res.status(403).json({ error: 'Paid plan required', code: 'PRO_REQUIRED' });

    const householdId = parseInt(req.params.household_id);
    if (!(await isHouseholdMember(req.userId, householdId))) {
      return res.status(403).json({ error: 'Not a member of this family' });
    }

    const {
      total_monthly_expenses,
      total_current_savings,
      total_monthly_savings,
      safe_withdrawal_rate = 4.0,
      expected_return_rate = 7.0,
      member_count = 1
    } = req.body;

    if (total_monthly_expenses == null || total_current_savings == null || total_monthly_savings == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await pool.query(`
      INSERT INTO household_fi_calculator
        (household_id, total_monthly_expenses, total_current_savings, total_monthly_savings,
         safe_withdrawal_rate, expected_return_rate, member_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (household_id) DO UPDATE SET
        total_monthly_expenses = EXCLUDED.total_monthly_expenses,
        total_current_savings = EXCLUDED.total_current_savings,
        total_monthly_savings = EXCLUDED.total_monthly_savings,
        safe_withdrawal_rate = EXCLUDED.safe_withdrawal_rate,
        expected_return_rate = EXCLUDED.expected_return_rate,
        member_count = EXCLUDED.member_count,
        updated_at = NOW()
      RETURNING *
    `, [householdId, total_monthly_expenses, total_current_savings,
        total_monthly_savings, safe_withdrawal_rate, expected_return_rate, member_count]);

    res.json({ data: result.rows[0] });
  } catch (err) {
    console.error('POST family fi-calculator error:', err.message);
    res.status(500).json({ error: 'Failed to save family FI data' });
  }
});

// POST /api/households/:household_id/fi-calculator/calculate  (calculate, no save)
householdsRouter.post('/:household_id/fi-calculator/calculate', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) return res.status(403).json({ error: 'Paid plan required', code: 'PRO_REQUIRED' });

    const householdId = parseInt(req.params.household_id);
    if (!(await isHouseholdMember(req.userId, householdId))) {
      return res.status(403).json({ error: 'Not a member of this family' });
    }

    const {
      total_monthly_expenses,
      total_current_savings,
      total_monthly_savings,
      safe_withdrawal_rate = 4.0,
      expected_return_rate = 7.0,
      extra_monthly_savings = 0
    } = req.body;

    if (total_monthly_expenses == null || total_current_savings == null || total_monthly_savings == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const swr = parseFloat(safe_withdrawal_rate) / 100;
    const annualExpenses = parseFloat(total_monthly_expenses) * 12;
    const ffNumber = annualExpenses / swr;
    const currentSavings = parseFloat(total_current_savings);
    const monthlySavings = parseFloat(total_monthly_savings) + parseFloat(extra_monthly_savings);
    const returnRate = parseFloat(expected_return_rate) / 100;
    const monthlyReturn = returnRate / 12;

    const currentProgress = Math.min((currentSavings / ffNumber) * 100, 100);

    // Project months until FF#
    let savings = currentSavings;
    let month = 0;
    const MAX_MONTHS = 600;
    const projectionSchedule = [];

    while (savings < ffNumber && month < MAX_MONTHS) {
      month++;
      savings = savings * (1 + monthlyReturn) + monthlySavings;
      if (month % 12 === 0 || savings >= ffNumber) {
        projectionSchedule.push({
          month,
          year: Math.floor(month / 12),
          savings: Math.round(savings * 100) / 100,
          ffNumber: Math.round(ffNumber * 100) / 100,
          progress: Math.min((savings / ffNumber) * 100, 100)
        });
      }
      if (savings >= ffNumber) break;
    }

    const monthsUntilFF = month < MAX_MONTHS ? month : null;
    const yearsUntilFF = monthsUntilFF ? Math.round((monthsUntilFF / 12) * 10) / 10 : null;
    const daysUntilFF = monthsUntilFF ? Math.ceil(monthsUntilFF * 30.44) : null;
    const projectedYear = monthsUntilFF ? new Date().getFullYear() + Math.floor(monthsUntilFF / 12) : null;

    res.json({
      ffNumber: Math.round(ffNumber * 100) / 100,
      currentSavings: Math.round(currentSavings * 100) / 100,
      currentProgress: Math.round(currentProgress * 100) / 100,
      monthsUntilFF,
      yearsUntilFF,
      daysUntilFF,
      projectedYear,
      projectionSchedule,
      status: monthsUntilFF === null ? 'unreachable' : (yearsUntilFF <= 15 ? 'on_track' : 'in_progress')
    });
  } catch (err) {
    console.error('POST family fi-calculator/calculate error:', err.message);
    res.status(500).json({ error: 'Failed to calculate family FI projections' });
  }
});

// GET /api/households/:household_id/fi-calculator/aggregate  (auto-aggregate from members)
householdsRouter.get('/:household_id/fi-calculator/aggregate', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) return res.status(403).json({ error: 'Paid plan required', code: 'PRO_REQUIRED' });

    const householdId = parseInt(req.params.household_id);
    if (!(await isHouseholdMember(req.userId, householdId))) {
      return res.status(403).json({ error: 'Not a member of this family' });
    }

    // Get all family members
    const membersResult = await pool.query(
      'SELECT user_id FROM household_members WHERE household_id = $1',
      [householdId]
    );
    const memberIds = membersResult.rows.map(r => r.user_id);

    // Aggregate from individual fi calculators (only members who have data)
    let totalExpenses = 0, totalSavings = 0, totalMonthlySavings = 0;
    let memberCount = 0;
    const memberFIDates = [];

    for (const memberId of memberIds) {
      const fiData = await pool.query(
        'SELECT * FROM financial_freedom WHERE user_id = $1',
        [memberId]
      );
      if (fiData.rows.length > 0) {
        const fi = fiData.rows[0];
        totalExpenses += parseFloat(fi.monthly_expenses);
        totalSavings += parseFloat(fi.current_savings);
        totalMonthlySavings += parseFloat(fi.monthly_savings_rate);
        memberCount++;

        // Calculate individual projected FI date for comparison
        const returnRate = parseFloat(fi.expected_return_rate) / 100 / 12;
        const annualExp = parseFloat(fi.monthly_expenses) * 12;
        const fiNum = annualExp * 25;
        let s = parseFloat(fi.current_savings);
        let m = 0;
        while (s < fiNum && m < 600) {
          m++;
          s = s * (1 + returnRate) + parseFloat(fi.monthly_savings_rate);
          if (s >= fiNum) break;
        }
        const yearsUntil = m < 600 ? Math.round((m / 12) * 10) / 10 : null;
        const projYear = yearsUntil ? new Date().getFullYear() + Math.floor(m / 12) : null;

        // Get user display name
        const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [memberId]);
        const email = userResult.rows[0]?.email || 'Member';
        const displayName = email.split('@')[0];

        memberFIDates.push({
          userId: memberId,
          displayName,
          yearsUntilFI: yearsUntil,
          projectedYear: projYear,
          isSelf: memberId === req.userId
        });
      }
    }

    // Also aggregate from transactions for members without manual FI data
    const dashResult = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as total_expenses
      FROM transactions
      WHERE user_id = ANY($1)
    `, [memberIds]);

    if (memberCount === 0) {
      // Fall back to transaction-based aggregate
      totalExpenses = parseFloat(dashResult.rows[0].total_expenses);
    }

    res.json({
      total_monthly_expenses: Math.round(totalExpenses * 100) / 100,
      total_current_savings: Math.round(totalSavings * 100) / 100,
      total_monthly_savings: Math.round(totalMonthlySavings * 100) / 100,
      member_count: memberCount || memberIds.length,
      total_members: memberIds.length,
      memberFIDates
    });
  } catch (err) {
    console.error('GET family fi-calculator/aggregate error:', err.message);
    res.status(500).json({ error: 'Failed to aggregate family data' });
  }
});

// ═══════════════════════════════════════════════════════════
// ─── family SYSTEM ────────────────────────────────────
// ═══════════════════════════════════════════════════════════

// Create a new family
householdsRouter.post('/create', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'family name is required' });
    }

    // Individual Plan users cannot create or join households (single-user plan)
    const indivCheck = await pool.query('SELECT pricing_tier FROM users WHERE id = $1', [req.userId]);
    if (indivCheck.rows.length > 0 && indivCheck.rows[0].pricing_tier === 'individual_pro') {
      return res.status(403).json({ error: 'family features are not available on the Individual Plan. Upgrade to the Family Plan ($25/mo) to add family members.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Create family
      const householdResult = await client.query(
        'INSERT INTO households (name, owner_id) VALUES ($1, $2) RETURNING *',
        [name.trim(), req.userId]
      );
      const family = householdResult.rows[0];

      // Add owner as first member
      await client.query(
        `INSERT INTO household_members (household_id, user_id, role, status) VALUES ($1, $2, $3, 'active')`,
        [family.id, req.userId, 'owner']
      );

      // Clear any lingering offboarding records — user is back in a family
      await client.query(
        `UPDATE household_offboarding_records SET reintegrated_at = NOW() WHERE user_id = $1 AND reintegrated_at IS NULL`,
        [req.userId]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        family
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/households/create error:', err.message);
    res.status(500).json({ error: 'Failed to create family' });
  }
});

// Get user's households
householdsRouter.get('/', requireAuth, async (req, res) => {
  try {
    // Get all households where user is a member
    const result = await pool.query(`
      SELECT
        h.*,
        hm.role,
        hm.joined_at,
        u.email as owner_email,
        u.name as owner_name
      FROM households h
      INNER JOIN household_members hm ON h.id = hm.household_id
      LEFT JOIN users u ON h.owner_id = u.id
      WHERE hm.user_id = $1
      ORDER BY h.created_at DESC
    `, [req.userId]);

    res.json({ households: result.rows });
  } catch (err) {
    console.error('GET /api/households error:', err.message);
    res.status(500).json({ error: 'Failed to fetch households' });
  }
});

// Get family members (with family meta for UI)
householdsRouter.get('/:id/members', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Load family (verify exists)
    const householdResult = await pool.query(
      'SELECT id, name, owner_id, co_admin_id, cancellation_grace_ends_at, cancelled_at FROM households WHERE id = $1', [id]
    );
    if (householdResult.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    const family = householdResult.rows[0];

    // Verify user is a member
    const memberCheck = await pool.query(
      `SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2 AND status = 'active'`,
      [id, req.userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this family' });
    }

    // Get all active members
    const result = await pool.query(`
      SELECT
        hm.id, hm.user_id, hm.role, hm.status, hm.joined_at,
        u.email, u.name,
        u.id = $2 as is_you
      FROM household_members hm
      INNER JOIN users u ON hm.user_id = u.id
      WHERE hm.household_id = $1 AND hm.status = 'active'
      ORDER BY
        CASE WHEN hm.role = 'owner' THEN 0
             WHEN hm.role = 'co_admin' THEN 1
             ELSE 2 END,
        hm.joined_at ASC
    `, [id, req.userId]);

    res.json({
      success: true,
      family: {
        id: family.id,
        name: family.name,
        owner_id: family.owner_id,
        co_admin_id: family.co_admin_id,
        is_owner: family.owner_id === req.userId,
        is_co_admin: family.co_admin_id === req.userId,
        cancellation_grace_ends_at: family.cancellation_grace_ends_at || null,
        cancelled_at: family.cancelled_at || null
      },
      members: result.rows,
      max_members: 6
    });
  } catch (err) {
    console.error('GET /api/households/:id/members error:', err.message);
    res.status(500).json({ error: 'Failed to fetch family members' });
  }
});

// ─── family INVITE HELPERS ──────────────────────────────────────────────────

const HOUSEHOLD_MAX_MEMBERS = 6;
// Family Incubator: 1 head + up to 5 sub-accounts = 6 total (matches HOUSEHOLD_MAX_MEMBERS)
const INCUBATOR_MAX_SUB_ACCOUNTS = 5;

async function sendHouseholdInviteEmail({ toEmail, inviterName, householdName, inviteUrl, role, customNote }) {
  const roleLabel = { co_admin: 'Co-Admin', adult: 'Adult Member', minor: 'Junior Member' }[role] || (role || 'Member');
  const noteHtml = customNote
    ? `<p style="font-size:14px;background:rgba(201,168,76,0.12);border:1px solid rgba(201,168,76,0.3);border-radius:8px;padding:12px 14px;color:#c9a84c;margin:0 0 20px;line-height:1.6">${customNote}</p>`
    : '';
  try {
    await sendEmail({
        to: toEmail,
        subject: `${inviterName} invited you to join their FACTS family`,
        html: `
          <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;background:#0a0f1a;color:#e8e0d4;padding:32px 24px;border-radius:12px">
            <div style="margin-bottom:24px">
              <span style="font-size:22px;font-weight:700;color:#c9a84c;letter-spacing:-0.5px">FACTS</span>
            </div>
            <h1 style="font-size:22px;font-weight:700;margin:0 0 12px;color:#e8e0d4">You've been invited!</h1>
            <p style="font-size:15px;color:#a89a7e;margin:0 0 16px;line-height:1.6">
              <strong style="color:#e8e0d4">${inviterName}</strong> has invited you to join
              <strong style="color:#c9a84c">${householdName}</strong> on FACTS as a <strong style="color:#e8e0d4">${roleLabel}</strong>.
            </p>
            ${noteHtml}
            <p style="font-size:14px;color:#a89a7e;margin:0 0 28px;line-height:1.6">
              FACTS is the financial system built for families — track budgets, share insights, and build wealth together.
              This invite expires in 7 days.
            </p>
            <a href="${inviteUrl}" style="display:inline-block;background:#c9a84c;color:#0a0f1a;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none">
              Accept Invite →
            </a>
            <p style="font-size:12px;color:#6b5c44;margin-top:28px">
              If you didn't expect this invite, you can safely ignore this email.
            </p>
          </div>
        `
    });
  } catch (e) {
    console.error('[family Invite Email] Failed to send:', e.message);
  }
}

// Create family invite (email-based, with secure token)
// Owner OR co-admin can invite
householdsRouter.post('/:id/invite', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, role = 'adult' } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }
    if (!['co_admin', 'adult', 'minor'].includes(role)) {
      return res.status(400).json({ error: 'Role must be co_admin, adult, or minor' });
    }

    // Individual Plan users cannot invite family members
    const indivInvCheck = await pool.query('SELECT pricing_tier FROM users WHERE id = $1', [req.userId]);
    if (indivInvCheck.rows.length > 0 && indivInvCheck.rows[0].pricing_tier === 'individual_pro') {
      return res.status(403).json({ error: 'family invites are not available on the Individual Plan. Upgrade to the Family Plan ($25/mo) to add family members.' });
    }

    // Verify requester is owner OR co_admin
    const householdResult = await pool.query(
      'SELECT id, name, owner_id, co_admin_id FROM households WHERE id = $1',
      [id]
    );
    if (householdResult.rows.length === 0) {
      return res.status(404).json({ error: 'family not found' });
    }
    const family = householdResult.rows[0];
    const canInvite = family.owner_id === req.userId || family.co_admin_id === req.userId;
    if (!canInvite) {
      return res.status(403).json({ error: 'Only the owner or co-admin can send invites' });
    }

    // Only owner can invite a co_admin
    if (role === 'co_admin' && family.owner_id !== req.userId) {
      return res.status(403).json({ error: 'Only the owner can invite a co-admin' });
    }

    // Check active member count (max 6, including any accepted-but-not-yet-removed)
    const memberCount = await pool.query(
      `SELECT COUNT(*) as count FROM household_members
       WHERE household_id = $1 AND status = 'active'`,
      [id]
    );
    if (parseInt(memberCount.rows[0].count) >= HOUSEHOLD_MAX_MEMBERS) {
      return res.status(400).json({ error: `family is full (max ${HOUSEHOLD_MAX_MEMBERS} members)` });
    }

    // Check if invited email already a member
    const alreadyMember = await pool.query(
      `SELECT hm.id FROM household_members hm
       JOIN users u ON u.id = hm.user_id
       WHERE hm.household_id = $1 AND LOWER(u.email) = LOWER($2) AND hm.status = 'active'`,
      [id, email]
    );
    if (alreadyMember.rows.length > 0) {
      return res.status(400).json({ error: 'This person is already a member' });
    }

    // Cancel any existing pending invite for this email in this family
    await pool.query(
      `UPDATE household_invites SET status = 'cancelled'
       WHERE household_id = $1 AND LOWER(email) = LOWER($2) AND status = 'pending'`,
      [id, email]
    );

    // Generate secure token
    const token = crypto.randomBytes(32).toString('hex');
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const result = await pool.query(`
      INSERT INTO household_invites
        (household_id, invite_code, created_by_user_id, invited_by, email, role, token, expires_at, status, max_uses, uses_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 1, 0)
      RETURNING *
    `, [id, crypto.randomBytes(8).toString('hex'), req.userId, req.userId, email.toLowerCase(), role, token, expires_at]);

    const invite = result.rows[0];
    const APP_URL = process.env.APP_URL || 'https://app.factsmoney.com';
    const inviteUrl = `${APP_URL}/family-invite.html?token=${token}`;

    // Get inviter's name
    const inviterResult = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
    const inviter = inviterResult.rows[0];
    const inviterName = inviter.name || inviter.email.split('@')[0];

    // Send email (non-blocking)
    sendHouseholdInviteEmail({
      toEmail: email,
      inviterName,
      householdName: family.name,
      inviteUrl,
      role
    });

    res.json({
      success: true,
      invite: { id: invite.id, email, role, expires_at, status: 'pending' },
      invite_url: inviteUrl
    });
  } catch (err) {
    console.error('POST /api/households/:id/invite error:', err.message);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// List pending invites for a family (owner or co-admin only)
householdsRouter.get('/:id/invites', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const householdResult = await pool.query(
      'SELECT owner_id, co_admin_id FROM households WHERE id = $1',
      [id]
    );
    if (householdResult.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    const h = householdResult.rows[0];
    if (h.owner_id !== req.userId && h.co_admin_id !== req.userId) {
      return res.status(403).json({ error: 'Only owner or co-admin can view invites' });
    }

    const result = await pool.query(`
      SELECT hi.id, hi.email, hi.role, hi.status, hi.expires_at, hi.accepted_at,
             u.name as invited_by_name
      FROM household_invites hi
      LEFT JOIN users u ON u.id = hi.invited_by
      WHERE hi.household_id = $1 AND hi.status IN ('pending', 'accepted', 'declined')
      ORDER BY hi.id DESC
    `, [id]);

    res.json({ success: true, invites: result.rows });
  } catch (err) {
    console.error('GET /api/households/:id/invites error:', err.message);
    res.status(500).json({ error: 'Failed to load invites' });
  }
});

// Cancel a pending invite (owner or co-admin only)
householdsRouter.delete('/:id/invites/:invite_id', requireAuth, async (req, res) => {
  try {
    const { id, invite_id } = req.params;

    const householdResult = await pool.query(
      'SELECT owner_id, co_admin_id FROM households WHERE id = $1', [id]
    );
    if (householdResult.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    const h = householdResult.rows[0];
    if (h.owner_id !== req.userId && h.co_admin_id !== req.userId) {
      return res.status(403).json({ error: 'Only owner or co-admin can cancel invites' });
    }

    await pool.query(
      `UPDATE household_invites SET status = 'cancelled'
       WHERE id = $1 AND household_id = $2 AND status = 'pending'`,
      [invite_id, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/households/:id/invites/:invite_id error:', err.message);
    res.status(500).json({ error: 'Failed to cancel invite' });
  }
});

// ─── PUBLIC: Get invite details by token (no auth needed — shows join page) ─────
familyInviteRouter.get('/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const result = await pool.query(`
      SELECT hi.id, hi.email, hi.role, hi.status, hi.expires_at,
             h.name as household_name, h.id as household_id,
             u.name as invited_by_name
      FROM household_invites hi
      JOIN households h ON h.id = hi.household_id
      LEFT JOIN users u ON u.id = hi.invited_by
      WHERE hi.token = $1
    `, [token]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    const invite = result.rows[0];

    if (invite.status !== 'pending') {
      return res.json({ valid: false, status: invite.status, reason: `This invite has already been ${invite.status}` });
    }
    if (new Date(invite.expires_at) < new Date()) {
      await pool.query(`UPDATE household_invites SET status = 'expired' WHERE id = $1`, [invite.id]);
      return res.json({ valid: false, status: 'expired', reason: 'This invite has expired' });
    }

    res.json({
      valid: true,
      household_name: invite.household_name,
      household_id: invite.household_id,
      invited_email: invite.email,
      role: invite.role,
      invited_by_name: invite.invited_by_name,
      expires_at: invite.expires_at,
      status: invite.status
    });
  } catch (err) {
    console.error('GET /api/family-invite/:token error:', err.message);
    res.status(500).json({ error: 'Failed to load invite' });
  }
});

// Accept invite by token (requires auth — user must be logged in or just signed up)
familyInviteRouter.post('/:token/accept', requireAuth, async (req, res) => {
  const { token } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inviteResult = await client.query(`
      SELECT hi.*, h.name as household_name, h.owner_id, h.co_admin_id, h.is_incubator
      FROM household_invites hi
      JOIN households h ON h.id = hi.household_id
      WHERE hi.token = $1 AND hi.status = 'pending'
      FOR UPDATE
    `, [token]);

    if (inviteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invite not found or already used' });
    }

    const invite = inviteResult.rows[0];

    if (new Date(invite.expires_at) < new Date()) {
      await client.query(`UPDATE household_invites SET status = 'expired' WHERE id = $1`, [invite.id]);
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This invite has expired' });
    }

    // Verify the logged-in user's email matches the invite email
    const userResult = await client.query('SELECT email FROM users WHERE id = $1', [req.userId]);
    const userEmail = userResult.rows[0]?.email;
    if (!userEmail || userEmail.toLowerCase() !== invite.email.toLowerCase()) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: `This invite was sent to ${invite.email}. Please log in with that account to accept.`
      });
    }

    // Check if already a member
    const existingMember = await client.query(
      `SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2`,
      [invite.household_id, req.userId]
    );
    if (existingMember.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You are already a member of this family' });
    }

    // Check max members
    const countResult = await client.query(
      `SELECT COUNT(*) as count FROM household_members WHERE household_id = $1 AND status = 'active'`,
      [invite.household_id]
    );
    if (parseInt(countResult.rows[0].count) >= HOUSEHOLD_MAX_MEMBERS) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This family is full' });
    }

    // Map invite role to member role; owner/co_admin stay as-is
    const memberRole = invite.role === 'co_admin' ? 'co_admin' :
                       invite.role === 'minor' ? 'minor' : 'adult';

    // For incubator households, enforce sub-account cap (active non-owner members)
    if (invite.is_incubator) {
      const subCountResult = await client.query(
        `SELECT COUNT(*) as count FROM household_members
         WHERE household_id = $1 AND user_id != $2
           AND status = 'active' AND broke_away_at IS NULL`,
        [invite.household_id, invite.owner_id]
      );
      if (parseInt(subCountResult.rows[0].count) >= INCUBATOR_MAX_SUB_ACCOUNTS) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `This Family Incubator is full (max ${INCUBATOR_MAX_SUB_ACCOUNTS} sub-accounts)`
        });
      }
    }

    // Add member — mark as sub-account if this is an incubator family
    const isSubAccount = invite.is_incubator && invite.role !== 'co_admin';
    await client.query(
      `INSERT INTO household_members (household_id, user_id, role, status, joined_at, is_sub_account)
       VALUES ($1, $2, $3, 'active', NOW(), $4)`,
      [invite.household_id, req.userId, memberRole, isSubAccount]
    );

    // If invited as co_admin, promote on households table too
    if (invite.role === 'co_admin') {
      await client.query(
        `UPDATE households SET co_admin_id = $1 WHERE id = $2`,
        [req.userId, invite.household_id]
      );
    }

    // Mark invite accepted
    await client.query(
      `UPDATE household_invites SET status = 'accepted', accepted_at = NOW(), uses_count = uses_count + 1 WHERE id = $1`,
      [invite.id]
    );

    // ── Family Affiliate Setup ────────────────────────────────────────────────
    // When member joins family plan:
    // 1. Set referred_by_user_id to the family owner (makes them a direct leg)
    // 2. Create/update their affiliate record with family_household_id (if 18+)
    // 3. Under-18 members get is_minor=true, no affiliate code yet
    try {
      const memberUser = await client.query(
        'SELECT id, email, date_of_birth, referred_by_user_id FROM users WHERE id = $1',
        [req.userId]
      );
      const memberData = memberUser.rows[0];

      // Set referred_by_user_id to owner if not already set
      // This makes them a permanent leg under the owner's affiliate tree
      if (memberData && !memberData.referred_by_user_id) {
        await client.query(
          'UPDATE users SET referred_by_user_id = $1 WHERE id = $2',
          [invite.owner_id, req.userId]
        );
      }

      // Age check
      let isMinor = true;
      if (memberData?.date_of_birth) {
        const dob = new Date(memberData.date_of_birth);
        const eighteenth = new Date(dob);
        eighteenth.setFullYear(eighteenth.getFullYear() + 18);
        isMinor = new Date() < eighteenth;
      }

      if (!isMinor && invite.role !== 'minor') {
        // Adult member (18+): create/update affiliate with family_household_id
        const existingCode = await client.query(
          'SELECT referral_code FROM affiliates WHERE user_id = $1', [req.userId]
        );
        let referralCode = existingCode.rows[0]?.referral_code;
        if (!referralCode) {
          referralCode = await generateUniqueReferralCode();
        }
        await client.query(
          `INSERT INTO affiliates (user_id, email, referral_code, status, is_minor, age_verified_at, family_household_id)
           VALUES ($1, $2, $3, 'active', false, NOW(), $4)
           ON CONFLICT (user_id) DO UPDATE SET
             family_household_id = $4, is_minor = false, updated_at = NOW()`,
          [req.userId, memberData.email, referralCode, invite.household_id]
        );
        await client.query(
          `UPDATE household_members SET affiliate_id = (SELECT id FROM affiliates WHERE user_id = $1)
           WHERE household_id = $2 AND user_id = $1`,
          [req.userId, invite.household_id]
        );
      } else {
        // Minor: flag as minor, no affiliate code
        await client.query(
          `INSERT INTO affiliates (user_id, email, referral_code, status, is_minor, family_household_id)
           VALUES ($1, $2, 'MINOR-' || $1, 'paused', true, $3)
           ON CONFLICT (user_id) DO UPDATE SET is_minor = true, family_household_id = $3, updated_at = NOW()`,
          [req.userId, memberData?.email || '', invite.household_id]
        );
      }
    } catch (affiliateErr) {
      // Non-fatal: affiliate setup failure doesn't block invite acceptance
      console.error('[FamilyPlan] Affiliate setup on invite accept failed:', affiliateErr.message);
    }
    // ── End Family Affiliate Setup ────────────────────────────────────────────

    await client.query('COMMIT');

    res.json({
      success: true,
      household_id: invite.household_id,
      household_name: invite.household_name,
      role: memberRole
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/family-invite/:token/accept error:', err.message);
    res.status(500).json({ error: 'Failed to accept invite' });
  } finally {
    client.release();
  }
});

// Decline invite by token (requires auth)
familyInviteRouter.post('/:token/decline', requireAuth, async (req, res) => {
  try {
    const { token } = req.params;
    const result = await pool.query(
      `UPDATE household_invites SET status = 'declined', declined_at = NOW()
       WHERE token = $1 AND status = 'pending'
       RETURNING id`,
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found or already handled' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/family-invite/:token/decline error:', err.message);
    res.status(500).json({ error: 'Failed to decline invite' });
  }
});

// Join family via legacy invite code (backward-compat — kept for old links)
householdsRouter.post('/join', requireAuth, async (req, res) => {
  try {
    const { invite_code } = req.body;

    if (!invite_code) {
      return res.status(400).json({ error: 'Invite code is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const inviteResult = await client.query(`
        SELECT hi.*, h.name as household_name, h.owner_id
        FROM household_invites hi
        INNER JOIN households h ON hi.household_id = h.id
        WHERE hi.invite_code = $1
          AND (hi.expires_at IS NULL OR hi.expires_at > NOW())
          AND hi.uses_count < hi.max_uses
        FOR UPDATE
      `, [invite_code]);

      if (inviteResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Invalid or expired invite code' });
      }

      const invite = inviteResult.rows[0];

      const existingMember = await client.query(
        'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
        [invite.household_id, req.userId]
      );
      if (existingMember.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'You are already a member of this family' });
      }

      const memberCount = await client.query(
        `SELECT COUNT(*) as count FROM household_members WHERE household_id = $1 AND status = 'active'`,
        [invite.household_id]
      );
      if (parseInt(memberCount.rows[0].count) >= HOUSEHOLD_MAX_MEMBERS) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `family is full (max ${HOUSEHOLD_MAX_MEMBERS} members)` });
      }

      await client.query(
        `INSERT INTO household_members (household_id, user_id, role, status) VALUES ($1, $2, 'adult', 'active')`,
        [invite.household_id, req.userId]
      );

      await client.query(
        'UPDATE household_invites SET uses_count = uses_count + 1 WHERE id = $1',
        [invite.id]
      );

      // Clear any lingering offboarding records — user is back in a family
      await client.query(
        `UPDATE household_offboarding_records SET reintegrated_at = NOW() WHERE user_id = $1 AND reintegrated_at IS NULL`,
        [req.userId]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        household_id: invite.household_id,
        household_name: invite.household_name
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('POST /api/households/join error:', err.message);
    res.status(500).json({ error: 'Failed to join family' });
  }
});

// Remove member from family (owner/co-admin) — records offboarding with 30-day grace period
householdsRouter.delete('/:household_id/members/:user_id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { household_id, user_id } = req.params;
    const targetUserId = parseInt(user_id);

    // Load family — verify existence and check requester permissions
    const hhResult = await client.query(
      'SELECT id, name, owner_id, co_admin_id FROM households WHERE id = $1',
      [household_id]
    );
    if (hhResult.rows.length === 0) {
      return res.status(404).json({ error: 'family not found' });
    }
    const hh = hhResult.rows[0];

    const isOwner = hh.owner_id === req.userId;
    const isCoAdmin = hh.co_admin_id === req.userId;

    if (!isOwner && !isCoAdmin) {
      return res.status(403).json({ error: 'Only the owner or co-admin can remove members' });
    }
    const householdName = hh.name;

    // Cannot remove the owner
    if (targetUserId === req.userId) {
      return res.status(400).json({ error: 'Owner cannot remove themselves. Use Leave family instead.' });
    }

    // Check member exists
    const memberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, targetUserId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }

    await client.query('BEGIN');

    // Remove member from family
    await client.query(
      'DELETE FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, targetUserId]
    );

    // Clean up permissions and sharing settings
    await client.query(
      'DELETE FROM household_permissions WHERE household_id = $1 AND (owner_user_id = $2 OR viewer_user_id = $2)',
      [household_id, targetUserId]
    );
    await client.query(
      'DELETE FROM household_sharing_settings WHERE household_id = $1 AND user_id = $2',
      [household_id, targetUserId]
    );

    // Affiliate offboarding: clear family_household_id from their affiliate record
    // Their affiliate network belongs to THEM — stays with them after removal
    // Once they leave they remain a direct leg in the owner's affiliate tree
    await client.query(
      `UPDATE affiliates SET family_household_id = NULL, updated_at = NOW()
       WHERE user_id = $1 AND family_household_id = $2`,
      [targetUserId, household_id]
    );

    // Record offboarding with 30-day grace period
    const graceExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO household_offboarding_records
         (household_id, household_name, user_id, removal_type, removed_by_user_id, grace_expires_at)
       VALUES ($1, $2, $3, 'removed', $4, $5)`,
      [household_id, householdName, targetUserId, req.userId, graceExpiry]
    );

    const removedUserInfo = await client.query('SELECT name, email FROM users WHERE id = $1', [targetUserId]);
    const removedUser = removedUserInfo.rows[0];
    const removedName = removedUser?.name || removedUser?.email || 'A member';

    // Notify the removed member about grace period
    await client.query(
      `INSERT INTO household_notifications (household_id, for_user_id, type, message, metadata)
       VALUES ($1, $2, 'you_were_removed', $3, $4)`,
      [
        household_id,
        targetUserId,
        `You've been removed from ${householdName}. You have 30 days to join another Family Plan or upgrade to individual Pro to keep your data.`,
        JSON.stringify({ household_name: householdName, grace_expires_at: graceExpiry })
      ]
    );

    // Notify remaining members
    const remainingMembers = await client.query(
      'SELECT user_id FROM household_members WHERE household_id = $1 AND user_id != $2',
      [household_id, targetUserId]
    );

    for (const member of remainingMembers.rows) {
      await client.query(
        `INSERT INTO household_notifications (household_id, for_user_id, type, message, metadata)
         VALUES ($1, $2, 'member_removed', $3, $4)`,
        [
          household_id,
          member.user_id,
          `${removedName} has been removed from the family`,
          JSON.stringify({ removed_user_name: removedName, household_name: householdName })
        ]
      );
    }

    // Send grace period email to removed member
    if (removedUser?.email) {
      sendGracePeriodEmail({
        toEmail: removedUser.email,
        toName: removedName,
        householdName,
        graceExpiry,
        reason: 'removed'
      }).catch(err => console.error('[FamilyPlan] Grace email failed:', err.message));
    }

    await client.query('COMMIT');
    res.json({ success: true, grace_expires_at: graceExpiry });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/households/:household_id/members/:user_id error:', err.message);
    res.status(500).json({ error: 'Failed to remove member' });
  } finally {
    client.release();
  }
});

// Leave family (any member can leave, with data portability & grace period)
// Owners MUST transfer ownership first if other members exist
householdsRouter.delete('/:household_id/leave', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { household_id } = req.params;

    // Check user is a member
    const memberCheck = await pool.query(
      `SELECT hm.role, h.name, h.owner_id
       FROM household_members hm
       JOIN households h ON h.id = hm.household_id
       WHERE hm.household_id = $1 AND hm.user_id = $2`,
      [household_id, req.userId]
    );

    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'You are not a member of this family' });
    }

    const { role, name: householdName } = memberCheck.rows[0];

    // Count members
    const countResult = await pool.query(
      'SELECT COUNT(*) AS count FROM household_members WHERE household_id = $1',
      [household_id]
    );
    const memberCount = parseInt(countResult.rows[0].count);

    await client.query('BEGIN');

    if (memberCount === 1) {
      // Last member — dissolve the family completely
      await client.query('DELETE FROM household_notifications WHERE household_id = $1', [household_id]);
      await client.query('DELETE FROM household_offboarding_records WHERE household_id = $1', [household_id]);
      await client.query('DELETE FROM household_permissions WHERE household_id = $1', [household_id]);
      await client.query('DELETE FROM household_invites WHERE household_id = $1', [household_id]);
      await client.query('DELETE FROM household_links WHERE household_1_id = $1 OR household_2_id = $1', [household_id]);
      await client.query('DELETE FROM household_sharing_settings WHERE household_id = $1', [household_id]);
      await client.query('DELETE FROM household_members WHERE household_id = $1', [household_id]);
      await client.query('DELETE FROM households WHERE id = $1', [household_id]);
      // Mark any lingering offboarding records for this user as reintegrated
      await client.query(
        `UPDATE household_offboarding_records SET reintegrated_at = NOW() WHERE user_id = $1 AND reintegrated_at IS NULL`,
        [req.userId]
      );
      await client.query('COMMIT');
      return res.json({ success: true, action: 'dissolved', household_name: householdName });
    }

    // Owner cannot leave if there are other members — must transfer ownership first
    if (role === 'owner') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: 'You must transfer family ownership to another member before leaving.',
        requires_transfer: true
      });
    }

    // Remove the leaving member
    await client.query(
      'DELETE FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, req.userId]
    );

    // Clean up permissions and sharing settings
    await client.query(
      'DELETE FROM household_permissions WHERE household_id = $1 AND (owner_user_id = $2 OR viewer_user_id = $2)',
      [household_id, req.userId]
    );
    await client.query(
      'DELETE FROM household_sharing_settings WHERE household_id = $1 AND user_id = $2',
      [household_id, req.userId]
    );

    // Record offboarding with 30-day grace period
    const graceExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO household_offboarding_records
         (household_id, household_name, user_id, removal_type, removed_by_user_id, grace_expires_at)
       VALUES ($1, $2, $3, 'left', $4, $5)`,
      [household_id, householdName, req.userId, req.userId, graceExpiry]
    );

    // Notify remaining members
    const remainingMembers = await client.query(
      'SELECT user_id FROM household_members WHERE household_id = $1',
      [household_id]
    );
    const leavingUserInfo = await client.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
    const leavingName = leavingUserInfo.rows[0]?.name || leavingUserInfo.rows[0]?.email || 'A member';

    for (const member of remainingMembers.rows) {
      await client.query(
        `INSERT INTO household_notifications (household_id, for_user_id, type, message, metadata)
         VALUES ($1, $2, 'member_left', $3, $4)`,
        [
          household_id,
          member.user_id,
          `${leavingName} has left the family`,
          JSON.stringify({ left_user_name: leavingName, household_name: householdName })
        ]
      );
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      action: 'left',
      household_name: householdName,
      grace_expires_at: graceExpiry
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/households/:household_id/leave error:', err.message);
    res.status(500).json({ error: 'Failed to leave family' });
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════
// ─── FAMILY INCUBATOR (1+5 MODEL) ──────────────────────────
// ═══════════════════════════════════════════════════════════

/**
 * POST /api/households/:id/enable-incubator
 * Enable incubator mode on an existing family (owner only).
 * Only the head of family (owner) with an active Pro subscription can do this.
 * Once enabled, all non-owner members become sub-accounts with educational (L1-3) access.
 */
householdsRouter.post('/:id/enable-incubator', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const householdId = parseInt(req.params.id);

    // Verify ownership
    const hhResult = await client.query(
      'SELECT id, name, owner_id, is_incubator FROM households WHERE id = $1',
      [householdId]
    );
    if (hhResult.rows.length === 0) {
      return res.status(404).json({ error: 'family not found' });
    }
    const hh = hhResult.rows[0];
    if (hh.owner_id !== req.userId) {
      return res.status(403).json({ error: 'Only the family owner can enable incubator mode' });
    }
    if (hh.is_incubator) {
      return res.json({ success: true, message: 'family is already in incubator mode', family: hh });
    }

    // Verify the owner has an active Pro subscription
    const ownerProCheck = await hasProAccess(req.userId);
    if (!ownerProCheck) {
      return res.status(403).json({
        error: 'A $25/mo TFR Pro subscription is required to enable the Family Incubator'
      });
    }

    // Count current non-owner members
    const memberCount = await client.query(
      `SELECT COUNT(*) as count FROM household_members
       WHERE household_id = $1 AND user_id != $2 AND status = 'active'`,
      [householdId, req.userId]
    );
    if (parseInt(memberCount.rows[0].count) > INCUBATOR_MAX_SUB_ACCOUNTS) {
      return res.status(400).json({
        error: `Incubator supports max ${INCUBATOR_MAX_SUB_ACCOUNTS} sub-accounts. Current family has ${memberCount.rows[0].count} non-owner members. Please reduce to ${INCUBATOR_MAX_SUB_ACCOUNTS} first.`
      });
    }

    await client.query('BEGIN');

    // Mark family as incubator
    await client.query(
      'UPDATE households SET is_incubator = true, updated_at = NOW() WHERE id = $1',
      [householdId]
    );

    // Mark all non-owner active members as sub-accounts
    const subResult = await client.query(
      `UPDATE household_members
       SET is_sub_account = true
       WHERE household_id = $1 AND user_id != $2 AND status = 'active'
       RETURNING user_id`,
      [householdId, req.userId]
    );

    await client.query('COMMIT');

    console.log(`[Incubator] family ${householdId} enabled incubator mode. ${subResult.rowCount} sub-account(s) created.`);

    res.json({
      success: true,
      message: 'Family Incubator enabled successfully',
      sub_accounts_created: subResult.rowCount,
      max_sub_accounts: INCUBATOR_MAX_SUB_ACCOUNTS
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/households/:id/enable-incubator error:', err.message);
    res.status(500).json({ error: 'Failed to enable incubator mode' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/households/:id/incubator-status
 * Get incubator status for a family.
 * Returns sub-account list, breakaway counts, and commission eligibility.
 */
householdsRouter.get('/:id/incubator-status', requireAuth, async (req, res) => {
  try {
    const householdId = parseInt(req.params.id);

    // Verify user is a member
    const memberCheck = await pool.query(
      `SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2 AND status = 'active'`,
      [householdId, req.userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this family' });
    }

    const hhResult = await pool.query(
      'SELECT id, name, owner_id, is_incubator FROM households WHERE id = $1',
      [householdId]
    );
    if (hhResult.rows.length === 0) {
      return res.status(404).json({ error: 'family not found' });
    }
    const hh = hhResult.rows[0];

    if (!hh.is_incubator) {
      return res.json({ is_incubator: false });
    }

    // Get sub-account details
    const subAccounts = await pool.query(`
      SELECT hm.user_id, hm.is_sub_account, hm.broke_away_at, hm.commission_eligible,
             hm.joined_at, u.name, u.email, u.avatar_url, u.avatar_color
      FROM household_members hm
      JOIN users u ON u.id = hm.user_id
      WHERE hm.household_id = $1 AND hm.user_id != $2 AND hm.status = 'active'
      ORDER BY hm.joined_at ASC
    `, [householdId, hh.owner_id]);

    const active = subAccounts.rows.filter(s => !s.broke_away_at);
    const brokeAway = subAccounts.rows.filter(s => s.broke_away_at);

    res.json({
      is_incubator: true,
      household_id: hh.id,
      household_name: hh.name,
      is_owner: hh.owner_id === req.userId,
      active_sub_accounts: active.length,
      max_sub_accounts: INCUBATOR_MAX_SUB_ACCOUNTS,
      slots_available: INCUBATOR_MAX_SUB_ACCOUNTS - active.length,
      sub_accounts: active.map(s => ({
        user_id: s.user_id,
        name: s.name,
        email: s.email,
        avatar_url: s.avatar_url,
        avatar_color: s.avatar_color,
        joined_at: s.joined_at,
        commission_eligible: s.commission_eligible,
        broke_away: false
      })),
      broke_away_members: brokeAway.map(s => ({
        user_id: s.user_id,
        name: s.name,
        broke_away_at: s.broke_away_at,
        commission_eligible: s.commission_eligible
      }))
    });
  } catch (err) {
    console.error('GET /api/households/:id/incubator-status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch incubator status' });
  }
});

/**
 * POST /api/households/:id/breakaway
 * A sub-account member breaks away from the Family Incubator.
 * - Marks broke_away_at timestamp
 * - Sets commission_eligible = true
 * - Marks their affiliate record as full-eligibility
 * - Head of family's sub-account count decreases by 1
 * - Permanent: cannot rejoin as sub-account
 *
 * The sub-account keeps their referral tree position.
 * They must subscribe to their own $25/mo TFR Pro to retain Pro features.
 */
householdsRouter.post('/:id/breakaway', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const householdId = parseInt(req.params.id);

    // Verify requester is an active sub-account of this family
    const memberResult = await client.query(`
      SELECT hm.id as member_id, hm.user_id, hm.is_sub_account, hm.broke_away_at,
             hm.commission_eligible, h.owner_id, h.name as household_name, h.is_incubator
      FROM household_members hm
      JOIN households h ON h.id = hm.household_id
      WHERE hm.household_id = $1 AND hm.user_id = $2 AND hm.status = 'active'
    `, [householdId, req.userId]);

    if (memberResult.rows.length === 0) {
      return res.status(404).json({ error: 'You are not an active member of this family' });
    }

    const member = memberResult.rows[0];

    if (!member.is_incubator) {
      return res.status(400).json({ error: 'This family is not running the Family Incubator model' });
    }
    if (member.owner_id === req.userId) {
      return res.status(400).json({ error: 'The head of family cannot break away. You can dissolve the family instead.' });
    }
    if (!member.is_sub_account) {
      return res.status(400).json({ error: 'Only sub-accounts can use the breakaway feature' });
    }
    if (member.broke_away_at) {
      return res.status(400).json({ error: 'You have already broken away from this family' });
    }

    await client.query('BEGIN');

    const now = new Date();

    // 1. Mark breakaway on household_members
    await client.query(
      `UPDATE household_members
       SET broke_away_at = $1, commission_eligible = true
       WHERE household_id = $2 AND user_id = $3`,
      [now, householdId, req.userId]
    );

    // 2. Activate full commission eligibility on their affiliate record
    //    Their referral tree position is preserved — they remain in the same leg
    await client.query(
      `UPDATE affiliates
       SET family_household_id = NULL, status = 'active', updated_at = NOW()
       WHERE user_id = $1 AND family_household_id = $2`,
      [req.userId, householdId]
    );

    // 3. Unfreeze any frozen commissions from the family plan split
    await client.query(
      `UPDATE commissions
       SET frozen_until_pro = false, unfrozen_at = $1, updated_at = NOW()
       WHERE affiliate_id = (SELECT id FROM affiliates WHERE user_id = $2)
         AND frozen_until_pro = true`,
      [now, req.userId]
    );

    // 4. Notify the head of family
    const userInfo = await client.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
    const memberName = userInfo.rows[0]?.name || userInfo.rows[0]?.email || 'A sub-account';

    try {
      await client.query(
        `INSERT INTO household_notifications (household_id, for_user_id, type, message, metadata)
         VALUES ($1, $2, 'sub_account_breakaway', $3, $4)`,
        [
          householdId,
          member.owner_id,
          `${memberName} has broken away from the Family Incubator and is now an independent subscriber. They will need their own TFR Pro subscription to maintain full access.`,
          JSON.stringify({ user_id: req.userId, user_name: memberName, broke_away_at: now })
        ]
      );
    } catch (notifErr) {
      // Non-fatal
    }

    await client.query('COMMIT');

    console.log(`[Incubator] User ${req.userId} broke away from family ${householdId}`);

    res.json({
      success: true,
      message: 'You have successfully broken away from the Family Incubator',
      broke_away_at: now,
      commission_eligible: true,
      note: 'Your referral tree position is preserved. Subscribe to TFR Pro ($25/mo) to unlock full features.'
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/households/:id/breakaway error:', err.message);
    res.status(500).json({ error: 'Failed to process breakaway' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/households/:id/invite-sub-account
 * Invite a new sub-account to the Family Incubator (head of family only).
 * Enforces the 5 sub-account limit.
 */
householdsRouter.post('/:id/invite-sub-account', requireAuth, async (req, res) => {
  try {
    const householdId = parseInt(req.params.id);
    const { email, name } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    // Verify family is incubator + requester is the head
    const hhResult = await pool.query(
      'SELECT id, name, owner_id, is_incubator FROM households WHERE id = $1',
      [householdId]
    );
    if (hhResult.rows.length === 0) {
      return res.status(404).json({ error: 'family not found' });
    }
    const hh = hhResult.rows[0];
    if (!hh.is_incubator) {
      return res.status(400).json({ error: 'This family is not in incubator mode' });
    }
    if (hh.owner_id !== req.userId) {
      return res.status(403).json({ error: 'Only the head of family can invite sub-accounts' });
    }

    // Verify head has active Pro
    const headProCheck = await hasProAccess(req.userId);
    if (!headProCheck) {
      return res.status(403).json({
        error: 'Your TFR Pro subscription must be active to invite sub-accounts'
      });
    }

    // Count active sub-accounts (exclude broken-away)
    const activeCount = await pool.query(
      `SELECT COUNT(*) as count FROM household_members
       WHERE household_id = $1 AND user_id != $2
         AND status = 'active' AND broke_away_at IS NULL`,
      [householdId, req.userId]
    );
    if (parseInt(activeCount.rows[0].count) >= INCUBATOR_MAX_SUB_ACCOUNTS) {
      return res.status(400).json({
        error: `Family Incubator is full. Max ${INCUBATOR_MAX_SUB_ACCOUNTS} sub-accounts allowed. ${activeCount.rows[0].count} currently active.`
      });
    }

    // Check if email already a member
    const existingMember = await pool.query(`
      SELECT hm.id FROM household_members hm
      JOIN users u ON u.id = hm.user_id
      WHERE hm.household_id = $1 AND LOWER(u.email) = LOWER($2) AND hm.status = 'active'
    `, [householdId, email]);
    if (existingMember.rows.length > 0) {
      return res.status(400).json({ error: 'This person is already a member of the family' });
    }

    // Cancel any pending invite for this email
    await pool.query(
      `UPDATE household_invites SET status = 'cancelled'
       WHERE household_id = $1 AND LOWER(email) = LOWER($2) AND status = 'pending'`,
      [householdId, email]
    );

    // Create invite token
    const token = require('crypto').randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await pool.query(
      `INSERT INTO household_invites
         (household_id, invite_code, created_by_user_id, invited_by, email, role, token, expires_at, status, max_uses, uses_count)
       VALUES ($1, $2, $3, $3, $4, 'adult', $5, $6, 'pending', 1, 0)`,
      [householdId, token.substring(0, 20), req.userId, email, token, expiresAt]
    );

    const APP_URL = process.env.APP_URL || 'https://app.factsmoney.com';
    const inviteUrl = `${APP_URL}/family-invite.html?token=${token}&incubator=1`;

    // Send invite email
    const inviterInfo = await pool.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
    const inviterName = inviterInfo.rows[0]?.name || 'Your Head of family';

    try {
      await sendHouseholdInviteEmail({
        toEmail: email,
        inviterName,
        householdName: hh.name,
        inviteUrl,
        role: 'Sub-Account (Family Incubator)',
        customNote: 'As a Family Incubator sub-account, you\'ll get free educational access to Levels 1-3 of the FACTS system. You can upgrade to full TFR Pro at any time.'
      });
    } catch (emailErr) {
      console.error('[Incubator] Invite email failed:', emailErr.message);
      // Non-fatal: still return success, log the URL
    }

    console.log(`[Incubator] Sub-account invite sent to ${email} for family ${householdId}`);

    res.json({
      success: true,
      message: `Invitation sent to ${email}`,
      invite_url: inviteUrl,
      expires_at: expiresAt,
      slots_remaining: INCUBATOR_MAX_SUB_ACCOUNTS - parseInt(activeCount.rows[0].count) - 1
    });
  } catch (err) {
    console.error('POST /api/households/:id/invite-sub-account error:', err.message);
    res.status(500).json({ error: 'Failed to send sub-account invitation' });
  }
});

// ═══════════════════════════════════════════════════════════
// ─── family OFFBOARDING & DATA PORTABILITY ──────────────
// ═══════════════════════════════════════════════════════════

// Transfer family ownership (owner must do this before leaving if others exist)
householdsRouter.post('/:household_id/transfer-ownership', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { household_id } = req.params;
    const { new_owner_id } = req.body;

    if (!new_owner_id) {
      return res.status(400).json({ error: 'new_owner_id is required' });
    }

    // Verify requester is the current owner
    const ownerCheck = await pool.query(
      'SELECT name FROM households WHERE id = $1 AND owner_id = $2',
      [household_id, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Only the current owner can transfer ownership' });
    }
    const householdName = ownerCheck.rows[0].name;

    // Verify new owner is a member
    const memberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, new_owner_id]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(404).json({ error: 'New owner must be a current family member' });
    }

    if (parseInt(new_owner_id) === req.userId) {
      return res.status(400).json({ error: 'You are already the owner' });
    }

    await client.query('BEGIN');

    // Transfer ownership
    await client.query('UPDATE households SET owner_id = $1 WHERE id = $2', [new_owner_id, household_id]);
    await client.query(
      "UPDATE household_members SET role = 'owner' WHERE household_id = $1 AND user_id = $2",
      [household_id, new_owner_id]
    );
    await client.query(
      "UPDATE household_members SET role = 'member' WHERE household_id = $1 AND user_id = $2",
      [household_id, req.userId]
    );

    // Notify new owner
    const prevOwnerInfo = await client.query('SELECT name, email FROM users WHERE id = $1', [req.userId]);
    const prevOwnerName = prevOwnerInfo.rows[0]?.name || prevOwnerInfo.rows[0]?.email || 'The previous owner';
    await client.query(
      `INSERT INTO household_notifications (household_id, for_user_id, type, message, metadata)
       VALUES ($1, $2, 'ownership_transferred', $3, $4)`,
      [
        household_id,
        new_owner_id,
        `You are now the owner of "${householdName}"`,
        JSON.stringify({ transferred_by: prevOwnerName, household_name: householdName })
      ]
    );

    await client.query('COMMIT');
    res.json({ success: true, message: `Ownership of "${householdName}" transferred successfully` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/households/:household_id/transfer-ownership error:', err.message);
    res.status(500).json({ error: 'Failed to transfer ownership' });
  } finally {
    client.release();
  }
});

// ─── Family Plan Affiliate System ────────────────────────────────────────────

// Helper: send grace period email when member is released or owner cancels
async function sendGracePeriodEmail({ toEmail, toName, householdName, graceExpiry, reason }) {
  try {
    const graceDate = new Date(graceExpiry).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const subjectMap = {
      removed: `You've been removed from ${householdName} — 30-day grace period`,
      owner_cancelled: `Your Family Plan is ending — 30-day grace period`,
      left: `You've left ${householdName} — 30-day grace period`
    };
    const subject = subjectMap[reason] || `Family Plan change — 30-day grace period`;

    const messageMap = {
      removed: `You've been removed from the <strong>${householdName}</strong> Family Plan. You have a 30-day grace period (until <strong>${graceDate}</strong>) to either join another Family Plan or upgrade to individual Pro to keep full access to your account.`,
      owner_cancelled: `The <strong>${householdName}</strong> Family Plan has been cancelled. You have a 30-day grace period (until <strong>${graceDate}</strong>) to upgrade to individual Pro or join another Family Plan. After that, your account will revert to Free.`,
      left: `You've left the <strong>${householdName}</strong> Family Plan. Your 30-day grace period ends on <strong>${graceDate}</strong>.`
    };
    const messageBody = messageMap[reason] || `Your Family Plan status has changed. Grace period ends ${graceDate}.`;
    const appUrl = process.env.APP_URL || 'https://app.factsmoney.com';

    await sendEmail({
        to: toEmail,
        subject,
        html: `
          <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;background:#0a0f1a;color:#e8e0d4;padding:32px 24px;border-radius:12px">
            <div style="margin-bottom:20px">
              <span style="font-size:20px;font-weight:700;color:#c9a84c;letter-spacing:-0.5px">FACTS</span>
              <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#c9a84c;margin-left:10px;background:rgba(201,162,39,0.12);padding:3px 8px;border-radius:4px">Family Plan</span>
            </div>
            <h2 style="font-size:20px;font-weight:700;margin:0 0 14px;color:#e8e0d4">${subject}</h2>
            <p style="font-size:14px;line-height:1.6;color:#a89a7e;margin:0 0 24px">${messageBody}</p>
            <a href="${appUrl}/pricing.html"
               style="display:inline-block;background:#c9a84c;color:#0a0f1a;font-weight:700;font-size:14px;padding:12px 24px;border-radius:8px;text-decoration:none">
              View Plans →
            </a>
          </div>
        `
    });
  } catch (err) {
    console.error('[FamilyPlan] sendGracePeriodEmail failed:', err.message);
  }
}

// Helper: get the family owner's affiliate record
async function getHouseholdOwnerAffiliate(client, householdId) {
  const result = await client.query(
    `SELECT a.id, a.user_id, a.referral_code FROM affiliates a
     JOIN households h ON h.owner_id = a.user_id
     WHERE h.id = $1 AND a.status IN ('active','at_risk') LIMIT 1`,
    [householdId]
  );
  return result.rows[0] || null;
}

// GET /api/households/:id/family-commissions
// Owner views the 50/50 commission split per family member
householdsRouter.get('/:id/family-commissions', requireAuth, async (req, res) => {
  try {
    const householdId = parseInt(req.params.id);

    // Verify requester is owner
    const hhResult = await pool.query(
      'SELECT id, name, owner_id FROM households WHERE id = $1', [householdId]
    );
    if (hhResult.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    if (hhResult.rows[0].owner_id !== req.userId) return res.status(403).json({ error: 'Only the owner can view family commissions' });

    // Get all family members with their affiliate data + commission totals
    const membersResult = await pool.query(
      `SELECT
         hm.user_id,
         u.name,
         u.email,
         hm.role,
         a.id AS affiliate_id,
         a.referral_code,
         a.status AS affiliate_status,
         -- Owner's earned share (owner_share type)
         COALESCE(owner_commissions.total_owner_cents, 0) AS owner_earned_cents,
         -- Member's frozen share (member_frozen type, still frozen)
         COALESCE(frozen_commissions.total_frozen_cents, 0) AS member_frozen_cents,
         -- Member's frozen that has been unfrozen (Pro upgrade)
         COALESCE(unfrozen_commissions.total_unfrozen_cents, 0) AS member_unfrozen_cents,
         -- Gifts sent by owner to this member
         COALESCE(gifts.total_gifted_cents, 0) AS owner_gifted_cents
       FROM household_members hm
       JOIN users u ON u.id = hm.user_id
       LEFT JOIN affiliates a ON a.user_id = hm.user_id AND a.family_household_id = $1
       LEFT JOIN (
         SELECT affiliate_id, SUM(amount_cents) AS total_owner_cents
         FROM commissions
         WHERE family_household_id = $1 AND family_split_type = 'owner_share' AND status != 'forfeited'
         GROUP BY affiliate_id
       ) owner_commissions ON owner_commissions.affiliate_id = a.id
       LEFT JOIN (
         SELECT affiliate_id, SUM(amount_cents) AS total_frozen_cents
         FROM commissions
         WHERE family_household_id = $1 AND family_split_type = 'member_frozen'
           AND frozen_until_pro = true AND unfrozen_at IS NULL AND status != 'forfeited'
         GROUP BY affiliate_id
       ) frozen_commissions ON frozen_commissions.affiliate_id = a.id
       LEFT JOIN (
         SELECT affiliate_id, SUM(amount_cents) AS total_unfrozen_cents
         FROM commissions
         WHERE family_household_id = $1 AND family_split_type = 'member_frozen' AND unfrozen_at IS NOT NULL
         GROUP BY affiliate_id
       ) unfrozen_commissions ON unfrozen_commissions.affiliate_id = a.id
       LEFT JOIN (
         SELECT to_affiliate_id, SUM(amount_cents) AS total_gifted_cents
         FROM family_commission_gifts
         WHERE household_id = $1
         GROUP BY to_affiliate_id
       ) gifts ON gifts.to_affiliate_id = a.id
       WHERE hm.household_id = $1 AND hm.user_id != $2
       ORDER BY hm.joined_at ASC`,
      [householdId, req.userId]
    );

    // Get owner's own affiliate total from family plan
    const ownerAffResult = await pool.query(
      `SELECT
         a.id, a.referral_code, a.status,
         COALESCE(SUM(c.amount_cents) FILTER (WHERE c.family_split_type = 'owner_share' AND c.status != 'forfeited'), 0) AS total_owner_earned_cents
       FROM affiliates a
       LEFT JOIN commissions c ON c.affiliate_id = a.id AND c.family_household_id = $1
       WHERE a.user_id = $2
       GROUP BY a.id, a.referral_code, a.status
       LIMIT 1`,
      [householdId, req.userId]
    );

    res.json({
      success: true,
      household_id: householdId,
      owner_affiliate: ownerAffResult.rows[0] || null,
      members: membersResult.rows.map(m => ({
        user_id: m.user_id,
        name: m.name,
        email: m.email,
        role: m.role,
        affiliate_id: m.affiliate_id,
        referral_code: m.referral_code,
        affiliate_status: m.affiliate_status,
        owner_earned_cents: parseInt(m.owner_earned_cents),
        member_frozen_cents: parseInt(m.member_frozen_cents),
        member_unfrozen_cents: parseInt(m.member_unfrozen_cents),
        owner_gifted_cents: parseInt(m.owner_gifted_cents),
        net_owner_available_cents: Math.max(0, parseInt(m.owner_earned_cents) - parseInt(m.owner_gifted_cents))
      }))
    });
  } catch (err) {
    console.error('GET /api/households/:id/family-commissions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch family commissions' });
  }
});

// POST /api/households/:id/gift-commission
// Owner gifts some or all of their earned 50% to a family member,
// OR releases the member's frozen 50% to them
householdsRouter.post('/:id/gift-commission', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const householdId = parseInt(req.params.id);
    const { to_user_id, amount_cents, gift_type = 'owner_to_member', note } = req.body;

    if (!to_user_id || !amount_cents || amount_cents <= 0) {
      return res.status(400).json({ error: 'to_user_id and amount_cents (positive) are required' });
    }
    if (!['owner_to_member', 'unfreeze_member'].includes(gift_type)) {
      return res.status(400).json({ error: 'gift_type must be owner_to_member or unfreeze_member' });
    }

    // Verify requester is owner
    const hhResult = await client.query(
      'SELECT id, name, owner_id FROM households WHERE id = $1', [householdId]
    );
    if (hhResult.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    if (hhResult.rows[0].owner_id !== req.userId) return res.status(403).json({ error: 'Only the owner can gift commissions' });

    // Get owner affiliate
    const ownerAff = await client.query(
      'SELECT id FROM affiliates WHERE user_id = $1 AND status IN (\'active\',\'at_risk\') LIMIT 1',
      [req.userId]
    );
    if (ownerAff.rows.length === 0) return res.status(400).json({ error: 'Owner must be an active affiliate to gift commissions' });
    const ownerAffiliateId = ownerAff.rows[0].id;

    // Get member affiliate
    const memberAff = await client.query(
      'SELECT id, user_id FROM affiliates WHERE user_id = $1 AND family_household_id = $2 LIMIT 1',
      [to_user_id, householdId]
    );
    if (memberAff.rows.length === 0) return res.status(404).json({ error: 'Member affiliate not found in this family' });
    const memberAffiliateId = memberAff.rows[0].id;

    await client.query('BEGIN');

    if (gift_type === 'owner_to_member') {
      // Owner gifts their 50% share to the member
      // Deduct from owner's pending_balance_cents, add to member's
      const gifted = parseInt(amount_cents);
      await client.query(
        `UPDATE affiliates SET pending_balance_cents = pending_balance_cents - $1, updated_at = NOW() WHERE id = $2`,
        [gifted, ownerAffiliateId]
      );
      await client.query(
        `UPDATE affiliates SET pending_balance_cents = pending_balance_cents + $1, updated_at = NOW() WHERE id = $2`,
        [gifted, memberAffiliateId]
      );
    } else if (gift_type === 'unfreeze_member') {
      // Owner releases member's frozen commissions
      // Mark frozen commissions as unfrozen (member can now withdraw)
      const gifted = parseInt(amount_cents);
      await client.query(
        `UPDATE commissions SET frozen_until_pro = false, unfrozen_at = NOW(), updated_at = NOW()
         WHERE affiliate_id = $1 AND family_household_id = $2 AND family_split_type = 'member_frozen'
           AND frozen_until_pro = true AND unfrozen_at IS NULL
         LIMIT CEIL($3::float / NULLIF((
           SELECT AVG(amount_cents) FROM commissions
           WHERE affiliate_id = $1 AND family_split_type = 'member_frozen' AND frozen_until_pro = true
         ), 1))`,
        [memberAffiliateId, householdId, amount_cents]
      );
      // Move from frozen to accessible in affiliate balance
      await client.query(
        `UPDATE affiliates SET pending_balance_cents = pending_balance_cents + $1, updated_at = NOW() WHERE id = $2`,
        [gifted, memberAffiliateId]
      );
    }

    // Record the gift
    await client.query(
      `INSERT INTO family_commission_gifts
         (household_id, from_affiliate_id, to_affiliate_id, from_user_id, to_user_id, amount_cents, gift_type, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [householdId, ownerAffiliateId, memberAffiliateId, req.userId, to_user_id, amount_cents, gift_type, note || null]
    );

    // Notify the member
    await client.query(
      `INSERT INTO household_notifications (household_id, for_user_id, type, message, metadata)
       VALUES ($1, $2, 'commission_gift', $3, $4)`,
      [
        householdId,
        to_user_id,
        gift_type === 'unfreeze_member'
          ? `$${(amount_cents / 100).toFixed(2)} of your frozen commissions have been released by the family owner!`
          : `The family owner gifted you $${(amount_cents / 100).toFixed(2)} from their commission earnings!`,
        JSON.stringify({ amount_cents, gift_type })
      ]
    );

    await client.query('COMMIT');
    res.json({ success: true, amount_gifted_cents: amount_cents, gift_type });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/households/:id/gift-commission error:', err.message);
    res.status(500).json({ error: 'Failed to process gift' });
  } finally {
    client.release();
  }
});

// POST /api/households/:id/cascade-cancellation-grace
// Called when billing owner cancels their subscription — all members get 30-day grace
householdsRouter.post('/:id/cascade-cancellation-grace', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const householdId = parseInt(req.params.id);

    const hhResult = await client.query(
      'SELECT id, name, owner_id FROM households WHERE id = $1', [householdId]
    );
    if (hhResult.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    if (hhResult.rows[0].owner_id !== req.userId) return res.status(403).json({ error: 'Owner only' });

    const householdName = hhResult.rows[0].name;
    const graceExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    await client.query('BEGIN');

    // Mark family as cancelled with grace period
    await client.query(
      `UPDATE households SET cancelled_at = NOW(), cancellation_grace_ends_at = $1 WHERE id = $2`,
      [graceExpiry, householdId]
    );

    // Get all non-owner members
    const membersResult = await client.query(
      `SELECT hm.user_id, u.name, u.email
       FROM household_members hm
       JOIN users u ON u.id = hm.user_id
       WHERE hm.household_id = $1 AND hm.user_id != $2`,
      [householdId, req.userId]
    );

    for (const member of membersResult.rows) {
      // Record offboarding with grace for each member
      await client.query(
        `INSERT INTO household_offboarding_records
           (household_id, household_name, user_id, removal_type, removed_by_user_id, grace_expires_at)
         VALUES ($1, $2, $3, 'dissolved', $4, $5)
         ON CONFLICT DO NOTHING`,
        [householdId, householdName, member.user_id, req.userId, graceExpiry]
      );

      // In-app notification
      await client.query(
        `INSERT INTO household_notifications (household_id, for_user_id, type, message, metadata)
         VALUES ($1, $2, 'plan_cancelled', $3, $4)`,
        [
          householdId,
          member.user_id,
          `The ${householdName} Family Plan has been cancelled. You have 30 days to upgrade to individual Pro or elect a new billing owner.`,
          JSON.stringify({ household_name: householdName, grace_expires_at: graceExpiry })
        ]
      );

      // Email
      if (member.email) {
        sendGracePeriodEmail({
          toEmail: member.email,
          toName: member.name || member.email,
          householdName,
          graceExpiry,
          reason: 'owner_cancelled'
        }).catch(() => {});
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, grace_expires_at: graceExpiry, members_notified: membersResult.rows.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/households/:id/cascade-cancellation-grace error:', err.message);
    res.status(500).json({ error: 'Failed to cascade cancellation grace' });
  } finally {
    client.release();
  }
});

// POST /api/households/:id/reactivate
// Owner can undo a cancellation during the grace period to re-activate their family
householdsRouter.post('/:id/reactivate', requireAuth, async (req, res) => {
  try {
    const householdId = parseInt(req.params.id);

    const hhResult = await pool.query(
      'SELECT id, name, owner_id, cancelled_at, cancellation_grace_ends_at FROM households WHERE id = $1',
      [householdId]
    );
    if (hhResult.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    const hh = hhResult.rows[0];

    if (hh.owner_id !== req.userId) {
      return res.status(403).json({ error: 'Only the family owner can reactivate' });
    }
    if (!hh.cancelled_at) {
      return res.json({ success: true, message: 'family is already active' });
    }

    await pool.query(
      'UPDATE households SET cancelled_at = NULL, cancellation_grace_ends_at = NULL WHERE id = $1',
      [householdId]
    );

    // Clear offboarding records for members of this family
    await pool.query(
      `UPDATE household_offboarding_records SET reintegrated_at = NOW()
       WHERE household_id = $1 AND reintegrated_at IS NULL`,
      [householdId]
    );

    res.json({ success: true, message: 'family reactivated successfully' });
  } catch (err) {
    console.error('POST /api/households/:id/reactivate error:', err.message);
    res.status(500).json({ error: 'Failed to reactivate family' });
  }
});

// POST /api/households/:id/elect-owner
// During grace period after owner cancellation, a member nominates themselves as new billing owner
householdsRouter.post('/:id/elect-owner', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const householdId = parseInt(req.params.id);

    const hhResult = await client.query(
      'SELECT id, name, owner_id, cancellation_grace_ends_at FROM households WHERE id = $1', [householdId]
    );
    if (hhResult.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    const hh = hhResult.rows[0];

    // Grace period must be active
    if (!hh.cancellation_grace_ends_at || new Date(hh.cancellation_grace_ends_at) < new Date()) {
      return res.status(400).json({ error: 'Grace period has expired' });
    }

    // Must be an active member
    const memberCheck = await client.query(
      `SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2`,
      [householdId, req.userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You must be a family member to become the billing owner' });
    }

    await client.query('BEGIN');

    // Transfer ownership
    await client.query('UPDATE households SET owner_id = $1, cancelled_at = NULL, cancellation_grace_ends_at = NULL WHERE id = $2',
      [req.userId, householdId]);
    await client.query(
      `UPDATE household_members SET role = 'owner' WHERE household_id = $1 AND user_id = $2`,
      [householdId, req.userId]
    );
    await client.query(
      `UPDATE household_members SET role = 'member' WHERE household_id = $1 AND user_id = $2`,
      [householdId, hh.owner_id]
    );

    // Record election
    await client.query(
      `INSERT INTO household_owner_elections (household_id, nominee_user_id, nominated_by_user_id, status, resolved_at)
       VALUES ($1, $2, $2, 'accepted', NOW())`,
      [householdId, req.userId]
    );

    // Notify family
    await client.query(
      `INSERT INTO household_notifications (household_id, for_user_id, type, message, metadata)
       VALUES ($1, $2, 'new_owner_elected', $3, $4)`,
      [householdId, req.userId, `You are now the billing owner of ${hh.name}. Upgrade to Family Plan to restore full access for all members.`,
       JSON.stringify({ household_name: hh.name })]
    );

    await client.query('COMMIT');
    res.json({ success: true, new_owner_id: req.userId, household_id: householdId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/households/:id/elect-owner error:', err.message);
    res.status(500).json({ error: 'Failed to elect new owner' });
  } finally {
    client.release();
  }
});

// Get family notifications for current user
householdsRouter.get('/notifications', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, household_id, type, message, metadata, read_at, created_at
       FROM household_notifications
       WHERE for_user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.userId]
    );
    res.json({ notifications: result.rows, unread_count: result.rows.filter(n => !n.read_at).length });
  } catch (err) {
    console.error('GET /api/households/notifications error:', err.message);
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// Mark family notification as read
householdsRouter.post('/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE household_notifications SET read_at = NOW() WHERE id = $1 AND for_user_id = $2',
      [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('POST notification read error:', err.message);
    res.status(500).json({ error: 'Failed to mark notification' });
  }
});

// Mark all family notifications as read
householdsRouter.post('/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE household_notifications SET read_at = NOW() WHERE for_user_id = $1 AND read_at IS NULL',
      [req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('POST notifications read-all error:', err.message);
    res.status(500).json({ error: 'Failed to mark notifications' });
  }
});

// ═══════════════════════════════════════════════════════════
// ─── family LINKING ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════

// Link two households together (owner only)
// Allows viewing data across linked households (max 3 households total)
householdsRouter.post('/:household_id/link', requireAuth, async (req, res) => {
  try {
    const { household_id } = req.params;
    const { target_household_id } = req.body;

    if (!target_household_id) {
      return res.status(400).json({ error: 'target_household_id is required' });
    }

    // Verify requester is owner of source family
    const ownerCheck = await pool.query(
      'SELECT 1 FROM households WHERE id = $1 AND owner_id = $2',
      [household_id, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Only family owner can create links' });
    }

    // Verify user is also a member (not necessarily owner) of target family
    const memberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [target_household_id, req.userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You must be a member of the target family to link it' });
    }

    // Check if already linked
    const existingLink = await pool.query(
      `SELECT 1 FROM household_links
       WHERE (household_1_id = $1 AND household_2_id = $2)
          OR (household_1_id = $2 AND household_2_id = $1)`,
      [household_id, target_household_id]
    );
    if (existingLink.rows.length > 0) {
      return res.status(400).json({ error: 'Households are already linked' });
    }

    // Count current links for source family (including transitive links)
    const sourceLinks = await pool.query(
      `SELECT household_1_id, household_2_id FROM household_links
       WHERE household_1_id = $1 OR household_2_id = $1`,
      [household_id]
    );

    // Build set of all connected households
    const connectedHouseholds = new Set([parseInt(household_id)]);
    sourceLinks.rows.forEach(link => {
      connectedHouseholds.add(link.household_1_id);
      connectedHouseholds.add(link.household_2_id);
    });

    // Check target family's links too
    const targetLinks = await pool.query(
      `SELECT household_1_id, household_2_id FROM household_links
       WHERE household_1_id = $1 OR household_2_id = $1`,
      [target_household_id]
    );
    targetLinks.rows.forEach(link => {
      connectedHouseholds.add(link.household_1_id);
      connectedHouseholds.add(link.household_2_id);
    });

    // Verify we won't exceed 3 total households in the group
    if (connectedHouseholds.size >= 3) {
      return res.status(400).json({ error: 'Cannot link more than 3 households together' });
    }

    // Create link (always store with lower ID first)
    const [h1, h2] = [household_id, target_household_id].sort((a, b) => a - b);
    await pool.query(
      'INSERT INTO household_links (household_1_id, household_2_id) VALUES ($1, $2)',
      [h1, h2]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/households/:household_id/link error:', err.message);
    res.status(500).json({ error: 'Failed to link households' });
  }
});

// Get all linked households for a family
householdsRouter.get('/:household_id/links', requireAuth, async (req, res) => {
  try {
    const { household_id } = req.params;

    // Verify user is a member of this family
    const memberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, req.userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this family' });
    }

    // Get all linked households
    const result = await pool.query(
      `SELECT
        h.id, h.name, h.owner_id, h.created_at,
        (SELECT COUNT(*) FROM household_members WHERE household_id = h.id) as member_count
      FROM household_links hl
      INNER JOIN households h ON (
        CASE
          WHEN hl.household_1_id = $1 THEN h.id = hl.household_2_id
          ELSE h.id = hl.household_1_id
        END
      )
      WHERE hl.household_1_id = $1 OR hl.household_2_id = $1
      ORDER BY h.name`,
      [household_id]
    );

    res.json({ links: result.rows });
  } catch (err) {
    console.error('GET /api/households/:household_id/links error:', err.message);
    res.status(500).json({ error: 'Failed to fetch linked households' });
  }
});

// Remove family link (owner of either family)
householdsRouter.delete('/:household_id/link/:target_household_id', requireAuth, async (req, res) => {
  try {
    const { household_id, target_household_id } = req.params;

    // Verify user is owner of either family
    const ownerCheck = await pool.query(
      'SELECT 1 FROM households WHERE (id = $1 OR id = $2) AND owner_id = $3',
      [household_id, target_household_id, req.userId]
    );
    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Only family owners can remove links' });
    }

    // Delete link (check both orderings)
    const [h1, h2] = [household_id, target_household_id].sort((a, b) => a - b);
    const result = await pool.query(
      'DELETE FROM household_links WHERE household_1_id = $1 AND household_2_id = $2 RETURNING *',
      [h1, h2]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Link not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/households/:household_id/link/:target_household_id error:', err.message);
    res.status(500).json({ error: 'Failed to remove link' });
  }
});

// ═══════════════════════════════════════════════════════════
// ─── family DASHBOARD ──────────────────────────────────
// ═══════════════════════════════════════════════════════════

// Get combined family dashboard (all members' financial data aggregated)
householdsRouter.get('/:household_id/dashboard', requireAuth, async (req, res) => {
  try {
    const { household_id } = req.params;

    // Verify user is a member of this family
    const memberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, req.userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this family' });
    }

    // Get family name + all member IDs
    const householdInfoResult = await pool.query(
      'SELECT name FROM households WHERE id = $1',
      [household_id]
    );
    const householdName = householdInfoResult.rows.length > 0 ? householdInfoResult.rows[0].name : null;

    const membersResult = await pool.query(
      'SELECT user_id FROM household_members WHERE household_id = $1 AND status = $2',
      [household_id, 'active']
    );
    const memberIds = membersResult.rows.map(m => m.user_id);

    if (memberIds.length === 0) {
      return res.json({
        household_name: householdName,
        total_income: '0.00',
        total_expenses: '0.00',
        net_balance: '0.00',
        categories: [],
        member_count: 0
      });
    }

    // Calculate family totals
    const totals = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as total_income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as total_expenses
      FROM transactions
      WHERE user_id = ANY($1)
    `, [memberIds]);

    const { total_income, total_expenses } = totals.rows[0];
    const net_balance = parseFloat(total_income) - parseFloat(total_expenses);

    // Get category breakdown across all family members (includes split expenses + actual set-aside)
    const categoryStats = await pool.query(`
      WITH expense_by_category AS (
        SELECT category_id, SUM(amount) as spent
        FROM transactions
        WHERE user_id = ANY($1) AND type = 'expense' AND (is_split = FALSE OR is_split IS NULL)
        GROUP BY category_id
        UNION ALL
        SELECT ta.category_id, SUM(ta.amount) as spent
        FROM transaction_allocations ta
        JOIN transactions t ON t.id = ta.transaction_id
        WHERE t.user_id = ANY($1) AND t.type = 'expense' AND t.is_split = TRUE
        GROUP BY ta.category_id
      ),
      income_alloc_by_cat AS (
        SELECT ta.category_id, SUM(t.amount * ta.percentage / 100.0) as set_aside
        FROM transaction_allocations ta
        JOIN transactions t ON t.id = ta.transaction_id
        WHERE t.user_id = ANY($1) AND t.type = 'income'
        GROUP BY ta.category_id
      ),
      unallocated_income_total AS (
        SELECT COALESCE(SUM(t.amount), 0) as total
        FROM transactions t
        WHERE t.user_id = ANY($1) AND t.type = 'income'
          AND NOT EXISTS (
            SELECT 1 FROM transaction_allocations ta WHERE ta.transaction_id = t.id
          )
      )
      SELECT
        c.id, c.name, c.slug, c.color, c.icon,
        COALESCE(SUM(ebc.spent), 0) as spent,
        COALESCE(iac.set_aside, 0) as snapshot_set_aside
      FROM categories c
      LEFT JOIN expense_by_category ebc ON ebc.category_id = c.id
      LEFT JOIN income_alloc_by_cat iac ON iac.category_id = c.id
      GROUP BY c.id, c.name, c.slug, c.color, c.icon, iac.set_aside
      ORDER BY c.sort_order
    `, [memberIds]);

    // Get unallocated income total for fallback
    const unallocResult = await pool.query(`
      SELECT COALESCE(SUM(t.amount), 0) as total
      FROM transactions t
      WHERE t.user_id = ANY($1) AND t.type = 'income'
        AND NOT EXISTS (
          SELECT 1 FROM transaction_allocations ta WHERE ta.transaction_id = t.id
        )
    `, [memberIds]);
    const unallocatedIncome = parseFloat(unallocResult.rows[0].total) || 0;

    // Get average allocation percentages across family
    const allocationStats = await pool.query(`
      SELECT
        c.id,
        COALESCE(AVG(COALESCE(ua.percentage, ac.percentage)), 0) as avg_percentage
      FROM categories c
      JOIN allocation_config ac ON ac.category_id = c.id
      LEFT JOIN user_allocations ua ON ua.category_id = c.id AND ua.user_id = ANY($1)
      GROUP BY c.id
    `, [memberIds]);

    const allocMap = {};
    allocationStats.rows.forEach(row => {
      allocMap[row.id] = parseFloat(row.avg_percentage);
    });

    const categories = categoryStats.rows.map(cat => {
      const targetPct = allocMap[cat.id] || 0;
      const allocated = (targetPct / 100) * parseFloat(total_income);
      const actualSetAside = parseFloat(cat.snapshot_set_aside) + (unallocatedIncome * targetPct / 100);
      const spent = parseFloat(cat.spent);

      return {
        ...cat,
        allocated: allocated.toFixed(2),
        actual_set_aside: actualSetAside.toFixed(2),
        spent: spent.toFixed(2),
        remaining: (actualSetAside - spent).toFixed(2),
        usage_percent: actualSetAside > 0 ? Math.min(100, (spent / actualSetAside * 100)).toFixed(1) : '0.0',
        target_percentage: targetPct.toFixed(1)
      };
    });

    res.json({
      household_name: householdName,
      total_income: parseFloat(total_income).toFixed(2),
      total_expenses: parseFloat(total_expenses).toFixed(2),
      net_balance: net_balance.toFixed(2),
      categories,
      member_count: memberIds.length
    });
  } catch (err) {
    console.error('GET /api/households/:household_id/dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to fetch family dashboard' });
  }
});

// Get individual member summaries for a family
householdsRouter.get('/:household_id/members-summary', requireAuth, async (req, res) => {
  try {
    const { household_id } = req.params;

    // Verify user is a member of this family
    const memberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, req.userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this family' });
    }

    // Get all members with their financial summaries
    const members = await pool.query(`
      SELECT
        u.id,
        u.name,
        u.email,
        hm.role,
        COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END), 0) as total_income,
        COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) as total_expenses
      FROM household_members hm
      INNER JOIN users u ON hm.user_id = u.id
      LEFT JOIN transactions t ON t.user_id = u.id
      WHERE hm.household_id = $1 AND hm.status = 'active'
      GROUP BY u.id, u.name, u.email, hm.role
      ORDER BY
        CASE WHEN hm.role = 'owner' THEN 0 ELSE 1 END,
        u.name
    `, [household_id]);

    const memberSummaries = members.rows.map(member => ({
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      total_income: parseFloat(member.total_income).toFixed(2),
      total_expenses: parseFloat(member.total_expenses).toFixed(2),
      net_balance: (parseFloat(member.total_income) - parseFloat(member.total_expenses)).toFixed(2)
    }));

    res.json({ members: memberSummaries });
  } catch (err) {
    console.error('GET /api/households/:household_id/members-summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch member summaries' });
  }
});

// Get combined dashboard across all linked households
householdsRouter.get('/:household_id/linked-dashboard', requireAuth, async (req, res) => {
  try {
    const { household_id } = req.params;

    // Verify user is a member of this family
    const memberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, req.userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this family' });
    }

    // Get all linked family IDs (including current family)
    const linkedResult = await pool.query(`
      SELECT DISTINCT
        CASE
          WHEN household_1_id = $1 THEN household_2_id
          ELSE household_1_id
        END as linked_household_id
      FROM household_links
      WHERE household_1_id = $1 OR household_2_id = $1
    `, [household_id]);

    const linkedHouseholdIds = [
      parseInt(household_id),
      ...linkedResult.rows.map(r => r.linked_household_id)
    ];

    // Get all member IDs across all linked households
    const allMembersResult = await pool.query(
      'SELECT user_id FROM household_members WHERE household_id = ANY($1)',
      [linkedHouseholdIds]
    );
    const allMemberIds = allMembersResult.rows.map(m => m.user_id);

    if (allMemberIds.length === 0) {
      return res.json({
        total_income: '0.00',
        total_expenses: '0.00',
        net_balance: '0.00',
        categories: [],
        linked_household_count: linkedHouseholdIds.length,
        total_member_count: 0
      });
    }

    // Calculate combined totals
    const totals = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) as total_income,
        COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) as total_expenses
      FROM transactions
      WHERE user_id = ANY($1)
    `, [allMemberIds]);

    const { total_income, total_expenses } = totals.rows[0];
    const net_balance = parseFloat(total_income) - parseFloat(total_expenses);

    // Get category breakdown (includes split expenses + actual set-aside)
    const categoryStats = await pool.query(`
      WITH expense_by_category AS (
        SELECT category_id, SUM(amount) as spent
        FROM transactions
        WHERE user_id = ANY($1) AND type = 'expense' AND (is_split = FALSE OR is_split IS NULL)
        GROUP BY category_id
        UNION ALL
        SELECT ta.category_id, SUM(ta.amount) as spent
        FROM transaction_allocations ta
        JOIN transactions t ON t.id = ta.transaction_id
        WHERE t.user_id = ANY($1) AND t.type = 'expense' AND t.is_split = TRUE
        GROUP BY ta.category_id
      ),
      income_alloc_by_cat AS (
        SELECT ta.category_id, SUM(t.amount * ta.percentage / 100.0) as set_aside
        FROM transaction_allocations ta
        JOIN transactions t ON t.id = ta.transaction_id
        WHERE t.user_id = ANY($1) AND t.type = 'income'
        GROUP BY ta.category_id
      )
      SELECT
        c.id, c.name, c.slug, c.color, c.icon,
        COALESCE(SUM(ebc.spent), 0) as spent,
        COALESCE(iac.set_aside, 0) as snapshot_set_aside
      FROM categories c
      LEFT JOIN expense_by_category ebc ON ebc.category_id = c.id
      LEFT JOIN income_alloc_by_cat iac ON iac.category_id = c.id
      GROUP BY c.id, c.name, c.slug, c.color, c.icon, iac.set_aside
      ORDER BY c.sort_order
    `, [allMemberIds]);

    // Get unallocated income total for fallback
    const linkedUnallocResult = await pool.query(`
      SELECT COALESCE(SUM(t.amount), 0) as total
      FROM transactions t
      WHERE t.user_id = ANY($1) AND t.type = 'income'
        AND NOT EXISTS (
          SELECT 1 FROM transaction_allocations ta WHERE ta.transaction_id = t.id
        )
    `, [allMemberIds]);
    const linkedUnallocatedIncome = parseFloat(linkedUnallocResult.rows[0].total) || 0;

    // Get average allocation percentages
    const allocationStats = await pool.query(`
      SELECT
        c.id,
        COALESCE(AVG(COALESCE(ua.percentage, ac.percentage)), 0) as avg_percentage
      FROM categories c
      JOIN allocation_config ac ON ac.category_id = c.id
      LEFT JOIN user_allocations ua ON ua.category_id = c.id AND ua.user_id = ANY($1)
      GROUP BY c.id
    `, [allMemberIds]);

    const allocMap = {};
    allocationStats.rows.forEach(row => {
      allocMap[row.id] = parseFloat(row.avg_percentage);
    });

    const categories = categoryStats.rows.map(cat => {
      const targetPct = allocMap[cat.id] || 0;
      const allocated = (targetPct / 100) * parseFloat(total_income);
      const actualSetAside = parseFloat(cat.snapshot_set_aside) + (linkedUnallocatedIncome * targetPct / 100);
      const spent = parseFloat(cat.spent);

      return {
        ...cat,
        allocated: allocated.toFixed(2),
        actual_set_aside: actualSetAside.toFixed(2),
        spent: spent.toFixed(2),
        remaining: (actualSetAside - spent).toFixed(2),
        usage_percent: actualSetAside > 0 ? Math.min(100, (spent / actualSetAside * 100)).toFixed(1) : '0.0',
        target_percentage: targetPct.toFixed(1)
      };
    });

    // Get per-family summaries
    const householdSummaries = await pool.query(`
      SELECT
        h.id,
        h.name,
        COUNT(DISTINCT hm.user_id) as member_count,
        COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END), 0) as total_income,
        COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) as total_expenses
      FROM households h
      INNER JOIN household_members hm ON h.id = hm.household_id
      LEFT JOIN transactions t ON t.user_id = hm.user_id
      WHERE h.id = ANY($1)
      GROUP BY h.id, h.name
      ORDER BY h.id
    `, [linkedHouseholdIds]);

    const householdBreakdown = householdSummaries.rows.map(h => ({
      id: h.id,
      name: h.name,
      member_count: parseInt(h.member_count),
      total_income: parseFloat(h.total_income).toFixed(2),
      total_expenses: parseFloat(h.total_expenses).toFixed(2),
      net_balance: (parseFloat(h.total_income) - parseFloat(h.total_expenses)).toFixed(2)
    }));

    res.json({
      total_income: parseFloat(total_income).toFixed(2),
      total_expenses: parseFloat(total_expenses).toFixed(2),
      net_balance: net_balance.toFixed(2),
      categories,
      linked_household_count: linkedHouseholdIds.length,
      total_member_count: allMemberIds.length,
      household_breakdown: householdBreakdown
    });
  } catch (err) {
    console.error('GET /api/households/:household_id/linked-dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to fetch linked family dashboard' });
  }
});

// ═══════════════════════════════════════════════════════════
// ─── family SHARING SETTINGS (Broadcast privacy) ─────
// ═══════════════════════════════════════════════════════════

// GET /api/households/:id/sharing-settings — my broadcast sharing preferences
householdsRouter.get('/:household_id/sharing-settings', requireAuth, async (req, res) => {
  try {
    const { household_id } = req.params;
    const memberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, req.userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this family' });

    const result = await pool.query(`
      SELECT hss.*, c.name as category_name, c.slug as category_slug, c.icon as category_icon, c.color as category_color
      FROM household_sharing_settings hss
      LEFT JOIN categories c ON c.id = hss.category_id
      WHERE hss.household_id = $1 AND hss.user_id = $2
      ORDER BY c.sort_order NULLS FIRST
    `, [household_id, req.userId]);
    res.json({ settings: result.rows });
  } catch (err) {
    console.error('GET family sharing-settings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch sharing settings' });
  }
});

// POST /api/households/:id/sharing-settings — upsert sharing settings
householdsRouter.post('/:household_id/sharing-settings', requireAuth, async (req, res) => {
  try {
    const { household_id } = req.params;
    const { category_id, share_allocations = false, share_transactions = false } = req.body;

    const memberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, req.userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this family' });

    const result = await pool.query(`
      INSERT INTO household_sharing_settings
        (household_id, user_id, category_id, share_allocations, share_transactions)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (household_id, user_id, category_id)
      DO UPDATE SET
        share_allocations = EXCLUDED.share_allocations,
        share_transactions = EXCLUDED.share_transactions,
        updated_at = NOW()
      RETURNING *
    `, [household_id, req.userId, category_id || null, share_allocations, share_transactions]);

    res.json({ success: true, setting: result.rows[0] });
  } catch (err) {
    console.error('POST family sharing-settings error:', err.message);
    res.status(500).json({ error: 'Failed to update sharing settings' });
  }
});

// GET /api/households/:id/members-sharing — all members' sharing settings (what they've unlocked)
householdsRouter.get('/:household_id/members-sharing', requireAuth, async (req, res) => {
  try {
    const { household_id } = req.params;
    const memberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, req.userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this family' });

    // Get all members' sharing settings
    const result = await pool.query(`
      SELECT
        hss.*,
        u.name as user_name, u.email as user_email,
        c.id as cat_id, c.name as category_name, c.slug as category_slug,
        c.icon as category_icon, c.color as category_color
      FROM household_sharing_settings hss
      JOIN users u ON u.id = hss.user_id
      LEFT JOIN categories c ON c.id = hss.category_id
      WHERE hss.household_id = $1
      ORDER BY hss.user_id, c.sort_order NULLS FIRST
    `, [household_id]);
    res.json({ settings: result.rows });
  } catch (err) {
    console.error('GET members-sharing error:', err.message);
    res.status(500).json({ error: 'Failed to fetch members sharing' });
  }
});

// GET /api/households/:id/unlocked-data/:member_user_id — fetch a member's unlocked category data
householdsRouter.get('/:household_id/unlocked-data/:member_user_id', requireAuth, async (req, res) => {
  try {
    const { household_id, member_user_id } = req.params;

    // Verify current user is a family member
    const myMemberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, req.userId]
    );
    if (myMemberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this family' });

    // Verify target member is also in family
    const theirMemberCheck = await pool.query(
      'SELECT 1 FROM household_members WHERE household_id = $1 AND user_id = $2',
      [household_id, member_user_id]
    );
    if (theirMemberCheck.rows.length === 0) return res.status(403).json({ error: 'Target user not in family' });

    // Cannot view own data via this endpoint
    if (parseInt(member_user_id) === req.userId) return res.status(400).json({ error: 'Use personal dashboard for own data' });

    // Get what they've unlocked
    const settings = await pool.query(`
      SELECT hss.category_id, hss.share_allocations, hss.share_transactions
      FROM household_sharing_settings hss
      WHERE hss.household_id = $1 AND hss.user_id = $2
        AND (hss.share_allocations = TRUE OR hss.share_transactions = TRUE)
    `, [household_id, member_user_id]);

    if (settings.rows.length === 0) return res.json({ categories: [], transactions: [] });

    const unlockedCategoryIds = settings.rows.filter(s => s.category_id !== null).map(s => s.category_id);
    const allUnlocked = settings.rows.some(s => s.category_id === null);
    const allocUnlocked = settings.rows.some(s => s.category_id === null && s.share_allocations);
    const txnsUnlocked = settings.rows.some(s => s.category_id === null && s.share_transactions);

    // Build category data
    let categoriesResult = { rows: [] };
    if (allUnlocked || unlockedCategoryIds.length > 0) {
      const catFilter = allUnlocked ? `TRUE` : `c.id = ANY($2)`;
      const catParams = allUnlocked ? [member_user_id] : [member_user_id, unlockedCategoryIds];
      categoriesResult = await pool.query(`
        WITH expense_by_category AS (
          SELECT category_id, SUM(amount) as spent
          FROM transactions
          WHERE user_id = $1 AND type = 'expense' AND (is_split = FALSE OR is_split IS NULL)
          GROUP BY category_id
          UNION ALL
          SELECT ta.category_id, SUM(ta.amount) as spent
          FROM transaction_allocations ta
          JOIN transactions t ON t.id = ta.transaction_id
          WHERE t.user_id = $1 AND t.type = 'expense' AND t.is_split = TRUE
          GROUP BY ta.category_id
        )
        SELECT
          c.id, c.name, c.slug, c.color, c.icon,
          COALESCE(SUM(ebc.spent), 0) as spent,
          COALESCE(ua.percentage, ac.percentage) as target_percentage
        FROM categories c
        JOIN allocation_config ac ON ac.category_id = c.id
        LEFT JOIN user_allocations ua ON ua.category_id = c.id AND ua.user_id = $1
        LEFT JOIN expense_by_category ebc ON ebc.category_id = c.id
        WHERE ${catFilter}
        GROUP BY c.id, c.name, c.slug, c.color, c.icon, ua.percentage, ac.percentage
        ORDER BY c.sort_order
      `, catParams);
    }

    // Build transactions if unlocked
    let transactionRows = [];
    if (txnsUnlocked || settings.rows.some(s => s.share_transactions && s.category_id !== null)) {
      const txnFilter = txnsUnlocked
        ? `t.user_id = $1`
        : `t.user_id = $1 AND t.category_id = ANY($2)`;
      const txnParams = txnsUnlocked ? [member_user_id] : [member_user_id, unlockedCategoryIds.filter(id => settings.rows.find(s => s.category_id === id && s.share_transactions))];
      const txnResult = await pool.query(`
        SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color
        FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        WHERE ${txnFilter}
        ORDER BY t.transaction_date DESC, t.created_at DESC
        LIMIT 20
      `, txnParams);
      transactionRows = txnResult.rows;
    }

    res.json({
      categories: categoriesResult.rows,
      transactions: transactionRows
    });
  } catch (err) {
    console.error('GET unlocked-data error:', err.message);
    res.status(500).json({ error: 'Failed to fetch unlocked data' });
  }
});

// ═══════════════════════════════════════════════════════════
// ─── SHARED family GOALS ──────────────────────────────
// ═══════════════════════════════════════════════════════════

// Helper: verify user is a family member, return role
async function getHouseholdMembership(householdId, userId) {
  const r = await pool.query(
    `SELECT hm.role, h.owner_id FROM household_members hm
     JOIN households h ON h.id = hm.household_id
     WHERE hm.household_id = $1 AND hm.user_id = $2`,
    [householdId, userId]
  );
  return r.rows[0] || null;
}

// Helper: calculate contribution total for a goal, returns { total_contributed, contributor_breakdown }
async function getGoalProgress(goalId) {
  const r = await pool.query(
    `SELECT gc.user_id, u.name as member_name, SUM(gc.amount) as contributed
     FROM goal_contributions gc
     JOIN users u ON u.id = gc.user_id
     WHERE gc.goal_id = $1
     GROUP BY gc.user_id, u.name
     ORDER BY contributed DESC`,
    [goalId]
  );
  const total = r.rows.reduce((s, row) => s + parseFloat(row.contributed), 0);
  return { total_contributed: total, contributors: r.rows };
}

// GET /api/households/:id/goals — list active + paused goals with progress
householdsRouter.get('/:id/goals', requireAuth, async (req, res) => {
  try {
    const { id: householdId } = req.params;
    const membership = await getHouseholdMembership(householdId, req.userId);
    if (!membership) return res.status(403).json({ error: 'Not a member of this family' });

    const goalsResult = await pool.query(
      `SELECT sg.*, u.name as created_by_name,
              COALESCE(SUM(gc.amount), 0) as total_contributed
       FROM shared_goals sg
       LEFT JOIN users u ON u.id = sg.created_by
       LEFT JOIN goal_contributions gc ON gc.goal_id = sg.id
       WHERE sg.household_id = $1 AND sg.status IN ('active', 'paused')
       GROUP BY sg.id, u.name
       ORDER BY sg.created_at ASC`,
      [householdId]
    );

    // For each goal, get contributor breakdown
    const goals = await Promise.all(goalsResult.rows.map(async (goal) => {
      const { contributors } = await getGoalProgress(goal.id);
      return { ...goal, contributors };
    }));

    res.json({ goals });
  } catch (err) {
    console.error('GET /api/households/:id/goals error:', err.message);
    res.status(500).json({ error: 'Failed to fetch goals' });
  }
});

// GET /api/households/:id/goals/achieved — list completed/archived goals
householdsRouter.get('/:id/goals/achieved', requireAuth, async (req, res) => {
  try {
    const { id: householdId } = req.params;
    const membership = await getHouseholdMembership(householdId, req.userId);
    if (!membership) return res.status(403).json({ error: 'Not a member of this family' });

    const goalsResult = await pool.query(
      `SELECT sg.*, u.name as created_by_name,
              COALESCE(SUM(gc.amount), 0) as total_contributed
       FROM shared_goals sg
       LEFT JOIN users u ON u.id = sg.created_by
       LEFT JOIN goal_contributions gc ON gc.goal_id = sg.id
       WHERE sg.household_id = $1 AND sg.status IN ('completed', 'archived')
       GROUP BY sg.id, u.name
       ORDER BY sg.completed_at DESC NULLS LAST`,
      [householdId]
    );

    res.json({ goals: goalsResult.rows });
  } catch (err) {
    console.error('GET /api/households/:id/goals/achieved error:', err.message);
    res.status(500).json({ error: 'Failed to fetch achieved goals' });
  }
});

// POST /api/households/:id/goals — create a new goal (any member can propose)
householdsRouter.post('/:id/goals', requireAuth, async (req, res) => {
  try {
    const { id: householdId } = req.params;
    const membership = await getHouseholdMembership(householdId, req.userId);
    if (!membership) return res.status(403).json({ error: 'Not a member of this family' });

    const { name, target_amount, target_date, category, emoji, description } = req.body;
    if (!name || !target_amount) return res.status(400).json({ error: 'name and target_amount are required' });
    if (parseFloat(target_amount) <= 0) return res.status(400).json({ error: 'target_amount must be positive' });

    const validCategories = ['vacation','emergency','car','home','education','wedding','baby','retirement','custom'];
    const cat = validCategories.includes(category) ? category : 'custom';
    const emojiVal = emoji || '🎯';

    const result = await pool.query(
      `INSERT INTO shared_goals (household_id, created_by, name, target_amount, target_date, category, emoji, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [householdId, req.userId, name, target_amount, target_date || null, cat, emojiVal, description || null]
    );

    res.json({ success: true, goal: result.rows[0] });
  } catch (err) {
    console.error('POST /api/households/:id/goals error:', err.message);
    res.status(500).json({ error: 'Failed to create goal' });
  }
});

// PUT /api/goals/:id — edit goal (owner only)
goalsRouter.put('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const goalCheck = await pool.query(
      `SELECT sg.*, h.owner_id FROM shared_goals sg
       JOIN households h ON h.id = sg.household_id
       WHERE sg.id = $1`,
      [id]
    );
    if (goalCheck.rows.length === 0) return res.status(404).json({ error: 'Goal not found' });
    const goal = goalCheck.rows[0];

    // Verify user is family owner or goal creator
    const membership = await getHouseholdMembership(goal.household_id, req.userId);
    if (!membership) return res.status(403).json({ error: 'Not a member of this family' });
    if (goal.owner_id !== req.userId && goal.created_by !== req.userId) {
      return res.status(403).json({ error: 'Only family owner or goal creator can edit goals' });
    }

    const { name, target_amount, target_date, category, emoji, description } = req.body;
    const validCategories = ['vacation','emergency','car','home','education','wedding','baby','retirement','custom'];
    const updates = [];
    const params = [];
    let pIdx = 1;
    if (name !== undefined) { updates.push(`name = $${pIdx++}`); params.push(name); }
    if (target_amount !== undefined) { updates.push(`target_amount = $${pIdx++}`); params.push(target_amount); }
    if (target_date !== undefined) { updates.push(`target_date = $${pIdx++}`); params.push(target_date || null); }
    if (category !== undefined && validCategories.includes(category)) { updates.push(`category = $${pIdx++}`); params.push(category); }
    if (emoji !== undefined) { updates.push(`emoji = $${pIdx++}`); params.push(emoji); }
    if (description !== undefined) { updates.push(`description = $${pIdx++}`); params.push(description); }
    updates.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE shared_goals SET ${updates.join(', ')} WHERE id = $${pIdx} RETURNING *`,
      params
    );
    res.json({ success: true, goal: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/goals/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update goal' });
  }
});

// POST /api/goals/:id/pause — toggle pause/resume (owner only)
goalsRouter.post('/:id/pause', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const goalCheck = await pool.query(
      `SELECT sg.*, h.owner_id FROM shared_goals sg
       JOIN households h ON h.id = sg.household_id
       WHERE sg.id = $1 AND sg.status IN ('active', 'paused')`,
      [id]
    );
    if (goalCheck.rows.length === 0) return res.status(404).json({ error: 'Goal not found or not active/paused' });
    const goal = goalCheck.rows[0];

    const membership = await getHouseholdMembership(goal.household_id, req.userId);
    if (!membership) return res.status(403).json({ error: 'Not a member of this family' });
    if (goal.owner_id !== req.userId) return res.status(403).json({ error: 'Only family owner can pause/resume goals' });

    const newStatus = goal.status === 'active' ? 'paused' : 'active';
    const result = await pool.query(
      'UPDATE shared_goals SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [newStatus, id]
    );
    res.json({ success: true, goal: result.rows[0] });
  } catch (err) {
    console.error('POST /api/goals/:id/pause error:', err.message);
    res.status(500).json({ error: 'Failed to toggle goal status' });
  }
});

// POST /api/goals/:id/complete — mark goal as completed/archived (owner only)
goalsRouter.post('/:id/complete', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const goalCheck = await pool.query(
      `SELECT sg.*, h.owner_id FROM shared_goals sg
       JOIN households h ON h.id = sg.household_id
       WHERE sg.id = $1 AND sg.status NOT IN ('completed', 'archived')`,
      [id]
    );
    if (goalCheck.rows.length === 0) return res.status(404).json({ error: 'Goal not found or already completed' });
    const goal = goalCheck.rows[0];

    const membership = await getHouseholdMembership(goal.household_id, req.userId);
    if (!membership) return res.status(403).json({ error: 'Not a member of this family' });
    if (goal.owner_id !== req.userId) return res.status(403).json({ error: 'Only family owner can complete goals' });

    const result = await pool.query(
      `UPDATE shared_goals SET status = 'completed', completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json({ success: true, goal: result.rows[0] });
  } catch (err) {
    console.error('POST /api/goals/:id/complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete goal' });
  }
});

// DELETE /api/goals/:id — delete goal (owner only)
goalsRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const goalCheck = await pool.query(
      `SELECT sg.*, h.owner_id FROM shared_goals sg
       JOIN households h ON h.id = sg.household_id
       WHERE sg.id = $1`,
      [id]
    );
    if (goalCheck.rows.length === 0) return res.status(404).json({ error: 'Goal not found' });
    const goal = goalCheck.rows[0];

    const membership = await getHouseholdMembership(goal.household_id, req.userId);
    if (!membership) return res.status(403).json({ error: 'Not a member of this family' });
    if (goal.owner_id !== req.userId) return res.status(403).json({ error: 'Only family owner can delete goals' });

    await pool.query('DELETE FROM shared_goals WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/goals/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete goal' });
  }
});

// POST /api/goals/:id/contribute — add a contribution (any member)
goalsRouter.post('/:id/contribute', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, note } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount must be positive' });

    const goalCheck = await pool.query(
      `SELECT sg.*, h.owner_id FROM shared_goals sg
       JOIN households h ON h.id = sg.household_id
       WHERE sg.id = $1 AND sg.status = 'active'`,
      [id]
    );
    if (goalCheck.rows.length === 0) return res.status(404).json({ error: 'Goal not found or not active' });
    const goal = goalCheck.rows[0];

    const membership = await getHouseholdMembership(goal.household_id, req.userId);
    if (!membership) return res.status(403).json({ error: 'Not a member of this family' });

    await pool.query(
      'INSERT INTO goal_contributions (goal_id, user_id, amount, note) VALUES ($1, $2, $3, $4)',
      [id, req.userId, amount, note || null]
    );

    // Check progress and milestone notifications
    const { total_contributed, contributors } = await getGoalProgress(id);
    const target = parseFloat(goal.target_amount);
    const pct = target > 0 ? (total_contributed / target) * 100 : 0;

    const milestones = [];
    if (pct >= 25 && !goal.milestone_25_notified) {
      await pool.query('UPDATE shared_goals SET milestone_25_notified = TRUE WHERE id = $1', [id]);
      milestones.push(25);
    }
    if (pct >= 50 && !goal.milestone_50_notified) {
      await pool.query('UPDATE shared_goals SET milestone_50_notified = TRUE WHERE id = $1', [id]);
      milestones.push(50);
    }
    if (pct >= 75 && !goal.milestone_75_notified) {
      await pool.query('UPDATE shared_goals SET milestone_75_notified = TRUE WHERE id = $1', [id]);
      milestones.push(75);
    }
    if (pct >= 100 && !goal.milestone_100_notified) {
      await pool.query('UPDATE shared_goals SET milestone_100_notified = TRUE WHERE id = $1', [id]);
      milestones.push(100);
    }

    res.json({
      success: true,
      total_contributed,
      percent: Math.min(pct, 100),
      contributors,
      milestones_reached: milestones
    });
  } catch (err) {
    console.error('POST /api/goals/:id/contribute error:', err.message);
    res.status(500).json({ error: 'Failed to add contribution' });
  }
});

// GET /api/goals/:id/contributions — contribution history with member info
goalsRouter.get('/:id/contributions', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const goalCheck = await pool.query(
      'SELECT sg.household_id FROM shared_goals sg WHERE sg.id = $1',
      [id]
    );
    if (goalCheck.rows.length === 0) return res.status(404).json({ error: 'Goal not found' });

    const membership = await getHouseholdMembership(goalCheck.rows[0].household_id, req.userId);
    if (!membership) return res.status(403).json({ error: 'Not a member of this family' });

    const result = await pool.query(
      `SELECT gc.*, u.name as member_name
       FROM goal_contributions gc
       JOIN users u ON u.id = gc.user_id
       WHERE gc.goal_id = $1
       ORDER BY gc.created_at DESC`,
      [id]
    );
    res.json({ contributions: result.rows });
  } catch (err) {
    console.error('GET /api/goals/:id/contributions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch contributions' });
  }
});

// PUT /api/goals/:id/member-target — set per-member monthly target (owner only)
goalsRouter.put('/:id/member-target', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { user_id, monthly_target } = req.body;

    const goalCheck = await pool.query(
      `SELECT sg.*, h.owner_id FROM shared_goals sg
       JOIN households h ON h.id = sg.household_id
       WHERE sg.id = $1`,
      [id]
    );
    if (goalCheck.rows.length === 0) return res.status(404).json({ error: 'Goal not found' });
    const goal = goalCheck.rows[0];

    if (goal.owner_id !== req.userId) return res.status(403).json({ error: 'Only family owner can set member targets' });

    await pool.query(
      `INSERT INTO goal_member_targets (goal_id, user_id, monthly_target)
       VALUES ($1, $2, $3)
       ON CONFLICT (goal_id, user_id) DO UPDATE SET monthly_target = $3, updated_at = NOW()`,
      [id, user_id, monthly_target]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/goals/:id/member-target error:', err.message);
    res.status(500).json({ error: 'Failed to set member target' });
  }
});

// ═══════════════════════════════════════════════════════════
// ─── SHARED BUDGETS ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════

// GET all shared budget categories with monthly spend + member breakdown
householdsRouter.get('/:id/shared-budgets', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { month, year } = req.query;
    const memberCheck = await pool.query(
      `SELECT hm.role FROM household_members hm WHERE hm.household_id = $1 AND hm.user_id = $2`,
      [id, req.userId]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this family' });

    const targetMonth = parseInt(month) || new Date().getMonth() + 1;
    const targetYear = parseInt(year) || new Date().getFullYear();

    const householdRow = await pool.query(`SELECT owner_id FROM households WHERE id = $1`, [id]);
    if (householdRow.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    const ownerId = householdRow.rows[0].owner_id;

    const result = await pool.query(`
      SELECT
        sbc.id,
        sbc.name,
        sbc.emoji,
        sbc.monthly_target,
        sbc.sort_order,
        sbc.created_by,
        COALESCE(
          (SELECT SUM(amount) FROM shared_budget_expenses
           WHERE budget_category_id = sbc.id
           AND EXTRACT(MONTH FROM expense_date) = $2
           AND EXTRACT(YEAR FROM expense_date) = $3), 0
        )::NUMERIC(12,2) as total_spent,
        (
          SELECT json_agg(member_data ORDER BY (member_data->>'name'))
          FROM (
            SELECT jsonb_build_object(
              'user_id', u.id,
              'name', u.name,
              'amount', COALESCE(
                (SELECT SUM(sbe.amount) FROM shared_budget_expenses sbe
                 WHERE sbe.budget_category_id = sbc.id
                 AND sbe.logged_by = u.id
                 AND EXTRACT(MONTH FROM sbe.expense_date) = $2
                 AND EXTRACT(YEAR FROM sbe.expense_date) = $3), 0
              ),
              'expected', COALESCE(
                (SELECT sbmt.expected_amount FROM shared_budget_member_targets sbmt
                 WHERE sbmt.budget_category_id = sbc.id AND sbmt.user_id = u.id), 0
              )
            ) as member_data
            FROM household_members hm2
            JOIN users u ON u.id = hm2.user_id
            WHERE hm2.household_id = sbc.household_id
          ) t
        ) as member_breakdown
      FROM shared_budget_categories sbc
      WHERE sbc.household_id = $1
      ORDER BY sbc.sort_order, sbc.created_at
    `, [id, targetMonth, targetYear]);

    res.json({ success: true, budgets: result.rows, month: targetMonth, year: targetYear, owner_id: ownerId });
  } catch (err) {
    console.error('GET /api/households/:id/shared-budgets error:', err.message);
    res.status(500).json({ error: 'Failed to load shared budgets' });
  }
});

// POST create a shared budget category (owner/co-admin only)
householdsRouter.post('/:id/shared-budgets', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, emoji, monthly_target } = req.body;
    if (!name || monthly_target == null) return res.status(400).json({ error: 'Name and monthly_target are required' });

    const householdRow = await pool.query(`SELECT owner_id FROM households WHERE id = $1`, [id]);
    if (householdRow.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    const memberRow = await pool.query(`SELECT role FROM household_members WHERE household_id = $1 AND user_id = $2`, [id, req.userId]);
    if (memberRow.rows.length === 0) return res.status(403).json({ error: 'Not a member' });
    const isOwner = householdRow.rows[0].owner_id === req.userId;
    const isCoAdmin = memberRow.rows[0].role === 'co_admin';
    if (!isOwner && !isCoAdmin) return res.status(403).json({ error: 'Only owner or co-admin can create budget categories' });

    const sortRow = await pool.query(`SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM shared_budget_categories WHERE household_id = $1`, [id]);
    const sortOrder = sortRow.rows[0].next_order;

    const result = await pool.query(
      `INSERT INTO shared_budget_categories (household_id, name, emoji, monthly_target, sort_order, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, name.trim(), emoji || '💰', parseFloat(monthly_target), sortOrder, req.userId]
    );
    res.json({ success: true, budget: result.rows[0] });
  } catch (err) {
    console.error('POST /api/households/:id/shared-budgets error:', err.message);
    res.status(500).json({ error: 'Failed to create shared budget category' });
  }
});

// POST seed default budget categories (owner only)
householdsRouter.post('/:id/shared-budgets/seed-defaults', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const householdRow = await pool.query(`SELECT owner_id FROM households WHERE id = $1`, [id]);
    if (householdRow.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    if (householdRow.rows[0].owner_id !== req.userId) return res.status(403).json({ error: 'Only family owner can seed defaults' });

    const defaults = [
      { name: 'Rent/Mortgage', emoji: '🏠', monthly_target: 0 },
      { name: 'Utilities', emoji: '⚡', monthly_target: 0 },
      { name: 'Groceries', emoji: '🛒', monthly_target: 0 },
      { name: 'Insurance', emoji: '🛡️', monthly_target: 0 },
      { name: 'family Supplies', emoji: '🧹', monthly_target: 0 },
      { name: 'Shared Savings', emoji: '💎', monthly_target: 0 },
    ];

    for (let i = 0; i < defaults.length; i++) {
      const d = defaults[i];
      await pool.query(
        `INSERT INTO shared_budget_categories (household_id, name, emoji, monthly_target, sort_order, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, d.name, d.emoji, d.monthly_target, i, req.userId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/households/:id/shared-budgets/seed-defaults error:', err.message);
    res.status(500).json({ error: 'Failed to seed defaults' });
  }
});

// PUT edit a shared budget category (owner/co-admin only)
householdsRouter.put('/:id/shared-budgets/:budgetId', requireAuth, async (req, res) => {
  try {
    const { id, budgetId } = req.params;
    const { name, emoji, monthly_target } = req.body;
    const householdRow = await pool.query(`SELECT owner_id FROM households WHERE id = $1`, [id]);
    if (householdRow.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    const memberRow = await pool.query(`SELECT role FROM household_members WHERE household_id = $1 AND user_id = $2`, [id, req.userId]);
    if (memberRow.rows.length === 0) return res.status(403).json({ error: 'Not a member' });
    const isOwner = householdRow.rows[0].owner_id === req.userId;
    const isCoAdmin = memberRow.rows[0].role === 'co_admin';
    if (!isOwner && !isCoAdmin) return res.status(403).json({ error: 'Only owner or co-admin can edit budget categories' });

    const result = await pool.query(
      `UPDATE shared_budget_categories
       SET name = COALESCE($1, name), emoji = COALESCE($2, emoji),
           monthly_target = COALESCE($3, monthly_target), updated_at = NOW()
       WHERE id = $4 AND household_id = $5 RETURNING *`,
      [name?.trim() || null, emoji || null, monthly_target != null ? parseFloat(monthly_target) : null, budgetId, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Budget category not found' });
    res.json({ success: true, budget: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/households/:id/shared-budgets/:budgetId error:', err.message);
    res.status(500).json({ error: 'Failed to update budget category' });
  }
});

// DELETE a shared budget category (owner/co-admin only)
householdsRouter.delete('/:id/shared-budgets/:budgetId', requireAuth, async (req, res) => {
  try {
    const { id, budgetId } = req.params;
    const householdRow = await pool.query(`SELECT owner_id FROM households WHERE id = $1`, [id]);
    if (householdRow.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    const memberRow = await pool.query(`SELECT role FROM household_members WHERE household_id = $1 AND user_id = $2`, [id, req.userId]);
    if (memberRow.rows.length === 0) return res.status(403).json({ error: 'Not a member' });
    const isOwner = householdRow.rows[0].owner_id === req.userId;
    const isCoAdmin = memberRow.rows[0].role === 'co_admin';
    if (!isOwner && !isCoAdmin) return res.status(403).json({ error: 'Only owner or co-admin can delete budget categories' });
    await pool.query(`DELETE FROM shared_budget_categories WHERE id = $1 AND household_id = $2`, [budgetId, id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/households/:id/shared-budgets/:budgetId error:', err.message);
    res.status(500).json({ error: 'Failed to delete budget category' });
  }
});

// POST log an expense against a shared budget category (any member)
householdsRouter.post('/:id/shared-budgets/:budgetId/expenses', requireAuth, async (req, res) => {
  try {
    const { id, budgetId } = req.params;
    const { amount, description, expense_date } = req.body;
    if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'Amount must be greater than 0' });

    const memberRow = await pool.query(`SELECT id FROM household_members WHERE household_id = $1 AND user_id = $2`, [id, req.userId]);
    if (memberRow.rows.length === 0) return res.status(403).json({ error: 'Not a member of this family' });

    const budgetRow = await pool.query(`SELECT id FROM shared_budget_categories WHERE id = $1 AND household_id = $2`, [budgetId, id]);
    if (budgetRow.rows.length === 0) return res.status(404).json({ error: 'Budget category not found' });

    const dateStr = expense_date || new Date().toISOString().split('T')[0];
    const result = await pool.query(
      `INSERT INTO shared_budget_expenses (budget_category_id, household_id, logged_by, amount, description, expense_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [budgetId, id, req.userId, parseFloat(amount), description?.trim() || null, dateStr]
    );
    res.json({ success: true, expense: result.rows[0] });
  } catch (err) {
    console.error('POST /api/households/:id/shared-budgets/:budgetId/expenses error:', err.message);
    res.status(500).json({ error: 'Failed to log shared expense' });
  }
});

// GET expense history for a shared budget category (any member)
householdsRouter.get('/:id/shared-budgets/:budgetId/expenses', requireAuth, async (req, res) => {
  try {
    const { id, budgetId } = req.params;
    const { month, year } = req.query;
    const memberRow = await pool.query(`SELECT id FROM household_members WHERE household_id = $1 AND user_id = $2`, [id, req.userId]);
    if (memberRow.rows.length === 0) return res.status(403).json({ error: 'Not a member' });

    const targetMonth = parseInt(month) || new Date().getMonth() + 1;
    const targetYear = parseInt(year) || new Date().getFullYear();

    const result = await pool.query(`
      SELECT sbe.id, sbe.amount, sbe.description, sbe.expense_date, sbe.created_at,
             sbe.logged_by, u.name as member_name
      FROM shared_budget_expenses sbe
      JOIN users u ON u.id = sbe.logged_by
      WHERE sbe.budget_category_id = $1 AND sbe.household_id = $2
        AND EXTRACT(MONTH FROM sbe.expense_date) = $3
        AND EXTRACT(YEAR FROM sbe.expense_date) = $4
      ORDER BY sbe.expense_date DESC, sbe.created_at DESC
      LIMIT 100
    `, [budgetId, id, targetMonth, targetYear]);

    res.json({ success: true, expenses: result.rows });
  } catch (err) {
    console.error('GET /api/households/:id/shared-budgets/:budgetId/expenses error:', err.message);
    res.status(500).json({ error: 'Failed to load expenses' });
  }
});

// DELETE a shared budget expense (logged_by or family owner)
sharedBudgetExpensesRouter.delete('/:expenseId', requireAuth, async (req, res) => {
  try {
    const { expenseId } = req.params;
    const expRow = await pool.query(
      `SELECT sbe.*, h.owner_id FROM shared_budget_expenses sbe
       JOIN households h ON h.id = sbe.household_id
       WHERE sbe.id = $1`,
      [expenseId]
    );
    if (expRow.rows.length === 0) return res.status(404).json({ error: 'Expense not found' });
    const exp = expRow.rows[0];
    if (exp.logged_by !== req.userId && exp.owner_id !== req.userId) {
      return res.status(403).json({ error: 'Can only delete your own expenses (or be the family owner)' });
    }
    await pool.query(`DELETE FROM shared_budget_expenses WHERE id = $1`, [expenseId]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/shared-budget-expenses/:expenseId error:', err.message);
    res.status(500).json({ error: 'Failed to delete expense' });
  }
});

// PUT set per-member contribution targets for a budget category (owner/co-admin)
householdsRouter.put('/:id/shared-budgets/:budgetId/member-targets', requireAuth, async (req, res) => {
  try {
    const { id, budgetId } = req.params;
    const { targets } = req.body; // Array of { user_id, expected_amount }
    if (!Array.isArray(targets)) return res.status(400).json({ error: 'targets must be an array' });

    const householdRow = await pool.query(`SELECT owner_id FROM households WHERE id = $1`, [id]);
    if (householdRow.rows.length === 0) return res.status(404).json({ error: 'family not found' });
    const memberRow = await pool.query(`SELECT role FROM household_members WHERE household_id = $1 AND user_id = $2`, [id, req.userId]);
    if (memberRow.rows.length === 0) return res.status(403).json({ error: 'Not a member' });
    const isOwner = householdRow.rows[0].owner_id === req.userId;
    const isCoAdmin = memberRow.rows[0].role === 'co_admin';
    if (!isOwner && !isCoAdmin) return res.status(403).json({ error: 'Only owner or co-admin can set member targets' });

    for (const t of targets) {
      if (parseFloat(t.expected_amount) > 0) {
        await pool.query(
          `INSERT INTO shared_budget_member_targets (budget_category_id, user_id, expected_amount)
           VALUES ($1, $2, $3)
           ON CONFLICT (budget_category_id, user_id) DO UPDATE SET expected_amount = $3, updated_at = NOW()`,
          [budgetId, t.user_id, parseFloat(t.expected_amount)]
        );
      } else {
        await pool.query(`DELETE FROM shared_budget_member_targets WHERE budget_category_id = $1 AND user_id = $2`, [budgetId, t.user_id]);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('PUT /api/households/:id/shared-budgets/:budgetId/member-targets error:', err.message);
    res.status(500).json({ error: 'Failed to set member targets' });
  }
});

module.exports = {
  householdsRouter,
  familyInviteRouter,
  goalsRouter,
  sharedBudgetExpensesRouter,
  bindFamilyRuntime
};
