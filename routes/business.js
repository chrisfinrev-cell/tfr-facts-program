'use strict';

/**
 * Business Pro: 5-Bucket protocol, burn rate, Friday sweeps, heartbeat.
 * Mount: app.use('/api/business-pro', router)
 * (bare /api/business would break existing clients)
 */

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');

const router = express.Router();

// ─── Business Pro Onboarding Endpoints ───────────────────────────────────────
//
// Path Selection (mandatory for business_core / business_bundle users on first login):
//   PATH_TYPE: A (Side-Hustle), B (Full-Timer), C (Funded Baby), D (Legacy Pivot)
//   SURVIVAL_BURN: business fixed costs + personal necessities (B) OR + debt service (A/C/D)
//   SOVEREIGNTY_FLOOR: SURVIVAL_BURN × 6
//
// 5-Bucket Protocol (bank confirmation gate):
//   Bucket 1: Clearing (Checking) — all revenue intake
//   Bucket 2: Tax Shield (HYSA/MM) — 25% allocation
//   Bucket 3: Operating Reserve (HYSA/MM) — safety until SOVEREIGNTY_FLOOR met
//   Bucket 4: Growth & Innovation (HYSA/MM) — 15% marketing / 10% R&D
//   Bucket 5: Wealth Bridge (Checking) — sweep point for brokerage transfers
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/business-pro/onboarding — Return current onboarding status
router.get('/onboarding', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT pricing_tier, business_path_type, survival_burn_cents, bucket_cert_completed, bucket_cert_confirmed_at FROM users WHERE id = $1',
      [req.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const user = result.rows[0];

    // Only business tier users need this onboarding
    const isBusiness = user.pricing_tier === 'business_core' || user.pricing_tier === 'business_bundle';
    const sovereigntyFloor = user.survival_burn_cents
      ? user.survival_burn_cents * 6
      : null;

    res.json({
      success: true,
      is_business_tier: isBusiness,
      onboarding_required: isBusiness && (!user.business_path_type || !user.bucket_cert_completed),
      path_selection_done: !!user.business_path_type,
      bucket_cert_done: user.bucket_cert_completed || false,
      business_path_type: user.business_path_type || null,
      survival_burn_cents: user.survival_burn_cents || null,
      sovereignty_floor_cents: sovereigntyFloor,
      bucket_cert_confirmed_at: user.bucket_cert_confirmed_at || null
    });
  } catch (err) {
    console.error('[BusinessPro] GET onboarding error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch onboarding status.' });
  }
});

// POST /api/business-pro/onboarding — Save path type + survival burn
// Body: { path_type: 'A'|'B'|'C'|'D', survival_burn_cents: number }
router.post('/onboarding', requireAuth, async (req, res) => {
  try {
    const { path_type, survival_burn_cents } = req.body;

    // Validate
    if (!['A','B','C','D'].includes(path_type)) {
      return res.status(400).json({ success: false, message: 'Invalid path_type. Must be A, B, C, or D.' });
    }
    if (!Number.isInteger(survival_burn_cents) || survival_burn_cents < 0) {
      return res.status(400).json({ success: false, message: 'survival_burn_cents must be a non-negative integer.' });
    }

    // Verify user is on Business tier
    const check = await pool.query('SELECT pricing_tier FROM users WHERE id = $1', [req.userId]);
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    // Allow access for creators and business tier
    const pt = check.rows[0].pricing_tier;
    if (!['business_core', 'business_bundle'].includes(pt) && !check.rows[0].is_creator) {
      return res.status(403).json({ success: false, message: 'Business onboarding is only available on the Business Core or Full Business Bundle plan.' });
    }

    await pool.query(
      'UPDATE users SET business_path_type = $1, survival_burn_cents = $2 WHERE id = $3',
      [path_type, survival_burn_cents, req.userId]
    );

    const sovereigntyFloor = survival_burn_cents * 6;

    res.json({
      success: true,
      message: 'Path selection saved.',
      business_path_type: path_type,
      survival_burn_cents,
      sovereignty_floor_cents: sovereigntyFloor
    });
  } catch (err) {
    console.error('[BusinessPro] POST onboarding error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to save onboarding data.' });
  }
});

// POST /api/business-pro/bucket-cert — Mark bucket certification complete
// Body: { confirmed: true }
router.post('/bucket-cert', requireAuth, async (req, res) => {
  try {
    const { confirmed } = req.body;
    if (!confirmed) {
      return res.status(400).json({ success: false, message: 'confirmed must be true.' });
    }

    // Must have completed path selection first
    const check = await pool.query(
      'SELECT pricing_tier, business_path_type FROM users WHERE id = $1',
      [req.userId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    if (!check.rows[0].business_path_type) {
      return res.status(400).json({ success: false, message: 'Complete path selection before bucket certification.' });
    }

    await pool.query(
      'UPDATE users SET bucket_cert_completed = TRUE, bucket_cert_confirmed_at = NOW() WHERE id = $1',
      [req.userId]
    );

    res.json({
      success: true,
      message: '5-Bucket Protocol certified. Welcome, Financial Architect.',
      bucket_cert_completed: true,
      bucket_cert_confirmed_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[BusinessPro] POST bucket-cert error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to confirm bucket certification.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ─── BUSINESS PRO LOGIC ENGINE ────────────────────────────────────────────
//   Friday Sweep, Heartbeat Audit, Wealth Bridge
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/business-pro/dashboard — summary data for Business Pro command center
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pricing_tier, business_path_type, survival_burn_cents, bucket_cert_completed,
              bucket3_balance_cents, bucket3_updated_at,
              heartbeat_in_truth, heartbeat_consecutive_passes
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    const u = result.rows[0];
    const sovereigntyFloor = u.survival_burn_cents ? u.survival_burn_cents * 6 : 0;
    const bucket3          = u.bucket3_balance_cents || 0;
    const floorMet         = bucket3 >= sovereigntyFloor && sovereigntyFloor > 0;

    res.json({
      success: true,
      business_path_type:          u.business_path_type || null,
      survival_burn_cents:         u.survival_burn_cents || 0,
      sovereignty_floor_cents:     sovereigntyFloor,
      bucket3_balance_cents:       bucket3,
      bucket3_updated_at:          u.bucket3_updated_at || null,
      bucket_cert_completed:       u.bucket_cert_completed || false,
      heartbeat_in_truth:          u.heartbeat_in_truth !== false,
      heartbeat_consecutive_passes: u.heartbeat_consecutive_passes || 0,
      wealth_bridge_unlocked:      floorMet,
      vesting_complete:            (u.heartbeat_consecutive_passes || 0) >= 3
    });
  } catch (err) {
    console.error('[BusinessPro] dashboard error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load dashboard.' });
  }
});

// POST /api/business-pro/sweep — Record a Friday Sweep allocation
// Body: { gross_revenue_cents: number, bucket3_balance_cents: number, notes?: string }
router.post('/sweep', requireAuth, async (req, res) => {
  try {
    const { gross_revenue_cents, bucket3_balance_cents, notes } = req.body;

    if (!Number.isInteger(gross_revenue_cents) || gross_revenue_cents <= 0) {
      return res.status(400).json({ success: false, message: 'gross_revenue_cents must be a positive integer.' });
    }
    if (!Number.isInteger(bucket3_balance_cents) || bucket3_balance_cents < 0) {
      return res.status(400).json({ success: false, message: 'bucket3_balance_cents must be a non-negative integer.' });
    }

    // Verify user is on business tier and has completed onboarding
    const uRes = await pool.query(
      'SELECT pricing_tier, survival_burn_cents, bucket_cert_completed FROM users WHERE id = $1',
      [req.userId]
    );
    if (!uRes.rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    const user = uRes.rows[0];
    if (!['business_core', 'business_bundle'].includes(user.pricing_tier)) {
      return res.status(403).json({ success: false, message: 'Business plan required.' });
    }

    const sovereigntyFloor = (user.survival_burn_cents || 0) * 6;

    // ── Friday Sweep Allocation Math ────────────────────────────────────────
    const gross          = gross_revenue_cents;
    const taxShield      = Math.round(gross * 0.25);   // 25% → Bucket 2
    const growth         = Math.round(gross * 0.15);   // 15% → Bucket 4 (marketing)
    const innovation     = Math.round(gross * 0.10);   // 10% → Bucket 4 (R&D)
    const reserveFill    = gross - taxShield - growth - innovation; // Remaining 50%

    // Route Reserve Fill based on Bucket 3 vs SOVEREIGNTY_FLOOR
    const destination = (bucket3_balance_cents < sovereigntyFloor || sovereigntyFloor === 0)
      ? 'operating_reserve'
      : 'wealth_bridge';

    // Save the sweep
    const sweepRes = await pool.query(
      `INSERT INTO business_pro_sweeps
         (user_id, sweep_date, gross_revenue_cents, bucket3_balance_cents,
          tax_shield_cents, growth_cents, innovation_cents, reserve_fill_cents,
          reserve_destination, notes)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.userId, gross, bucket3_balance_cents,
       taxShield, growth, innovation, reserveFill, destination, notes || null]
    );

    // Update user's bucket3 balance snapshot
    const newBucket3 = destination === 'operating_reserve'
      ? bucket3_balance_cents + reserveFill
      : bucket3_balance_cents;

    await pool.query(
      'UPDATE users SET bucket3_balance_cents = $1, bucket3_updated_at = NOW() WHERE id = $2',
      [newBucket3, req.userId]
    );

    const floorMet = newBucket3 >= sovereigntyFloor && sovereigntyFloor > 0;

    res.json({
      success: true,
      sweep: sweepRes.rows[0],
      allocation: {
        gross_revenue_cents: gross,
        tax_shield_cents:    taxShield,
        growth_cents:        growth,
        innovation_cents:    innovation,
        reserve_fill_cents:  reserveFill,
        reserve_destination: destination
      },
      sovereignty_floor_cents:  sovereigntyFloor,
      bucket3_balance_cents:    newBucket3,
      wealth_bridge_unlocked:   floorMet
    });
  } catch (err) {
    console.error('[BusinessPro] sweep error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to record sweep.' });
  }
});

// GET /api/business-pro/sweeps — List recent Friday Sweeps
router.get('/sweeps', requireAuth, async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const rows = await pool.query(
      `SELECT * FROM business_pro_sweeps
       WHERE user_id = $1
       ORDER BY sweep_date DESC, created_at DESC
       LIMIT $2`,
      [req.userId, Math.min(parseInt(limit) || 10, 50)]
    );
    res.json({ success: true, sweeps: rows.rows });
  } catch (err) {
    console.error('[BusinessPro] sweeps list error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load sweeps.' });
  }
});

// GET /api/business-pro/heartbeat/status — Get current Business Pro heartbeat status
router.get('/heartbeat/status', requireAuth, async (req, res) => {
  try {
    const uRes = await pool.query(
      `SELECT heartbeat_in_truth, heartbeat_consecutive_passes FROM users WHERE id = $1`,
      [req.userId]
    );
    if (!uRes.rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    const u = uRes.rows[0];

    // Determine audit window (1st-7th of current month)
    const now      = new Date();
    const dayOfMonth = now.getDate();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const withinWindow = dayOfMonth >= 1 && dayOfMonth <= 7;
    const daysLeft = Math.max(0, 7 - dayOfMonth + 1);

    // Month label for this audit
    const monthLabel = monthStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // Check if already completed this month
    const existingCheck = await pool.query(
      `SELECT id, in_truth, bank_balance_cents, ledger_balance_cents, variance_cents, created_at
       FROM business_pro_heartbeats
       WHERE user_id = $1 AND audit_month = $2`,
      [req.userId, monthStart.toISOString().split('T')[0]]
    );
    const completed = existingCheck.rows.length > 0;
    const thisMonthAudit = completed ? existingCheck.rows[0] : null;

    res.json({
      success: true,
      monthLabel,
      withinWindow,
      daysLeft,
      completed,
      audit: thisMonthAudit,
      heartbeat_in_truth:           u.heartbeat_in_truth !== false,
      heartbeat_consecutive_passes: u.heartbeat_consecutive_passes || 0,
      vesting_complete:             (u.heartbeat_consecutive_passes || 0) >= 3,
      commissionsOnHold:            u.heartbeat_in_truth === false
    });
  } catch (err) {
    console.error('[BusinessPro] heartbeat status error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to load heartbeat status.' });
  }
});

// POST /api/business-pro/heartbeat — Submit Business Pro monthly heartbeat audit
// Body: { bank_balance_cents: number, ledger_balance_cents: number, signer_name: string }
router.post('/heartbeat', requireAuth, async (req, res) => {
  try {
    const { bank_balance_cents, ledger_balance_cents, signer_name } = req.body;

    if (!Number.isInteger(bank_balance_cents)) {
      return res.status(400).json({ success: false, message: 'bank_balance_cents must be an integer.' });
    }
    if (!Number.isInteger(ledger_balance_cents)) {
      return res.status(400).json({ success: false, message: 'ledger_balance_cents must be an integer.' });
    }
    if (!signer_name || signer_name.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'signer_name required.' });
    }

    // Verify Business Pro tier
    const uRes = await pool.query(
      'SELECT pricing_tier, heartbeat_consecutive_passes FROM users WHERE id = $1',
      [req.userId]
    );
    if (!uRes.rows.length) return res.status(404).json({ success: false, message: 'User not found.' });
    if (!['business_core', 'business_bundle'].includes(uRes.rows[0].pricing_tier)) {
      return res.status(403).json({ success: false, message: 'Business plan required.' });
    }

    // Determine audit month
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const dayOfMonth = now.getDate();

    // Enforce window: 1st-7th only
    if (dayOfMonth < 1 || dayOfMonth > 7) {
      return res.status(400).json({ success: false, message: 'Heartbeat Audit window is the 1st–7th of each month.' });
    }

    // Check if already completed this month
    const existing = await pool.query(
      'SELECT id FROM business_pro_heartbeats WHERE user_id = $1 AND audit_month = $2',
      [req.userId, monthStart.toISOString().split('T')[0]]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'Heartbeat already completed for this month.' });
    }

    // Determine "In Truth" status
    // Tolerance: within 1% or $50 (500 cents), whichever is greater
    const variance = Math.abs(bank_balance_cents - ledger_balance_cents);
    const tolerance = Math.max(500, Math.round(Math.abs(ledger_balance_cents) * 0.01));
    const inTruth = variance <= tolerance;

    // Insert heartbeat record
    const hbRes = await pool.query(
      `INSERT INTO business_pro_heartbeats
         (user_id, audit_month, bank_balance_cents, ledger_balance_cents,
          variance_cents, in_truth, signer_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.userId, monthStart.toISOString().split('T')[0],
       bank_balance_cents, ledger_balance_cents, variance, inTruth,
       signer_name.trim()]
    );

    // Update user's consecutive passes and in_truth status
    const prevPasses = uRes.rows[0].heartbeat_consecutive_passes || 0;
    const newPasses  = inTruth ? prevPasses + 1 : 0;
    await pool.query(
      `UPDATE users
       SET heartbeat_in_truth = $1, heartbeat_consecutive_passes = $2
       WHERE id = $3`,
      [inTruth, newPasses, req.userId]
    );

    res.json({
      success: true,
      audit: hbRes.rows[0],
      in_truth: inTruth,
      heartbeat_consecutive_passes: newPasses,
      vesting_complete: newPasses >= 3,
      message: inTruth
        ? `In Truth ✓ — ${newPasses} of 3 consecutive pass${newPasses !== 1 ? 'es' : ''} recorded.`
        : 'Out of Truth — commissions frozen until 3 consecutive passes achieved.'
    });
  } catch (err) {
    console.error('[BusinessPro] heartbeat submit error:', err.message);
    res.status(500).json({ success: false, message: 'Failed to submit heartbeat.' });
  }
});

module.exports = { router };
