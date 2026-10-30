/**
 * mod_rewards — The Wallet (Universal Rewards Ledger)
 *
 * Tracks spendable points, Consistency Streak, and rewards telemetry.
 * This module is EXEMPT from all gating — open to ALL users at $0 cost.
 * No subscription_level or active_addons check anywhere in this module.
 *
 * Cent-Standard: 100 points = $1.00. ALL arithmetic uses INTEGER.
 * No floats, no decimals in the ledger — ever.
 *
 * Schema: mod_rewards (rewards_ledger, user_wallet)
 *
 * Routes (mounted at /api/mod_rewards):
 *   GET  /health
 *   POST /mint               — Called by Module A XP engine to grant points
 *   POST /sync-reward        — 50 pts for manual sync (1/24h rate limit)
 *   POST /activity           — Log platform activity for streak tracking
 *   GET  /streak             — Current streak, longest streak, last activity date
 *   GET  /balance            — Current point balance (sandbox-aware)
 *   GET  /history            — Paginated ledger history
 *   GET  /dashboard          — Full wallet dashboard data
 *
 * Integration:
 *   - mod_gamification calls POST /mint after XP award
 *   - mod_lending_desk calls GET /streak for Behavioral Underwriting
 *
 * © T-Dagsis LLC. All rights reserved.
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const { asyncRoute } = require('../../module-error-boundary');

// ─── DB Pool (lazy-init) ──────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

// ─── ISO Week Utility ─────────────────────────────────────────────────────────
// Returns 'YYYY-Www' for a given date, e.g. '2026-W17'
function isoWeekString(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayOfWeek = d.getUTCDay() || 7; // Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Returns the ISO week string for N weeks ago
function weekAgo(weeksBack) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - weeksBack * 7);
  return isoWeekString(d);
}

// ─── Ensure user_wallet row exists ───────────────────────────────────────────
async function ensureWallet(client, userId) {
  await client.query(
    `INSERT INTO mod_rewards.user_wallet (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

// ─── Get current wallet row ───────────────────────────────────────────────────
async function getWalletRow(pool, userId) {
  const result = await pool.query(
    `SELECT * FROM mod_rewards.user_wallet WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

// ─── Integrity check: points must be integer ──────────────────────────────────
function assertInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`Cent-Standard violation: ${label} must be a whole integer, got ${value}`);
  }
}

// ─── Sandbox detection ────────────────────────────────────────────────────────
async function isUserSandbox(pool, userId) {
  const result = await pool.query(
    `SELECT sandbox_mode FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0]?.sandbox_mode || false;
}

// ─── Mint Points (core logic) ─────────────────────────────────────────────────
/**
 * Mints spendable points into the ledger.
 * Called internally by:
 *   - POST /mint endpoint (from mod_gamification)
 *   - POST /sync-reward endpoint
 *   - POST /activity endpoint (streak bonus mints)
 *
 * @param {object} client - pg transaction client
 * @param {number} userId
 * @param {number} points - MUST be a positive integer
 * @param {string} eventType - e.g. 'xp_mint', 'sync_reward', 'streak_bonus'
 * @param {object} metadata
 * @param {boolean} sandbox - whether this is a sandbox credit
 * @returns {object} { balance_after, sandbox }
 */
async function mintPointsInternal(client, userId, points, eventType, metadata, sandbox) {
  assertInteger(points, 'points');
  if (points <= 0) throw new Error('Mint amount must be positive');

  await ensureWallet(client, userId);

  // Get current balance
  const walletResult = await client.query(
    `SELECT balance_real, balance_sandbox FROM mod_rewards.user_wallet WHERE user_id = $1 FOR UPDATE`,
    [userId]
  );
  const wallet = walletResult.rows[0];
  const currentBalance = sandbox ? wallet.balance_sandbox : wallet.balance_real;
  const balanceAfter = currentBalance + points;

  assertInteger(balanceAfter, 'balance_after');

  // Insert ledger entry
  await client.query(
    `INSERT INTO mod_rewards.rewards_ledger
       (user_id, event_type, points, balance_after, metadata, sandbox)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, eventType, points, balanceAfter, JSON.stringify(metadata || {}), sandbox]
  );

  // Update denormalized wallet
  if (sandbox) {
    await client.query(
      `UPDATE mod_rewards.user_wallet
       SET balance_sandbox      = balance_sandbox + $2,
           total_earned_sandbox = total_earned_sandbox + $2,
           updated_at           = NOW()
       WHERE user_id = $1`,
      [userId, points]
    );
  } else {
    await client.query(
      `UPDATE mod_rewards.user_wallet
       SET balance_real      = balance_real + $2,
           total_earned_real = total_earned_real + $2,
           updated_at        = NOW()
       WHERE user_id = $1`,
      [userId, points]
    );
  }

  return { balance_after: balanceAfter, sandbox };
}

// ─── Update Streak (called on any platform activity) ─────────────────────────
/**
 * Updates the user's weekly consistency streak.
 *
 * Streak rules:
 *   - Activity this week: streak continues (or starts at 1 if no prior)
 *   - Activity recorded this exact week already: no change to streak
 *   - Last activity was last week: streak increments by 1
 *   - Last activity was 2+ weeks ago: streak resets to 1
 *
 * @param {object} client - pg transaction client
 * @param {number} userId
 * @param {object} metadata - optional activity metadata
 * @returns {object} { current_streak, longest_streak, streak_changed }
 */
async function updateStreakInternal(client, userId, metadata = {}) {
  await ensureWallet(client, userId);

  const walletResult = await client.query(
    `SELECT current_streak, longest_streak, last_activity_week
     FROM mod_rewards.user_wallet
     WHERE user_id = $1 FOR UPDATE`,
    [userId]
  );
  const wallet = walletResult.rows[0];

  const thisWeek = isoWeekString(new Date());
  const lastActivityWeek = wallet.last_activity_week;

  // Already logged activity this week — no streak change
  if (lastActivityWeek === thisWeek) {
    // Just update the timestamp
    await client.query(
      `UPDATE mod_rewards.user_wallet
       SET last_activity_at = NOW(), updated_at = NOW()
       WHERE user_id = $1`,
      [userId]
    );
    return {
      current_streak: wallet.current_streak,
      longest_streak: wallet.longest_streak,
      streak_changed: false
    };
  }

  let newStreak;
  const lastWeek = weekAgo(1);

  if (!lastActivityWeek) {
    // First activity ever
    newStreak = 1;
  } else if (lastActivityWeek === lastWeek) {
    // Consecutive week — extend streak
    newStreak = wallet.current_streak + 1;
  } else {
    // Gap — reset streak
    newStreak = 1;
  }

  const newLongest = Math.max(wallet.longest_streak, newStreak);

  await client.query(
    `UPDATE mod_rewards.user_wallet
     SET current_streak     = $2,
         longest_streak     = $3,
         last_activity_week = $4,
         last_activity_at   = NOW(),
         updated_at         = NOW()
     WHERE user_id = $1`,
    [userId, newStreak, newLongest, thisWeek]
  );

  return {
    current_streak: newStreak,
    longest_streak: newLongest,
    streak_changed: true
  };
}

const REQUIRED_FOR_ELITE = 12;
const REQUIRED_FOR_BUSINESS = 24;

function parseEligibilityUserId(raw) {
  const n = parseInt(raw, 10);
  if (Number.isInteger(n) && n > 0) return n;
  const m = String(raw || '').match(/(\d+)$/);
  if (!m) return null;
  const fromSuffix = parseInt(m[1], 10);
  return Number.isInteger(fromSuffix) && fromSuffix > 0 ? fromSuffix : null;
}

function evaluateEligibility(userId, streakWeeks, subscriptionActive) {
  const weeks = Number.isInteger(streakWeeks) ? streakWeeks : 0;
  let eligible = false;
  let tier = 'Individual (Levels 1-6)';
  let unlockCost = null;
  if (weeks >= REQUIRED_FOR_BUSINESS) {
    eligible = true;
    tier = 'Business (Levels 10-11)';
    unlockCost = '$49/mo';
  } else if (weeks >= REQUIRED_FOR_ELITE) {
    eligible = true;
    tier = 'Elite (Levels 7-9)';
    unlockCost = '$29/mo';
  } else {
    eligible = false;
    tier = 'Individual / Locked';
    unlockCost = null;
  }
  return {
    userId,
    eligible,
    tier,
    streakWeeks: weeks,
    requiredWeeks: weeks < REQUIRED_FOR_ELITE ? REQUIRED_FOR_ELITE : REQUIRED_FOR_BUSINESS,
    unlockCost,
    subscriptionActive: subscriptionActive !== false
  };
}

async function eligibilityPayload(pool, rawUserId) {
  const userId = parseEligibilityUserId(rawUserId);
  if (!userId) {
    const err = new Error('userId required');
    err.statusCode = 400;
    throw err;
  }
  await pool.query(
    `INSERT INTO mod_rewards.user_wallet (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  const wallet = await pool.query(
    `SELECT current_streak FROM mod_rewards.user_wallet WHERE user_id = $1`,
    [userId]
  );
  const user = await pool.query(
    `SELECT subscription_status FROM users WHERE id = $1`,
    [userId]
  );
  if (!user.rows[0]) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }
  const status = (user.rows[0].subscription_status || '').toLowerCase();
  const subscriptionActive = status === '' || status === 'active' || status === 'trialing';
  return evaluateEligibility(userId, Number(wallet.rows[0]?.current_streak || 0), subscriptionActive);
}

function allowEligibilityRead(req, res, userId) {
  if (req.headers['x-internal']) return true;
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return false;
  }
  if (req.session.userId !== userId) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

async function handleEligibility(req, res) {
  const pool = getPool();
  const userId = parseEligibilityUserId(req.params.userId);
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!allowEligibilityRead(req, res, userId)) return;
  try {
    const payload = await eligibilityPayload(pool, userId);
    res.json(payload);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) throw err;
    res.status(status).json({ error: err.message });
  }
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ─── Routes ───────────────────────────────────────────────────────────────────
const router = express.Router();

router.get('/eligibility/:userId', asyncRoute(handleEligibility));

const vaultRouter = express.Router();
vaultRouter.get('/eligibility/:userId', asyncRoute(handleEligibility));

// ─── GET /health ──────────────────────────────────────────────────────────────
router.get('/health', asyncRoute(async (req, res) => {
  const pool = getPool();
  const schemaCheck = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.schemata
       WHERE schema_name = 'mod_rewards'
     ) AS schema_exists`
  );
  const tableCheck = await pool.query(
    `SELECT COUNT(*) AS table_count
     FROM information_schema.tables
     WHERE table_schema = 'mod_rewards'`
  );

  res.json({
    status: 'ok',
    module: 'mod_rewards',
    version: '1.0.0',
    gating: 'NONE — open to all users',
    schema_exists: schemaCheck.rows[0]?.schema_exists,
    table_count: parseInt(tableCheck.rows[0]?.table_count ?? 0),
    cent_standard: '100 pts = $1.00 (integer-only arithmetic)',
    timestamp: new Date().toISOString()
  });
}));

// ─── POST /mint ───────────────────────────────────────────────────────────────
/**
 * Called by Module A (mod_gamification) to grant spendable points for XP events.
 * Also accepts x-internal header for module-to-module calls.
 *
 * Body: { userId, points, eventType, metadata? }
 */
router.post('/mint', asyncRoute(async (req, res) => {
  // Allow internal module-to-module calls
  const isInternal = req.headers['x-internal'];
  if (!isInternal && (!req.session || !req.session.userId)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { userId, points, eventType, metadata, xpAwarded, decayState } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  // Support both 'points' and 'xpAwarded' (gamification sends xpAwarded)
  const rawPoints = points ?? xpAwarded;
  if (rawPoints == null) {
    return res.status(400).json({ error: 'points is required' });
  }

  // Convert to integer (Cent-Standard enforcement)
  const pointsInt = Math.floor(Number(rawPoints));
  if (pointsInt <= 0) {
    // Zero-point events are a no-op (don't error, just acknowledge)
    return res.json({ success: true, points_minted: 0, message: 'Zero points — no ledger entry' });
  }

  assertInteger(pointsInt, 'points');

  const pool = getPool();
  const sandbox = await isUserSandbox(pool, userId);

  // If user is in decay, gamification still calls mint but with reduced XP
  // We record as-is — the Wallet doesn't apply decay itself
  const mintType = eventType || 'xp_mint';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await mintPointsInternal(
      client, userId, pointsInt, mintType,
      { ...(metadata || {}), source: 'mod_gamification', decay_state: decayState },
      sandbox
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      points_minted: pointsInt,
      balance_after: result.balance_after,
      sandbox,
      event_type: mintType
    });

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ─── POST /sync-reward ────────────────────────────────────────────────────────
/**
 * Awards 50 points for a manual sync action.
 * Rate limit: maximum 1 sync reward per user per 24 hours.
 *
 * Body: { userId? } — falls back to session userId
 *
 * When Plaid ships, the Plaid token exchange flow will call this endpoint.
 */
router.post('/sync-reward', requireAuth, asyncRoute(async (req, res) => {
  const userId = req.body.userId || req.session.userId;

  // Enforce: only the authenticated user (or admin) can request their own sync reward
  if (userId !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden — can only trigger own sync reward' });
  }

  const pool = getPool();

  // Rate limit check: any sync_reward in the last 24 hours?
  const rateLimitCheck = await pool.query(
    `SELECT id, created_at FROM mod_rewards.rewards_ledger
     WHERE user_id = $1
       AND event_type = 'sync_reward'
       AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );

  if (rateLimitCheck.rows.length > 0) {
    const lastSync = new Date(rateLimitCheck.rows[0].created_at);
    const nextEligible = new Date(lastSync.getTime() + 24 * 60 * 60 * 1000);
    return res.status(429).json({
      error: 'Rate limit — 1 sync reward per 24 hours',
      last_sync_at: lastSync.toISOString(),
      next_eligible_at: nextEligible.toISOString()
    });
  }

  const sandbox = await isUserSandbox(pool, userId);
  const SYNC_REWARD_POINTS = 50; // 50 pts = $0.50

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const now = new Date();
    const result = await mintPointsInternal(
      client, userId, SYNC_REWARD_POINTS, 'sync_reward',
      { source: 'manual_sync', last_sync_at: now.toISOString() },
      sandbox
    );

    // Also count as activity for streak tracking
    const streakResult = await updateStreakInternal(
      client, userId,
      { source: 'sync_reward', occurred_at: now.toISOString() }
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      points_awarded: SYNC_REWARD_POINTS,
      balance_after: result.balance_after,
      sandbox,
      synced_at: now.toISOString(),
      streak: {
        current: streakResult.current_streak,
        longest: streakResult.longest_streak,
        streak_extended: streakResult.streak_changed
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ─── POST /activity ───────────────────────────────────────────────────────────
/**
 * Logs platform activity for streak tracking.
 * Called when user enters transactions, adjusts allocations, or logs debt payments.
 * Does NOT mint points — streak only. Points come from XP/gamification minting.
 *
 * Body: { activityType: 'transaction'|'allocation'|'debt_payment'|'check_in' }
 */
router.post('/activity', requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.userId;
  const { activityType } = req.body;

  const validTypes = ['transaction', 'allocation', 'debt_payment', 'check_in', 'general'];
  const type = validTypes.includes(activityType) ? activityType : 'general';

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const streakResult = await updateStreakInternal(
      client, userId,
      { activity_type: type, occurred_at: new Date().toISOString() }
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      activity_type: type,
      streak: {
        current: streakResult.current_streak,
        longest: streakResult.longest_streak,
        streak_extended: streakResult.streak_changed,
        week: isoWeekString(new Date())
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ─── GET /streak ──────────────────────────────────────────────────────────────
/**
 * Returns current streak, longest streak, last activity date.
 * Used by Lending Desk (mod_lending_desk) for Behavioral Underwriting.
 *
 * Accepts x-internal header for cross-module reads.
 */
router.get('/streak', asyncRoute(async (req, res) => {
  const isInternal = req.headers['x-internal'];

  // Allow internal module-to-module reads, OR authenticated user reads
  if (!isInternal && (!req.session || !req.session.userId)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Support ?userId= for internal calls (Lending Desk passes userId in query)
  const userId = req.query.userId
    ? parseInt(req.query.userId, 10)
    : req.session?.userId;

  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO mod_rewards.user_wallet (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  const result = await pool.query(
    `SELECT current_streak, longest_streak, last_activity_at, last_activity_week
     FROM mod_rewards.user_wallet
     WHERE user_id = $1`,
    [userId]
  );

  const wallet = result.rows[0];

  res.json({
    user_id: userId,
    current_streak: wallet?.current_streak ?? 0,
    longest_streak: wallet?.longest_streak ?? 0,
    last_activity_at: wallet?.last_activity_at || null,
    last_activity_week: wallet?.last_activity_week || null,
    current_week: isoWeekString(new Date())
  });
}));

// ─── GET /balance ─────────────────────────────────────────────────────────────
/**
 * Returns current point balance.
 * Filters by sandbox flag based on user's sandbox_mode.
 * Free users, Elite, Business, Sovereignty — all see their balance.
 * No tier gate.
 */
router.get('/balance', requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.userId;
  const pool = getPool();

  await pool.query(
    `INSERT INTO mod_rewards.user_wallet (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  const sandbox = await isUserSandbox(pool, userId);

  const result = await pool.query(
    `SELECT balance_real, balance_sandbox, total_earned_real, total_earned_sandbox
     FROM mod_rewards.user_wallet
     WHERE user_id = $1`,
    [userId]
  );

  const wallet = result.rows[0];
  const balance = sandbox ? (wallet?.balance_sandbox ?? 0) : (wallet?.balance_real ?? 0);
  const totalEarned = sandbox ? (wallet?.total_earned_sandbox ?? 0) : (wallet?.total_earned_real ?? 0);

  res.json({
    user_id: userId,
    balance,
    total_earned: totalEarned,
    sandbox,
    // Cent-Standard: 100 pts = $1.00
    dollar_equivalent: (balance / 100).toFixed(2)
  });
}));

// ─── GET /history ─────────────────────────────────────────────────────────────
/**
 * Paginated ledger history.
 * Query params: page (default 1), limit (default 20, max 100)
 */
router.get('/history', requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.userId;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const pool = getPool();
  const sandbox = await isUserSandbox(pool, userId);

  const result = await pool.query(
    `SELECT id, event_type, points, balance_after, metadata, sandbox, created_at
     FROM mod_rewards.rewards_ledger
     WHERE user_id = $1
       AND sandbox = $2
     ORDER BY created_at DESC
     LIMIT $3 OFFSET $4`,
    [userId, sandbox, limit, offset]
  );

  const countResult = await pool.query(
    `SELECT COUNT(*) AS total
     FROM mod_rewards.rewards_ledger
     WHERE user_id = $1 AND sandbox = $2`,
    [userId, sandbox]
  );

  const total = parseInt(countResult.rows[0]?.total ?? 0);

  res.json({
    entries: result.rows,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit)
    },
    sandbox
  });
}));

// ─── GET /dashboard ───────────────────────────────────────────────────────────
/**
 * Full wallet dashboard data — used by /wallet.html.
 * Returns balance, streak, recent history, and stats in one call.
 */
router.get('/dashboard', requireAuth, asyncRoute(async (req, res) => {
  const userId = req.session.userId;
  const pool = getPool();

  // Ensure wallet exists
  await pool.query(
    `INSERT INTO mod_rewards.user_wallet (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  const sandbox = await isUserSandbox(pool, userId);

  // Wallet state
  const walletResult = await pool.query(
    `SELECT * FROM mod_rewards.user_wallet WHERE user_id = $1`,
    [userId]
  );
  const wallet = walletResult.rows[0];

  const balance = sandbox
    ? (wallet?.balance_sandbox ?? 0)
    : (wallet?.balance_real ?? 0);
  const totalEarned = sandbox
    ? (wallet?.total_earned_sandbox ?? 0)
    : (wallet?.total_earned_real ?? 0);

  // Recent history (last 20 entries)
  const historyResult = await pool.query(
    `SELECT id, event_type, points, balance_after, metadata, created_at
     FROM mod_rewards.rewards_ledger
     WHERE user_id = $1 AND sandbox = $2
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId, sandbox]
  );

  // Points earned this week
  const thisWeekStart = new Date();
  thisWeekStart.setUTCHours(0, 0, 0, 0);
  const dow = thisWeekStart.getUTCDay();
  thisWeekStart.setUTCDate(thisWeekStart.getUTCDate() - (dow === 0 ? 6 : dow - 1)); // Monday

  const weeklyResult = await pool.query(
    `SELECT COALESCE(SUM(points), 0) AS weekly_earned
     FROM mod_rewards.rewards_ledger
     WHERE user_id = $1
       AND sandbox = $2
       AND points > 0
       AND created_at >= $3`,
    [userId, sandbox, thisWeekStart.toISOString()]
  );
  const weeklyEarned = parseInt(weeklyResult.rows[0]?.weekly_earned ?? 0);

  // Check sync reward eligibility
  const lastSyncResult = await pool.query(
    `SELECT created_at FROM mod_rewards.rewards_ledger
     WHERE user_id = $1 AND event_type = 'sync_reward'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const lastSyncAt = lastSyncResult.rows[0]?.created_at || null;
  const syncEligible = !lastSyncAt ||
    (new Date() - new Date(lastSyncAt)) > 24 * 60 * 60 * 1000;

  // Human-readable event descriptions
  const EVENT_LABELS = {
    xp_mint: '⚡ XP Reward',
    sync_reward: '🔄 Sync Reward',
    streak_bonus: '🔥 Streak Bonus',
    mission_payout: '🎯 Mission Payout',
    spend: '💸 Points Spent',
    redeem: '🎁 Redeemed',
    admin_grant: '🛡️ Admin Grant'
  };

  const history = historyResult.rows.map(row => ({
    id: row.id,
    event_type: row.event_type,
    label: EVENT_LABELS[row.event_type] || `📋 ${row.event_type}`,
    points: row.points,
    balance_after: row.balance_after,
    metadata: row.metadata,
    created_at: row.created_at
  }));

  res.json({
    user_id: userId,
    sandbox,
    balance: {
      current: balance,
      total_earned: totalEarned,
      weekly_earned: weeklyEarned,
      dollar_equivalent: (balance / 100).toFixed(2)
    },
    streak: {
      current: wallet?.current_streak ?? 0,
      longest: wallet?.longest_streak ?? 0,
      last_activity_at: wallet?.last_activity_at || null,
      last_activity_week: wallet?.last_activity_week || null,
      current_week: isoWeekString(new Date())
    },
    sync: {
      eligible: syncEligible,
      last_sync_at: lastSyncAt,
      reward_points: 50
    },
    history,
    timestamp: new Date().toISOString()
  });
}));

// ─── Module Export ────────────────────────────────────────────────────────────
module.exports = {
  metadata: {
    name: 'The Wallet',
    description: 'Universal Rewards Ledger — Consistency Streak + Spendable Points. ALWAYS ON — open to all users.',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true,
    featureFlag: 'enabled', // NEVER preview_only — this is always on
    gating: 'NONE'
  },

  routes: router,
  aliasRouter: vaultRouter,
  aliasPath: '/api/vault',

  healthCheck: async (pool) => {
    try {
      const schemaCheck = await pool.query(
        `SELECT EXISTS(
           SELECT 1 FROM information_schema.schemata
           WHERE schema_name = 'mod_rewards'
         ) AS schema_exists`
      );
      const walletCount = await pool.query(
        `SELECT COUNT(*) AS count FROM mod_rewards.user_wallet`
      ).catch(() => ({ rows: [{ count: 0 }] }));
      const ledgerCount = await pool.query(
        `SELECT COUNT(*) AS count FROM mod_rewards.rewards_ledger`
      ).catch(() => ({ rows: [{ count: 0 }] }));

      return {
        module: 'mod_rewards',
        status: schemaCheck.rows[0]?.schema_exists ? 'ok' : 'schema_missing',
        version: '1.0.0',
        gating: 'NONE — always accessible',
        wallet_rows: parseInt(walletCount.rows[0]?.count ?? 0),
        ledger_entries: parseInt(ledgerCount.rows[0]?.count ?? 0),
        cent_standard: '100 pts = $1.00',
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return {
        module: 'mod_rewards',
        status: 'error',
        error: err.message,
        timestamp: new Date().toISOString()
      };
    }
  }
};
