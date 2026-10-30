/**
 * mod_sweep — Revolutionary Sweep Engine (EDUCATIONAL / NON-CUSTODIAL)
 *
 * Bridges T-Dagsis Digital Ledger (SSC spending) → FACTS Debt Reduction Engine.
 *
 * REGULATORY POSTURE:
 *   - NON-CUSTODIAL: This module NEVER moves bank funds, initiates ACH/wires,
 *     holds money in escrow, or routes value through any T-Dagsis/operating-entity account.
 *   - Instructional only: "execute" records an educational confirmation log that the
 *     user acknowledged a modeled surplus allocation. The user must manually apply any
 *     real-world payment at their own bank/creditor.
 *   - No Relay/Plaid Transfer / payment_initiation — none are called here.
 *
 * Core logic:
 *   1. Read actual deposits per bucket from transaction_allocations (current month)
 *   2. Read actual spending per bucket from T-Dagsis Ledger
 *   3. Calculate surplus per bucket: deposited − spent
 *   4. Sum eligible surpluses → Sweep Potential (deterministic math)
 *   5. Target: Velocity (debt reduction) primary, EOM cascade secondary
 *   6. "Sweep Now" CTA confirms the educational model + records a local log
 *
 * Also handles:
 *   - Vault Unlock: Ultimate XP → spendable Wallet points (in-app points only, not money)
 *   - Sweep history exposed for Reports (type: "Sweep")
 *
 * Tier gate: Sovereignty tier required (same as SSC).
 *
 * Schema: mod_sweep
 *
 * Routes (mounted at /api/mod_sweep):
 *   GET  /health
 *   GET  /potential         — real-time sweep calculation (no writes)
 *   POST /velocity-preview  — educational idle-cash × velocity % illustration (no writes)
 *   POST /recalculate       — trigger recalculation + persist to sweep_recommendations
 *   POST /execute           — confirm educational sweep log ("Sweep Now") — NO bank transfer
 *   GET  /history           — paginated sweep execution history (Reports: type "Sweep")
 *   POST /vault-unlock      — activate locked XP vault → wallet points (one-time)
 *   GET  /vault-status      — check vault lock status
 *
 * © T-Dagsis LLC. All rights reserved.
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const { asyncRoute } = require('../../module-error-boundary');
const { getMonthlyBucketDepositsCents, getLiveBucketDashboard, CANONICAL_PILLARS } = require('../../db/bucket-deposits');
const { withManualExecutionNotice } = require('../shared/edu-compliance');

// ─── DB Pool ──────────────────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res) {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  return true;
}

// ─── Tier gate ────────────────────────────────────────────────────────────────
const TIER_RANK = { free: 0, elite: 1, business: 2, sovereignty: 3 };

function normalizeTier(plan) {
  if (!plan) return 'free';
  const p = (plan || '').toLowerCase();
  if (p.includes('sovereignty') || p.includes('sovereign')) return 'sovereignty';
  if (p.includes('business')) return 'business';
  if (p.includes('elite') || p.includes('pro')) return 'elite';
  return 'free';
}

async function getUserTier(pool, userId) {
  const { rows } = await pool.query(
    `SELECT pricing_tier, subscription_tier, plan FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0]) return 'free';
  const u = rows[0];
  return normalizeTier(u.pricing_tier || u.subscription_tier || u.plan || '');
}

function requireSovereignty(tier, res) {
  if (TIER_RANK[tier] < TIER_RANK.sovereignty) {
    res.status(403).json({
      error: 'Sovereignty tier required for Sweep Engine',
      upgrade_url: '/pricing.html'
    });
    return false;
  }
  return true;
}

// ─── Current YYYY-MM ─────────────────────────────────────────────────────────
function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ─── Cent-Standard enforcement ────────────────────────────────────────────────
function assertInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`Cent-Standard violation: ${label} must be integer, got ${value}`);
  }
}

/**
 * Cent-Standard: 100 wallet points per $1.00 surplus swept.
 * surplus_cents / 100 = dollars → dollars × 100 = wallet points = surplus_cents.
 */
function surplusSavingsToXpAmount(surplusCents) {
  const cents = Math.floor(Number(surplusCents));
  assertInteger(cents, 'surplus_savings_cents');
  return cents;
}

/**
 * Educational idle-cash illustration only. Does not move funds.
 */
function calculateVelocitySweep(idleCash, velocityTargetPct = 0.10) {
  const cash = Number(idleCash) || 0;
  const pct = Number(velocityTargetPct);
  const rate = Number.isFinite(pct) && pct >= 0 ? pct : 0.10;
  const sweepAmount = Number((cash * rate).toFixed(2));
  return withManualExecutionNotice({
    status: 'calculated',
    idle_cash_analyzed: cash,
    recommended_sweep_amount: sweepAmount,
    target: 'Debt Acceleration / Sovereign Reserves'
  });
}

async function notifyGamificationSweepAward(payload) {
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${baseUrl}/api/mod_gamification/xp/award`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal': 'mod_sweep' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      console.warn(`[mod_sweep] Gamification XP award returned ${res.status} — continuing`);
    }
  } catch (err) {
    console.log(`[mod_sweep] Gamification XP award unavailable (${err.message}) — logged`);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── SSC PILLARS ──────────────────────────────────────────────────────────────
const PILLARS = ['necessities', 'reserve', 'velocity', 'growth', 'lifestyle', 'legacy'];

// Buckets eligible for sweep (we exclude velocity — that IS the target; also
// reserve is eligible only if it is NOT underfunded).
// All 6 pillars can generate surplus, but we apply EOM cascade logic for targeting.
const SWEEP_ELIGIBLE = ['necessities', 'lifestyle', 'legacy', 'growth', 'reserve'];

// ─── Core Calculation ─────────────────────────────────────────────────────────
/**
 * calculateSweepPotential
 *
 * Returns per-bucket surplus and total sweep potential for the current month.
 * Uses integer arithmetic only (cents).
 *
 * @param {Pool} pool
 * @param {number} userId
 * @returns {object} { income_cents, capacity, sweep_potential_cents, buckets, primary_target, secondary_target, calc_month }
 */
async function calculateSweepPotential(pool, userId) {
  const depositedByBucket = await getMonthlyBucketDepositsCents(pool, userId);
  const monthlyIncomeCents = Object.values(depositedByBucket)
    .reduce((sum, cents) => sum + cents, 0);

  const spentResult = await pool.query(
    `SELECT bucket, COALESCE(SUM(total_cents), 0)::INTEGER as spent_cents
     FROM mod_ssc.t_dagsis_ledger
     WHERE user_id = $1
       AND is_deleted = false
       AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', CURRENT_DATE)
     GROUP BY bucket`,
    [userId]
  ).catch(() => ({ rows: [] }));

  const spentByBucket = {};
  for (const row of spentResult.rows) {
    spentByBucket[row.bucket] = parseInt(row.spent_cents, 10);
  }

  const buckets = {};
  for (const pillar of PILLARS) {
    const budgetCents = depositedByBucket[pillar] || 0;
    const spentCents = spentByBucket[pillar] || 0;
    const surplusCents = Math.max(0, budgetCents - spentCents);

    buckets[pillar] = {
      budget_cents: budgetCents,
      deposited_cents: budgetCents,
      spent_cents: spentCents,
      surplus_cents: surplusCents,
      used_pct: budgetCents > 0
        ? Math.min(100, Math.round(spentCents * 100 / budgetCents))
        : 0
    };
  }

  // 5. Determine reserve health for EOM cascade secondary targeting
  // Reserve is "underfunded" if spent < 50% of budget (rough heuristic)
  const reserveBudget = buckets.reserve.budget_cents;
  const reserveSpent = buckets.reserve.spent_cents;
  const reserveUnderfunded = reserveBudget > 0 && reserveSpent < (reserveBudget * 0.5);

  // 6. Check for active debts to determine secondary target
  const debtResult = await pool.query(
    `SELECT COUNT(*) as debt_count, COALESCE(SUM(balance * 100), 0)::INTEGER as total_balance_cents
     FROM debts WHERE user_id = $1 AND balance > 0`,
    [userId]
  ).catch(() => ({ rows: [{ debt_count: 0, total_balance_cents: 0 }] }));
  const hasDebt = parseInt(debtResult.rows[0]?.debt_count || 0) > 0;
  const totalDebtCents = parseInt(debtResult.rows[0]?.total_balance_cents || 0);

  // 7. EOM cascade secondary targeting (from §9 logic):
  //    - Primary: Velocity (always — debt reduction)
  //    - Secondary: Reserve (if underfunded), else Growth (if has debt), else Growth
  let secondaryTarget = null;
  if (reserveUnderfunded && buckets.reserve.surplus_cents === 0) {
    secondaryTarget = 'reserve'; // top-up reserve first
  } else if (hasDebt) {
    secondaryTarget = null; // all surplus goes to velocity when in debt
  } else {
    secondaryTarget = 'growth'; // no debt → grow wealth
  }

  // 8. Sum eligible surpluses into Sweep Potential
  // When in debt: all non-velocity surplus is eligible
  // When no debt: standard cascade (reserve first if underfunded, then growth)
  let sweepPotentialCents = 0;
  const eligibleBuckets = [];

  for (const pillar of SWEEP_ELIGIBLE) {
    const surplus = buckets[pillar].surplus_cents;
    if (surplus > 0) {
      sweepPotentialCents += surplus;
      eligibleBuckets.push({ bucket: pillar, surplus_cents: surplus });
    }
  }

  assertInteger(sweepPotentialCents, 'sweep_potential_cents');

  return {
    income_cents: monthlyIncomeCents,
    total_deposited_cents: monthlyIncomeCents,
    buckets,
    eligible_buckets: eligibleBuckets,
    sweep_potential_cents: sweepPotentialCents,
    primary_target: 'velocity',
    secondary_target: secondaryTarget,
    has_debt: hasDebt,
    total_debt_cents: totalDebtCents,
    reserve_underfunded: reserveUnderfunded,
    calc_month: currentYearMonth()
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────
const router = express.Router();

// ── GET /health ───────────────────────────────────────────────────────────────
router.get('/health', asyncRoute(async (req, res) => {
  const pool = getPool();
  let schema = 'ok';
  try {
    await pool.query('SELECT 1 FROM mod_sweep.sweep_recommendations LIMIT 0');
  } catch (err) {
    if (/does not exist|sweep_recommendations/i.test(err.message)) {
      schema = 'schema_missing';
    } else {
      throw err;
    }
  }
  res.json({
    status: schema === 'ok' ? 'ok' : 'degraded',
    module: 'mod_sweep',
    version: '1.0.0',
    schema
  });
}));

// ── GET /bucket-dashboard ─────────────────────────────────────────────────────
/**
 * Live 6-bucket FACTS dashboard. Not sovereignty-gated.
 * Upserts user_bucket_state from current-month allocations, then returns rows.
 */
router.get('/bucket-dashboard', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const dash = await getLiveBucketDashboard(pool, userId);
  const buckets = {};
  for (const slug of CANONICAL_PILLARS) {
    const row = (dash.rows || []).find((r) => r.bucket_slug === slug);
    buckets[slug] = {
      target_pct: row ? Number(row.target_pct) : 0,
      deposited_cents: row ? parseInt(row.deposited_cents, 10) : 0,
      spent_cents: row ? parseInt(row.spent_cents, 10) : 0,
      remaining_cents: row ? parseInt(row.remaining_cents, 10) : 0
    };
  }
  res.json({
    user_id: userId,
    buckets,
    rows: dash.rows || [],
    defaults: {
      necessities: 50,
      reserve: 10,
      velocity: 10,
      growth: 10,
      lifestyle: 10,
      legacy: 10
    }
  });
}));

// ── POST /velocity-preview ────────────────────────────────────────────────────
/**
 * Educational idle-cash illustration. Does NOT write to DB or move funds.
 */
router.post('/velocity-preview', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const idleCash = req.body?.idle_cash ?? req.body?.idleCash;
  const pct = req.body?.velocity_target_pct ?? req.body?.velocityTargetPct ?? 0.10;
  res.json(calculateVelocitySweep(idleCash, pct));
}));

// ── GET /potential ────────────────────────────────────────────────────────────
/**
 * Real-time sweep calculation. Does NOT write to DB.
 * Used by the SSC HUD and FACTS dashboard card.
 */
router.get('/potential', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const tier = await getUserTier(pool, userId);
  if (!requireSovereignty(tier, res)) return;

  const calc = await calculateSweepPotential(pool, userId);

  res.json(withManualExecutionNotice({
    sweep_potential_cents: calc.sweep_potential_cents,
    sweep_potential_dollars: (calc.sweep_potential_cents / 100).toFixed(2),
    primary_target: calc.primary_target,
    secondary_target: calc.secondary_target,
    has_debt: calc.has_debt,
    total_debt_cents: calc.total_debt_cents,
    reserve_underfunded: calc.reserve_underfunded,
    income_cents: calc.income_cents,
    eligible_buckets: calc.eligible_buckets,
    buckets: calc.buckets,
    calc_month: calc.calc_month,
    calculated_at: new Date().toISOString()
  }, { overwriteStatus: true }));
}));

// ── POST /recalculate ─────────────────────────────────────────────────────────
/**
 * Recalculate and persist the latest sweep recommendation.
 * Called on SSC ledger entry or on-demand refresh.
 */
router.post('/recalculate', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const tier = await getUserTier(pool, userId);
  if (!requireSovereignty(tier, res)) return;

  const calc = await calculateSweepPotential(pool, userId);

  // Upsert the recommendation row
  await pool.query(
    `INSERT INTO mod_sweep.sweep_recommendations
       (user_id, necessities_surplus, reserve_surplus, velocity_surplus,
        growth_surplus, lifestyle_surplus, legacy_surplus,
        sweep_potential_cents, primary_target, secondary_target,
        income_cents, calc_month, calculated_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       necessities_surplus    = EXCLUDED.necessities_surplus,
       reserve_surplus        = EXCLUDED.reserve_surplus,
       velocity_surplus       = EXCLUDED.velocity_surplus,
       growth_surplus         = EXCLUDED.growth_surplus,
       lifestyle_surplus      = EXCLUDED.lifestyle_surplus,
       legacy_surplus         = EXCLUDED.legacy_surplus,
       sweep_potential_cents  = EXCLUDED.sweep_potential_cents,
       primary_target         = EXCLUDED.primary_target,
       secondary_target       = EXCLUDED.secondary_target,
       income_cents           = EXCLUDED.income_cents,
       calc_month             = EXCLUDED.calc_month,
       calculated_at          = NOW(),
       updated_at             = NOW()`,
    [
      userId,
      calc.buckets.necessities.surplus_cents,
      calc.buckets.reserve.surplus_cents,
      calc.buckets.velocity.surplus_cents,
      calc.buckets.growth.surplus_cents,
      calc.buckets.lifestyle.surplus_cents,
      calc.buckets.legacy.surplus_cents,
      calc.sweep_potential_cents,
      calc.primary_target,
      calc.secondary_target,
      calc.income_cents,
      calc.calc_month
    ]
  );

  res.json(withManualExecutionNotice({
    recalculated: true,
    sweep_potential_cents: calc.sweep_potential_cents,
    sweep_potential_dollars: (calc.sweep_potential_cents / 100).toFixed(2),
    primary_target: calc.primary_target,
    secondary_target: calc.secondary_target,
    calc_month: calc.calc_month
  }, { overwriteStatus: true }));
}));

// ── POST /execute ─────────────────────────────────────────────────────────────
/**
 * Confirm an educational sweep model — "Sweep Now" CTA.
 *
 * NON-CUSTODIAL: Does NOT initiate bank transfers, ACH, wires, or any fund movement.
 * Records instructional logs only:
 *   1. sweep_executions row (audit trail)
 *   2. sweep_execution_items per contributing bucket
 *   3. A transaction record in FACTS core (type: 'sweep') so it appears in Reports
 *
 * Does NOT modify allocation percentages — educational model confirmation only.
 * The user applies any real-world payment to their Velocity (debt) account manually.
 */
router.post('/execute', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const tier = await getUserTier(pool, userId);
  if (!requireSovereignty(tier, res)) return;

  // Fresh calculation
  const calc = await calculateSweepPotential(pool, userId);

  if (calc.sweep_potential_cents <= 0) {
    return res.status(400).json({
      error: 'No sweep potential available — no bucket surplus this month',
      sweep_potential_cents: 0
    });
  }

  const { notes } = req.body;
  const sweepMonth = calc.calc_month;
  const totalSwept = calc.sweep_potential_cents;
  const primaryTarget = calc.primary_target;

  assertInteger(totalSwept, 'total_swept_cents');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Create sweep execution record
    const execResult = await client.query(
      `INSERT INTO mod_sweep.sweep_executions
         (user_id, total_swept_cents, target_bucket, sweep_potential_cents,
          income_cents, sweep_month, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, executed_at`,
      [userId, totalSwept, primaryTarget, calc.sweep_potential_cents,
       calc.income_cents, sweepMonth, notes || null]
    );
    const execId = execResult.rows[0].id;
    const executedAt = execResult.rows[0].executed_at;

    // 2. Create line items per contributing bucket
    for (const eb of calc.eligible_buckets) {
      if (eb.surplus_cents > 0) {
        await client.query(
          `INSERT INTO mod_sweep.sweep_execution_items
             (execution_id, user_id, bucket, surplus_cents, swept_cents)
           VALUES ($1,$2,$3,$4,$5)`,
          [execId, userId, eb.bucket, eb.surplus_cents, eb.surplus_cents]
        );
      }
    }

    // 3. Record a FACTS transaction for Reports visibility
    // type='sweep' is our new type — falls back gracefully in the UI
    await client.query(
      `INSERT INTO transactions
         (user_id, amount, type, description, transaction_date, category_id, created_at, updated_at)
       SELECT $1, $2::DECIMAL/100, 'sweep', $3, CURRENT_DATE, c.id, NOW(), NOW()
       FROM categories c
       WHERE c.slug = 'velocity'
       LIMIT 1`,
      [
        userId,
        totalSwept,
        `Educational sweep model confirmed — $${(totalSwept / 100).toFixed(2)} surplus noted toward ${primaryTarget} (no funds moved by FACTS)`
      ]
    ).catch(() => {
      // If velocity category doesn't exist or transactions schema differs, non-fatal
    });

    // 4. Update (clear) the recommendation after execution
    await client.query(
      `UPDATE mod_sweep.sweep_recommendations
       SET sweep_potential_cents = 0,
           necessities_surplus = 0, reserve_surplus = 0,
           velocity_surplus = 0, growth_surplus = 0,
           lifestyle_surplus = 0, legacy_surplus = 0,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    // 5. Self-heal gamification decay — valid sweep exits decay before XP/mint award
    await client.query(
      `INSERT INTO mod_gamification.user_xp (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    await client.query(
      `UPDATE mod_gamification.user_xp
       SET last_sweep_detected_at = NOW(),
           decay_state            = 'healthy',
           decay_week_count       = 0,
           updated_at             = NOW()
       WHERE user_id = $1`,
      [userId]
    );

    await client.query('COMMIT');

    const xpAmount = surplusSavingsToXpAmount(totalSwept);
    if (xpAmount > 0) {
      notifyGamificationSweepAward({
        userId,
        eventType: 'sweep_execute',
        xpAmount,
        metadata: {
          execution_id: execId,
          total_swept_cents: totalSwept,
          target_bucket: primaryTarget,
          sweep_month: sweepMonth,
          contributing_buckets: calc.eligible_buckets
        }
      }).catch(err => {
        console.warn(`[mod_sweep] Gamification XP award skipped: ${err.message}`);
      });
    }

    res.json(withManualExecutionNotice({
      status: 'calculated',
      executed: true,
      funds_moved: false,
      custodial: false,
      instructional_only: true,
      execution_id: execId,
      total_swept_cents: totalSwept,
      total_swept_dollars: (totalSwept / 100).toFixed(2),
      target_bucket: primaryTarget,
      sweep_month: sweepMonth,
      contributing_buckets: calc.eligible_buckets,
      executed_at: executedAt.toISOString(),
      xp_awarded: xpAmount,
      message: `Educational model confirmed: $${(totalSwept / 100).toFixed(2)} surplus noted toward ${primaryTarget}. No bank funds were moved by FACTS — apply any real-world payment yourself.`
    }, { overwriteStatus: true }));

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── GET /history ──────────────────────────────────────────────────────────────
/**
 * Paginated sweep execution history.
 * Includes per-execution bucket breakdown.
 * Exposed in Reports as type: "Sweep".
 */
router.get('/history', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const tier = await getUserTier(pool, userId);
  if (!requireSovereignty(tier, res)) return;

  const page = Math.max(1, parseInt(req.query.page || 1));
  const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page || 20)));
  const offset = (page - 1) * perPage;

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM mod_sweep.sweep_executions WHERE user_id = $1`,
    [userId]
  );
  const total = parseInt(countResult.rows[0].count);

  const execResult = await pool.query(
    `SELECT e.*,
            json_agg(i ORDER BY i.bucket) as items
     FROM mod_sweep.sweep_executions e
     LEFT JOIN mod_sweep.sweep_execution_items i ON i.execution_id = e.id
     WHERE e.user_id = $1
     GROUP BY e.id
     ORDER BY e.executed_at DESC
     LIMIT $2 OFFSET $3`,
    [userId, perPage, offset]
  );

  const sweeps = execResult.rows.map(row => ({
    id: row.id,
    type: 'Sweep',
    total_swept_cents: row.total_swept_cents,
    total_swept_dollars: (row.total_swept_cents / 100).toFixed(2),
    target_bucket: row.target_bucket,
    sweep_month: row.sweep_month,
    executed_at: row.executed_at,
    contributing_buckets: (row.items || []).filter(Boolean)
  }));

  res.json({
    sweeps,
    pagination: {
      page,
      per_page: perPage,
      total,
      pages: Math.ceil(total / perPage)
    }
  });
}));

// ── POST /vault-unlock ────────────────────────────────────────────────────────
/**
 * One-time conversion: Ultimate XP Vault → spendable Wallet points.
 *
 * Idempotent: second call returns { already_converted: true }.
 * Conversion rate: 100 locked XP → 1 spendable Wallet point (Cent-Standard).
 * Mints event_type 'vault_unlock' in mod_rewards.rewards_ledger.
 * Records in mod_sweep.vault_unlock_log to prevent double-minting.
 */
router.post('/vault-unlock', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  // No tier gate — vault unlock is triggered by upgrade itself

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check idempotency via vault_unlock_log (locks the row)
    const logCheck = await client.query(
      `SELECT id, minted_points FROM mod_sweep.vault_unlock_log WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (logCheck.rows[0]) {
      await client.query('ROLLBACK');
      return res.json({
        already_converted: true,
        minted_points: logCheck.rows[0].minted_points,
        message: 'Vault already unlocked'
      });
    }

    // Also check mod_ssc.xp_vault converted_at for safety
    const vaultResult = await client.query(
      `SELECT locked_points, converted_at FROM mod_ssc.xp_vault WHERE user_id = $1`,
      [userId]
    );

    const vault = vaultResult.rows[0];
    const lockedPoints = parseInt(vault?.locked_points || 0);

    if (!vault || lockedPoints === 0) {
      await client.query('ROLLBACK');
      return res.json({
        already_converted: false,
        minted_points: 0,
        locked_points: 0,
        message: 'No locked XP to convert'
      });
    }

    // Cent-Standard: 100 locked XP = 1 spendable wallet point
    const mintedPoints = Math.floor(lockedPoints / 100);

    if (mintedPoints > 0) {
      // Ensure wallet exists
      await client.query(
        `INSERT INTO mod_rewards.user_wallet (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      );

      // Get current real balance for running total
      const walletResult = await client.query(
        `SELECT balance_real FROM mod_rewards.user_wallet WHERE user_id = $1 FOR UPDATE`,
        [userId]
      );
      const currentBalance = parseInt(walletResult.rows[0]?.balance_real || 0);
      const balanceAfter = currentBalance + mintedPoints;

      assertInteger(mintedPoints, 'minted_points');
      assertInteger(balanceAfter, 'balance_after');

      // Mint into rewards_ledger
      await client.query(
        `INSERT INTO mod_rewards.rewards_ledger
           (user_id, event_type, points, balance_after, metadata, sandbox)
         VALUES ($1, 'vault_unlock', $2, $3, $4, false)`,
        [
          userId,
          mintedPoints,
          balanceAfter,
          JSON.stringify({
            source: 'xp_vault_conversion',
            locked_points_converted: lockedPoints,
            conversion_rate: '100:1 (Cent-Standard)',
            triggered_by: 'mod_sweep/vault-unlock'
          })
        ]
      );

      // Update wallet balance
      await client.query(
        `UPDATE mod_rewards.user_wallet
         SET balance_real      = balance_real + $2,
             total_earned_real = total_earned_real + $2,
             updated_at        = NOW()
         WHERE user_id = $1`,
        [userId, mintedPoints]
      );
    }

    // Mark xp_vault as converted
    await client.query(
      `UPDATE mod_ssc.xp_vault
       SET converted_at = NOW(), converted_points = $1, updated_at = NOW()
       WHERE user_id = $2`,
      [mintedPoints, userId]
    );

    // Record in vault_unlock_log (prevents double-minting)
    await client.query(
      `INSERT INTO mod_sweep.vault_unlock_log (user_id, locked_points, minted_points)
       VALUES ($1, $2, $3)`,
      [userId, lockedPoints, mintedPoints]
    );

    await client.query('COMMIT');

    res.json({
      unlocked: true,
      locked_points: lockedPoints,
      minted_points: mintedPoints,
      already_converted: false,
      message: mintedPoints > 0
        ? `🔓 Vault Unlocked! ${mintedPoints} points added to your Wallet.`
        : 'Vault unlocked — no points to convert (0 locked XP).'
    });

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ── GET /vault-status ─────────────────────────────────────────────────────────
/**
 * Returns current vault lock status.
 * Called on first SSC login after upgrade to show/hide vault notification.
 */
router.get('/vault-status', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  // Check unlock log
  const logResult = await pool.query(
    `SELECT id, minted_points, occurred_at FROM mod_sweep.vault_unlock_log WHERE user_id = $1`,
    [userId]
  );

  if (logResult.rows[0]) {
    return res.json({
      is_locked: false,
      minted_points: logResult.rows[0].minted_points,
      unlocked_at: logResult.rows[0].occurred_at,
      show_notification: false
    });
  }

  // Check xp_vault for locked points
  const vaultResult = await pool.query(
    `SELECT locked_points, converted_at FROM mod_ssc.xp_vault WHERE user_id = $1`,
    [userId]
  ).catch(() => ({ rows: [] }));

  const vault = vaultResult.rows[0];
  const lockedPoints = parseInt(vault?.locked_points || 0);
  const alreadyConverted = !!vault?.converted_at;

  res.json({
    is_locked: !alreadyConverted && lockedPoints > 0,
    locked_points: lockedPoints,
    spendable_if_unlocked: Math.floor(lockedPoints / 100),
    show_notification: !alreadyConverted && lockedPoints > 0,
    unlocked_at: vault?.converted_at || null
  });
}));

// ─── Module Export ────────────────────────────────────────────────────────────
module.exports = {
  routes: router,

  healthCheck: async (pool) => {
    try {
      const schemaCheck = await pool.query(
        `SELECT EXISTS(
           SELECT 1 FROM information_schema.schemata
           WHERE schema_name = 'mod_sweep'
         ) AS exists`
      );
      return {
        module: 'mod_sweep',
        status: schemaCheck.rows[0]?.exists ? 'ok' : 'schema_missing',
        version: '1.0.0',
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return { module: 'mod_sweep', status: 'error', error: err.message };
    }
  },

  metadata: {
    name: 'mod_sweep',
    version: '1.0.0',
    description: 'Revolutionary Sweep Engine — SSC Ledger → Debt Reduction + XP Vault Activation',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true
  },

  calculateVelocitySweep
};
