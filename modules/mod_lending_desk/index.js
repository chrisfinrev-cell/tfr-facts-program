/**
 * mod_lending_desk — Sovereign Lending System (EDUCATIONAL / SIMULATION ONLY)
 *
 * Add-on: $29/mo for Elite, included in Business/Sovereignty
 *
 * REGULATORY POSTURE:
 *   - Passive deterministic math on user-entered pod notes — NOT loan origination.
 *   - No bank disbursements, ACH, escrow, or P2P user-to-user loan matching.
 *   - "Underwriting" / "max_borrow" fields are educational model labels only —
 *     never a credit decision or offer to lend.
 *   - Pod "sweep" updates local educational ledgers only; no funds move.
 *
 * Features:
 *   - Sovereign Health Score (shared with mod_legacy_lens)
 *   - Scorecard API (educational behavioral model, no external credit data)
 *   - 9-Pod Architecture (isolated educational lending note pools)
 *   - 70/30 Sweep Logic (Growth vs Legacy split — simulation)
 *   - Infinite Return Override (net_exposure ≤ 0 — model state)
 *   - Settlement Layer (local ledger logging only)
 *   - Automation Mode Indicators (Manual / Sync / Live — UI mode labels)
 *   - Notification Triggers (Leak Alert, Velocity Check, Zero-Hour)
 *
 * Schema: mod_lending_desk (pods, sweep_log, notifications_log)
 *
 * Routes (mounted at /api/mod_lending_desk):
 *   GET  /health
 *   GET  /status
 *   GET  /scorecard          — full health scorecard (also at /api/lending/scorecard)
 *   GET  /underwriting       — educational eligibility model
 *   GET  /pods               — list all 9 pods
 *   POST /pods               — activate a pod
 *   GET  /pods/:id           — single pod detail
 *   PATCH /pods/:id          — update pod
 *   POST /pods/:id/sweep     — apply 70/30 educational sweep math to a pod
 *   GET  /sweeps             — sweep history
 *   GET  /notifications/check — check and fire pending notifications
 *   GET  /infinite-return    — infinite return status + routing selector
 *   POST /infinite-return/route — set routing for infinite return cash flow
 *
 * © T-Dagsis LLC. All rights reserved.
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const { asyncRoute } = require('../../module-error-boundary');
const { checkModuleAccess, computeHealthScore, normalizeTier, tierRank } = require('../mod_legacy_lens/health-score');
const { withManualExecutionNotice } = require('../shared/edu-compliance');
const {
  buildAprSummaryBox,
  validateAprSummaryBox,
  buildDocumentManifest,
  ensureTilSchema,
  persistAprBox,
  persistDocuments,
  persistAcknowledgment,
  HARD_STOP_TYPE
} = require('../shared/truth-in-lending');

// ─── DB Pool (lazy-init) ─────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

// ─── Auth helper ─────────────────────────────────────────────────────────────
function requireAuth(req, res) {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  return true;
}

// ─── Get user row ─────────────────────────────────────────────────────────────
async function getUser(userId, pool) {
  const { rows } = await pool.query(
    `SELECT id, email, first_name, last_name, pricing_tier, subscription_tier, plan
     FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// ─── Ensure user has 9 pods ───────────────────────────────────────────────────
async function ensureUserPods(userId, pool) {
  for (let i = 1; i <= 9; i++) {
    await pool.query(
      `INSERT INTO mod_lending_desk.pods (user_id, pod_number, status)
       VALUES ($1, $2, 'empty')
       ON CONFLICT (user_id, pod_number) DO NOTHING`,
      [userId, i]
    );
  }
}

// ─── Automation mode for user ─────────────────────────────────────────────────
function getAutomationMode(tier) {
  if (tierRank(tier) >= tierRank('sovereignty')) return 'live';
  if (tierRank(tier) >= tierRank('business')) return 'sync';
  return 'manual';
}

// ─── Routes ───────────────────────────────────────────────────────────────────
const router = express.Router();

// Health check
router.get('/health', asyncRoute(async (req, res) => {
  const pool = getPool();
  try {
    await pool.query('SELECT 1 FROM mod_lending_desk.pods LIMIT 1');
    res.json({ status: 'ok', module: 'mod_lending_desk', version: '1.0.0' });
  } catch (e) {
    res.status(503).json({ status: 'degraded', error: e.message });
  }
}));

// ─── Status / gating check ────────────────────────────────────────────────────
router.get('/status', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  const tier = normalizeTier(user.pricing_tier || user.subscription_tier);
  const automationMode = getAutomationMode(tier);

  res.json({
    module: 'lending_desk',
    ...access,
    user_tier: tier,
    automation_mode: automationMode
  });
}));

// ─── Scorecard API ────────────────────────────────────────────────────────────
// Compatible with /api/lending/scorecard per spec
router.get('/scorecard', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  if (!access.allowed) {
    // Preview: return blurred scorecard
    const score = await computeHealthScore(req.session.userId, pool);
    return res.status(423).json({
      locked: true,
      reason: access.reason,
      price_cents: access.price_cents,
      tier: access.tier,
      preview: {
        composite_score: score.composite_score,
        sovereignty_level: score.sovereignty_level
      }
    });
  }

  const score = await computeHealthScore(req.session.userId, pool);

  res.json({
    necessities_index:  score.necessities_index.score,
    reserve_index:      score.reserve_index.score,
    growth_index:       score.growth_index.score,
    composite_score:    score.composite_score,
    streak_multiplier:  score.streak_multiplier,
    sovereignty_level:  score.sovereignty_level,
    // Full pillar details
    pillars:            score,
    computed_at:        score.computed_at
  });
}));

// ─── Behavioral Underwriting ──────────────────────────────────────────────────
router.get('/underwriting', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  if (!access.allowed) {
    return res.status(423).json({ locked: true, reason: access.reason, price_cents: access.price_cents });
  }

  const score = await computeHealthScore(req.session.userId, pool);
  const reserveIndex = score.reserve_index.score;
  const compositeScore = score.composite_score;
  const streakMultiplier = score.streak_multiplier;

  // Reserve floor: if Reserve Index < 30 → pause lending eligibility
  const reservePaused = reserveIndex < 30;

  // Educational modeled ceiling from streak (illustrative only — NOT a loan offer)
  const { rows: wallet } = await pool.query(
    `SELECT streak_count FROM mod_rewards.user_wallet WHERE user_id = $1`,
    [req.session.userId]
  );
  const streak = wallet[0]?.streak_count || 0;
  const baseLimitCents = 100000; // $1,000 illustrative
  const streakBonusCents = streak * 10000; // +$100 per week streak (model)
  const maxLimitCents = Math.min(baseLimitCents + streakBonusCents, 500000); // cap at $5,000 model

  // Educational eligibility labels (NOT underwriting approval to borrow)
  let eligibilityStatus, eligibilityReason;
  if (reservePaused) {
    eligibilityStatus = 'paused';
    eligibilityReason = 'Educational model: Reserve Index below 30 — build Reserve Shield concepts first';
  } else if (compositeScore < 20) {
    eligibilityStatus = 'ineligible';
    eligibilityReason = 'Educational model: Sovereign Health Score below illustrative threshold (20+)';
  } else {
    eligibilityStatus = 'eligible';
    eligibilityReason = 'Educational model: score thresholds met for simulation — not a loan approval';
  }

  res.json({
    eligibility_status: eligibilityStatus,
    eligibility_reason: eligibilityReason,
    // Renamed conceptually: modeled educational ceiling, not a borrow authorization
    max_borrow_cents: eligibilityStatus === 'eligible' ? maxLimitCents : 0,
    modeled_educational_ceiling_cents: eligibilityStatus === 'eligible' ? maxLimitCents : 0,
    loan_offer: false,
    simulation_only: true,
    reserve_paused: reservePaused,
    reserve_index: reserveIndex,
    composite_score: compositeScore,
    streak_weeks: streak,
    streak_multiplier: streakMultiplier,
    note: 'Educational simulation only. FACTS is not a lender. No funds are offered, originated, or transmitted. No external credit data used — score is a literacy model only.'
  });
}));

// ─── 9-Pod Architecture ───────────────────────────────────────────────────────

router.get('/pods', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  if (!access.allowed) {
    return res.status(423).json({ locked: true, reason: access.reason, price_cents: access.price_cents });
  }

  await ensureUserPods(req.session.userId, pool);

  const { rows: pods } = await pool.query(
    `SELECT p.*,
       COALESCE(
         (SELECT SUM(total_amount_cents) FROM mod_lending_desk.sweep_log WHERE pod_id = p.id),
         0
       ) AS total_swept_cents
     FROM mod_lending_desk.pods p
     WHERE p.user_id = $1
     ORDER BY p.pod_number`,
    [req.session.userId]
  );

  const tier = normalizeTier(user.pricing_tier || user.subscription_tier);
  const automationMode = getAutomationMode(tier);

  // Net exposure = sum of all outstanding
  const netExposureCents = pods.reduce((sum, p) => sum + (parseInt(p.outstanding_cents) || 0), 0);
  const isInfiniteReturn = netExposureCents <= 0;

  res.json({
    pods,
    net_exposure_cents: netExposureCents,
    is_infinite_return: isInfiniteReturn,
    automation_mode: automationMode,
    total_pods: 9,
    active_pods: pods.filter(p => p.status === 'active').length,
    at_risk_pods: pods.filter(p => p.status === 'at_risk').length
  });
}));

router.get('/pods/:id', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  if (!access.allowed) return res.status(423).json({ locked: true });

  const { rows: pods } = await pool.query(
    `SELECT p.*,
       json_agg(
         json_build_object(
           'id', sl.id,
           'total_amount_cents', sl.total_amount_cents,
           'growth_portion_cents', sl.growth_portion_cents,
           'legacy_portion_cents', sl.legacy_portion_cents,
           'is_infinite_return', sl.is_infinite_return,
           'created_at', sl.created_at
         ) ORDER BY sl.created_at DESC
       ) FILTER (WHERE sl.id IS NOT NULL) AS sweep_history
     FROM mod_lending_desk.pods p
     LEFT JOIN mod_lending_desk.sweep_log sl ON sl.pod_id = p.id
     WHERE p.id = $1 AND p.user_id = $2
     GROUP BY p.id`,
    [parseInt(req.params.id), req.session.userId]
  );

  if (!pods[0]) return res.status(404).json({ error: 'Pod not found' });
  res.json(pods[0]);
}));

router.post('/pods', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  if (!access.allowed) return res.status(423).json({ locked: true, reason: access.reason });

  await ensureUserPods(req.session.userId, pool);

  const {
    pod_number, label, principal_cents, interest_rate_bps,
    collateral_description, collateral_value_cents, notes
  } = req.body;

  if (!pod_number || pod_number < 1 || pod_number > 9) {
    return res.status(400).json({ error: 'pod_number must be 1-9' });
  }

  // Check underwriting before activation
  const score = await computeHealthScore(req.session.userId, pool);
  if (score.reserve_index.score < 30) {
    return res.status(400).json({
      error: 'Lending paused: Reserve Index below 30',
      reserve_index: score.reserve_index.score
    });
  }

  const { rows } = await pool.query(
    `UPDATE mod_lending_desk.pods
     SET label                  = COALESCE($1, label),
         status                 = 'active',
         principal_cents        = COALESCE($2, 0),
         outstanding_cents      = COALESCE($2, 0),
         interest_rate_bps      = COALESCE($3, 0),
         collateral_description = COALESCE($4, collateral_description),
         collateral_value_cents = COALESCE($5, 0),
         notes                  = COALESCE($6, notes),
         opened_at              = COALESCE(opened_at, NOW()),
         updated_at             = NOW()
     WHERE pod_number = $7 AND user_id = $8
     RETURNING *`,
    [
      label || null,
      principal_cents ? parseInt(principal_cents) : null,
      interest_rate_bps ? parseInt(interest_rate_bps) : null,
      collateral_description || null,
      collateral_value_cents ? parseInt(collateral_value_cents) : null,
      notes || null,
      parseInt(pod_number),
      req.session.userId
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Pod not found' });
  res.status(201).json(rows[0]);
}));

router.patch('/pods/:id', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  if (!access.allowed) return res.status(423).json({ locked: true });

  const VALID_STATUSES = ['empty', 'active', 'at_risk', 'defaulted', 'completed'];
  const { status, label, outstanding_cents, notes } = req.body;

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Must be: ' + VALID_STATUSES.join(', ') });
  }

  const { rows } = await pool.query(
    `UPDATE mod_lending_desk.pods
     SET status             = COALESCE($1, status),
         label              = COALESCE($2, label),
         outstanding_cents  = COALESCE($3, outstanding_cents),
         notes              = COALESCE($4, notes),
         closed_at          = CASE WHEN $1 IN ('completed','defaulted') THEN NOW() ELSE closed_at END,
         updated_at         = NOW()
     WHERE id = $5 AND user_id = $6
     RETURNING *`,
    [
      status || null,
      label !== undefined ? label : null,
      outstanding_cents != null ? parseInt(outstanding_cents) : null,
      notes !== undefined ? notes : null,
      parseInt(req.params.id),
      req.session.userId
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Pod not found' });
  res.json(rows[0]);
}));

// ─── Sweep Logic (70/30 Rule) ─────────────────────────────────────────────────
router.post('/pods/:id/sweep', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  if (!access.allowed) return res.status(423).json({ locked: true });

  const { total_amount_cents, infinite_return_route } = req.body;
  if (!total_amount_cents || parseInt(total_amount_cents) <= 0) {
    return res.status(400).json({ error: 'total_amount_cents must be a positive integer' });
  }

  const total = parseInt(total_amount_cents);
  const podId = parseInt(req.params.id);

  // Get pod for net_exposure calculation
  const { rows: podRows } = await pool.query(
    `SELECT * FROM mod_lending_desk.pods WHERE id = $1 AND user_id = $2`,
    [podId, req.session.userId]
  );
  if (!podRows[0]) return res.status(404).json({ error: 'Pod not found' });

  const pod = podRows[0];
  const netExposureBefore = parseInt(pod.outstanding_cents) || 0;

  // Infinite Return check: if net_exposure ≤ 0, 100% → user's chosen route
  const isInfiniteReturn = netExposureBefore <= 0;

  let growthPortion, legacyPortion, knowledgeCents, toolsCents, mentorshipCents;
  let netExposureAfter;

  if (isInfiniteReturn) {
    // All cash flow routes to user's choice
    growthPortion = 0;
    legacyPortion = 0;
    knowledgeCents = 0;
    toolsCents = 0;
    mentorshipCents = 0;
    netExposureAfter = 0;

    if (!infinite_return_route || !['necessities', 'reserve', 'override'].includes(infinite_return_route)) {
      return res.status(400).json({
        error: 'infinite_return_route required when net_exposure ≤ 0. Must be: necessities | reserve | override'
      });
    }
  } else {
    // 70/30 Rule
    growthPortion = Math.floor(total * 0.70);   // 70% → Growth (reduces net exposure)
    legacyPortion = total - growthPortion;        // 30% → Legacy
    // Legacy split: equal thirds
    knowledgeCents = Math.floor(legacyPortion / 3);
    toolsCents = Math.floor(legacyPortion / 3);
    mentorshipCents = legacyPortion - knowledgeCents - toolsCents;

    // Apply growth portion to reduce outstanding
    netExposureAfter = Math.max(0, netExposureBefore - growthPortion);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Log sweep
    const { rows: sweepRows } = await client.query(
      `INSERT INTO mod_lending_desk.sweep_log
         (user_id, pod_id, total_amount_cents, growth_portion_cents, legacy_portion_cents,
          knowledge_cents, tools_cents, mentorship_cents,
          net_exposure_before_cents, net_exposure_after_cents,
          is_infinite_return, infinite_return_route)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        req.session.userId, podId, total,
        growthPortion, legacyPortion,
        knowledgeCents, toolsCents, mentorshipCents,
        netExposureBefore, netExposureAfter,
        isInfiniteReturn, isInfiniteReturn ? infinite_return_route : null
      ]
    );

    // Update pod outstanding balance
    await client.query(
      `UPDATE mod_lending_desk.pods
       SET outstanding_cents = $1,
           total_swept_cents = total_swept_cents + $2,
           updated_at        = NOW()
       WHERE id = $3`,
      [isInfiniteReturn ? 0 : netExposureAfter, total, podId]
    );

    await client.query('COMMIT');

    res.status(201).json(withManualExecutionNotice({
      sweep: sweepRows[0],
      simulation_only: true,
      funds_moved: false,
      summary: {
        total,
        growth_portion: growthPortion,
        legacy_portion: legacyPortion,
        legacy_split: { knowledge: knowledgeCents, tools: toolsCents, mentorship: mentorshipCents },
        is_infinite_return: isInfiniteReturn,
        infinite_return_route: isInfiniteReturn ? infinite_return_route : null,
        net_exposure_before: netExposureBefore,
        net_exposure_after: netExposureAfter
      },
      note: 'Educational pod ledger math only. No bank funds moved. Not a loan payment or disbursement.'
    }, { overwriteStatus: true }));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// ─── Sweep History ────────────────────────────────────────────────────────────
router.get('/sweeps', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  if (!access.allowed) return res.status(423).json({ locked: true });

  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const { rows } = await pool.query(
    `SELECT sl.*, p.pod_number, p.label AS pod_label
     FROM mod_lending_desk.sweep_log sl
     LEFT JOIN mod_lending_desk.pods p ON sl.pod_id = p.id
     WHERE sl.user_id = $1
     ORDER BY sl.created_at DESC
     LIMIT $2`,
    [req.session.userId, limit]
  );

  const totals = rows.reduce((acc, s) => ({
    total: acc.total + (parseInt(s.total_amount_cents) || 0),
    growth: acc.growth + (parseInt(s.growth_portion_cents) || 0),
    legacy: acc.legacy + (parseInt(s.legacy_portion_cents) || 0)
  }), { total: 0, growth: 0, legacy: 0 });

  res.json({ sweeps: rows, totals });
}));

// ─── Infinite Return ──────────────────────────────────────────────────────────
router.get('/infinite-return', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  if (!access.allowed) return res.status(423).json({ locked: true });

  const { rows: pods } = await pool.query(
    `SELECT SUM(outstanding_cents) AS net_exposure,
            COUNT(*) FILTER (WHERE status = 'active') AS active_pods
     FROM mod_lending_desk.pods
     WHERE user_id = $1`,
    [req.session.userId]
  );

  const netExposure = parseInt(pods[0]?.net_exposure) || 0;
  const isInfiniteReturn = netExposure <= 0;

  // Current route preference from last sweep
  const { rows: lastSweep } = await pool.query(
    `SELECT infinite_return_route FROM mod_lending_desk.sweep_log
     WHERE user_id = $1 AND is_infinite_return = true
     ORDER BY created_at DESC LIMIT 1`,
    [req.session.userId]
  );

  res.json({
    is_infinite_return: isInfiniteReturn,
    net_exposure_cents: netExposure,
    current_route: lastSweep[0]?.infinite_return_route || null,
    available_routes: ['necessities', 'reserve', 'override'],
    active_pods: parseInt(pods[0]?.active_pods) || 0
  });
}));

// ─── Notification Trigger Check ───────────────────────────────────────────────
/**
 * Three notification types:
 *   1. leak_alert:     Daily_Burn > $5 AND no lending_desk → weekly max (7 days cooldown)
 *   2. velocity_check: Total_Debt decreases ≥ 10% from milestone → per 10% milestone
 *   3. zero_hour:      Total_Debt < $5,000 → once per user EVER
 */
router.get('/notifications/check', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'lending_desk', pool);
  if (!access.allowed) return res.status(423).json({ locked: true });

  // Check mute preference
  const notifPrefs = user.notification_prefs || {};
  if (notifPrefs.mute_lending === true) {
    return res.json({ fired: [], muted: true });
  }

  const userId = req.session.userId;
  const fired = [];

  // ─ 1. Leak Alert ──────────────────────────────────────────────────────────
  const { rows: burnRows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) / 30.0 AS daily_burn
     FROM expense_transactions
     WHERE user_id = $1
       AND transaction_date >= NOW() - INTERVAL '30 days'`,
    [userId]
  );
  const dailyBurn = parseFloat(burnRows[0]?.daily_burn) || 0;

  if (dailyBurn > 5) {
    // Check if already sent in last 7 days
    const { rows: recent } = await pool.query(
      `SELECT id FROM mod_lending_desk.notifications_log
       WHERE user_id = $1
         AND notification_type = 'leak_alert'
         AND sent_at >= NOW() - INTERVAL '7 days'
       LIMIT 1`,
      [userId]
    );
    if (!recent[0]) {
      await pool.query(
        `INSERT INTO mod_lending_desk.notifications_log (user_id, notification_type, metadata)
         VALUES ($1, 'leak_alert', $2)`,
        [userId, JSON.stringify({ daily_burn_cents: Math.round(dailyBurn * 100) })]
      );
      fired.push({ type: 'leak_alert', daily_burn: dailyBurn });
    }
  }

  // ─ 2. Velocity Check ──────────────────────────────────────────────────────
  // Get initial total debt (oldest pod activation)
  const { rows: podRows } = await pool.query(
    `SELECT SUM(principal_cents) AS initial_debt,
            SUM(outstanding_cents) AS current_debt
     FROM mod_lending_desk.pods
     WHERE user_id = $1 AND status IN ('active', 'at_risk')`,
    [userId]
  );
  const initialDebt = parseInt(podRows[0]?.initial_debt) || 0;
  const currentDebt = parseInt(podRows[0]?.current_debt) || 0;

  if (initialDebt > 0 && currentDebt < initialDebt) {
    const paidOffPct = ((initialDebt - currentDebt) / initialDebt) * 100;
    // Fire per 10% milestone
    for (let milestone = 10; milestone <= 90; milestone += 10) {
      if (paidOffPct >= milestone) {
        // Check if this milestone was already fired
        const { rows: milestoneFired } = await pool.query(
          `SELECT id FROM mod_lending_desk.notifications_log
           WHERE user_id = $1
             AND notification_type = 'velocity_check'
             AND milestone_pct = $2
           LIMIT 1`,
          [userId, milestone]
        );
        if (!milestoneFired[0]) {
          await pool.query(
            `INSERT INTO mod_lending_desk.notifications_log (user_id, notification_type, milestone_pct, metadata)
             VALUES ($1, 'velocity_check', $2, $3)`,
            [userId, milestone, JSON.stringify({ paid_off_pct: paidOffPct, current_debt: currentDebt })]
          );
          fired.push({ type: 'velocity_check', milestone_pct: milestone, paid_off_pct: paidOffPct });
        }
      }
    }
  }

  // ─ 3. Zero-Hour ───────────────────────────────────────────────────────────
  const ZERO_HOUR_THRESHOLD = 500000; // $5,000 in cents
  if (currentDebt > 0 && currentDebt < ZERO_HOUR_THRESHOLD) {
    // Once per user, ever
    const { rows: zeroFired } = await pool.query(
      `SELECT id FROM mod_lending_desk.notifications_log
       WHERE user_id = $1 AND notification_type = 'zero_hour'
       LIMIT 1`,
      [userId]
    );
    if (!zeroFired[0]) {
      await pool.query(
        `INSERT INTO mod_lending_desk.notifications_log (user_id, notification_type, metadata)
         VALUES ($1, 'zero_hour', $2)`,
        [userId, JSON.stringify({ current_debt_cents: currentDebt })]
      );
      fired.push({ type: 'zero_hour', current_debt_cents: currentDebt });
    }
  }

  res.json({ fired, checked_at: new Date().toISOString() });
}));

// ─── Truth in Lending (SB 362 APR box + docs + hard-stop) ─────────────────────
router.post('/til/apr-box', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  await ensureTilSchema(pool);

  const {
    deal_id: dealId,
    deal_number: dealNumber,
    amount_financed: amountFinanced,
    annual_percentage_rate: apr,
    term_months: termMonths
  } = req.body || {};

  const box = buildAprSummaryBox({
    dealNumber: dealNumber || (dealId ? String(dealId) : null),
    amountFinanced,
    annualPercentageRate: apr,
    termMonths: termMonths || 12
  });
  if (!validateAprSummaryBox(box)) {
    return res.status(400).json({ error: 'Invalid APR summary box' });
  }

  const saved = await persistAprBox(pool, { dealId: dealId || null, dealNumber: box.deal_id, box });
  res.status(201).json(withManualExecutionNotice({
    success: true,
    summary_box: box,
    record_id: saved.id
  }));
}));

router.post('/til/documents', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  await ensureTilSchema(pool);

  const dealNumber = req.body?.deal_number || req.body?.deal_id || null;
  const dealId = req.body?.deal_db_id || null;
  const docs = buildDocumentManifest(dealNumber, req.body?.document_types);
  const saved = await persistDocuments(pool, { dealId, dealNumber, docs });
  res.status(201).json(withManualExecutionNotice({
    success: true,
    documents: saved,
    status: 'READY_FOR_BIOMETRIC_SIGNATURE'
  }));
}));

router.post('/til/acknowledge', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  await ensureTilSchema(pool);

  const accepted = req.body?.accepted !== false;
  if (!accepted) {
    return res.status(400).json({ error: 'Hard-stop acknowledgment must be accepted to continue' });
  }

  const row = await persistAcknowledgment(pool, {
    userId: req.session.userId,
    disclaimerType: req.body?.disclaimer_type || HARD_STOP_TYPE,
    accepted: true,
    dealId: req.body?.deal_id || null,
    metadata: {
      source: 'compliance_hard_stop_interstitial',
      user_agent: req.headers['user-agent'] || null
    }
  });

  res.status(201).json({
    success: true,
    acknowledgment: row,
    hard_stop_cleared: true
  });
}));

// ─── Module export ─────────────────────────────────────────────────────────────
module.exports = {
  metadata: {
    name: 'Sovereign Lending Desk',
    moduleId: 'lending_desk',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true,
    addonPriceCents: 2900,
    description: '9-Pod Sovereign Lending Architecture with Behavioral Underwriting'
  },

  routes: router,

  healthCheck: async (pool) => {
    try {
      await pool.query('SELECT 1 FROM mod_lending_desk.pods LIMIT 1');
      return { module: 'mod_lending_desk', status: 'ok', version: '1.0.0' };
    } catch (e) {
      return { module: 'mod_lending_desk', status: 'degraded', error: e.message };
    }
  }
};
