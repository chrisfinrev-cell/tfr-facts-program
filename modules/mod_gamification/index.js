/**
 * mod_gamification — The Brain
 *
 * Gamification Engine for Financial Revolution.
 * Tracks lifetime_xp, Level (1–12), Identity Titles, and Structural Decay.
 *
 * Schema: mod_gamification (user_xp, xp_events, level_gates)
 *
 * Routes (mounted at /api/mod_gamification):
 *   GET  /health
 *   POST /xp/award
 *   GET  /user/:userId/status
 *   POST /admin/promote
 *   GET  /admin/user/:userId/audit
 *
 * Rules:
 *   - lifetime_xp NEVER decreases (not for spending, decay, or anything)
 *   - Spending points (The Wallet / mod_rewards) NEVER affects XP or Level
 *   - Buying a higher tier does NOT skip levels
 *   - Levels are PERMANENT — decay never reduces level or XP
 *   - decay_state only pauses XP multipliers and Wallet minting
 *
 * © T-Dagsis LLC. All rights reserved.
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const { asyncRoute } = require('../../module-error-boundary');

// ─── Admin allow-list ────────────────────────────────────────────────────────
// chris.finrev@gmail.com — sole admin. No other accounts have gamification admin access.
// Future Generations accounts (ecci2760, dianes3cps) get full gamification access
// (XP, levels, rewards, Sovereign Credits) but NOT admin controls.
const ADMIN_EMAILS = [
  'chris.finrev@gmail.com'
].map(e => e.toLowerCase());

function isAdmin(email) {
  return email && ADMIN_EMAILS.includes(email.toLowerCase());
}

// ─── DB Pool (lazy-init) ─────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return _pool;
}

// ─── Level Gates Cache ───────────────────────────────────────────────────────
let _levelGates = null;
async function getLevelGates() {
  if (_levelGates) return _levelGates;
  const pool = getPool();
  const result = await pool.query(
    `SELECT level, xp_threshold, identity_title, tier_required, gate_type
     FROM mod_gamification.level_gates
     ORDER BY level ASC`
  );
  _levelGates = result.rows;
  return _levelGates;
}

// ─── Tier Rank (for gate evaluation) ────────────────────────────────────────
// Higher index = higher tier
const TIER_RANK = { free: 0, elite: 1, business: 2, sovereignty: 3 };
function tierRank(tier) {
  return TIER_RANK[tier] ?? -1;
}

// ─── Subscription plan → normalized tier ────────────────────────────────────
function normalizeTier(subscriptionPlan) {
  if (!subscriptionPlan) return 'free';
  const p = subscriptionPlan.toLowerCase();
  if (p.includes('sovereignty') || p.includes('sovereign')) return 'sovereignty';
  if (p.includes('business')) return 'business';
  if (p.includes('elite')) return 'elite';
  return 'free';
}

// ─── Ensure user_xp row exists ───────────────────────────────────────────────
async function ensureUserXP(pool, userId) {
  await pool.query(
    `INSERT INTO mod_gamification.user_xp (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

// ─── Get current user XP row ─────────────────────────────────────────────────
async function getUserXPRow(pool, userId) {
  const result = await pool.query(
    `SELECT * FROM mod_gamification.user_xp WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

// ─── Level Promotion Logic ────────────────────────────────────────────────────
/**
 * Check if a user should be promoted based on:
 *   1. lifetime_xp ≥ next level's threshold
 *   2. User's subscription tier meets gate requirement
 *   3. Gate type allows auto-promotion (gate_type = 'auto' or 'plaid_verified' with sweep)
 *
 * For gate_type = 'document_upload' or 'admin_verified', we check
 * via metadata columns instead of auto-promoting.
 *
 * Returns the new level if promoted, null otherwise.
 */
async function checkLevelPromotion(pool, userId, lifetimeXP, currentLevel, subscriptionPlan) {
  if (currentLevel >= 12) return null;

  const gates = await getLevelGates();
  const nextGate = gates.find(g => g.level === currentLevel + 1);
  if (!nextGate) return null;

  // XP threshold check
  if (lifetimeXP < nextGate.xp_threshold) return null;

  // Tier check
  const userTier = normalizeTier(subscriptionPlan);
  if (tierRank(userTier) < tierRank(nextGate.tier_required)) return null;

  // Gate type check — only auto-promote for 'auto' gates
  // 'plaid_verified', 'document_upload', 'admin_verified' require external triggers
  if (nextGate.gate_type !== 'auto') return null;

  return nextGate.level;
}

// ─── Award XP (core logic) ───────────────────────────────────────────────────
async function awardXPInternal(pool, userId, eventType, xpAmount, metadata = {}) {
  await ensureUserXP(pool, userId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Insert XP event (immutable ledger)
    await client.query(
      `INSERT INTO mod_gamification.xp_events
         (user_id, event_type, xp_awarded, metadata)
       VALUES ($1, $2, $3, $4)`,
      [userId, eventType, xpAmount, JSON.stringify(metadata)]
    );

    // 2. Update lifetime_xp (NEVER decreases)
    await client.query(
      `UPDATE mod_gamification.user_xp
       SET lifetime_xp = lifetime_xp + $2,
           updated_at  = NOW()
       WHERE user_id = $1`,
      [userId, xpAmount]
    );

    // 3. Fetch updated row for level-check
    const xpResult = await client.query(
      `SELECT ux.*, u.subscription_plan
       FROM mod_gamification.user_xp ux
       JOIN users u ON u.id = ux.user_id
       WHERE ux.user_id = $1`,
      [userId]
    );
    const xpRow = xpResult.rows[0];

    // 4. Auto level-up check (only for gate_type = 'auto')
    let promotedToLevel = null;
    if (xpRow) {
      const newLevel = await checkLevelPromotion(
        client,
        userId,
        xpRow.lifetime_xp,
        xpRow.current_level,
        xpRow.subscription_plan
      );
      if (newLevel) {
        const gates = await getLevelGates();
        const gate = gates.find(g => g.level === newLevel);
        await client.query(
          `UPDATE mod_gamification.user_xp
           SET current_level  = $2,
               identity_title = $3,
               updated_at     = NOW()
           WHERE user_id = $1`,
          [userId, newLevel, gate.identity_title]
        );
        // Log level-up event
        await client.query(
          `INSERT INTO mod_gamification.xp_events
             (user_id, event_type, xp_awarded, metadata)
           VALUES ($1, 'level_up', 0, $2)`,
          [userId, JSON.stringify({ from_level: xpRow.current_level, to_level: newLevel, gate_type: gate.gate_type })]
        );
        promotedToLevel = newLevel;
      }
    }

    await client.query('COMMIT');

    // 5. Fire-and-forget: notify The Wallet mint endpoint
    // Decay pauses wallet minting — XP still records but no spendable points
    const decayState = xpRow?.decay_state || 'healthy';
    const mintPoints = decayState === 'decaying' ? 0 : xpAmount;
    if (mintPoints > 0) {
      const walletMintPayload = {
        userId,
        eventType,
        xpAwarded: mintPoints,
        decayState,
        metadata
      };
      notifyWalletMint(walletMintPayload).catch(err => {
        console.warn(`[mod_gamification] Wallet mint skipped: ${err.message}`);
      });
    }

    return {
      xpAwarded: xpAmount,
      lifetimeXP: xpRow ? Number(xpRow.lifetime_xp) + xpAmount : xpAmount,
      currentLevel: promotedToLevel || (xpRow?.current_level ?? 1),
      promotedToLevel,
      decayState: xpRow?.decay_state || 'healthy'
    };

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Wallet Mint Notification ────────────────────────────────────────────────
async function notifyWalletMint(payload) {
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${baseUrl}/api/mod_rewards/mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal': 'mod_gamification' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      console.warn(`[mod_gamification] Wallet mint returned ${res.status} — continuing`);
    }
  } catch (err) {
    // mod_rewards not deployed yet — expected, log and skip
    console.log(`[mod_gamification] Wallet mint unavailable (${err.message}) — logged, will retry when mod_rewards deploys`);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Decay Cron Job ───────────────────────────────────────────────────────────
// Runs every Sunday at 3:00 AM UTC
// Checks for users who haven't had a Friday Sweep in 3+ weeks
let cronScheduled = false;
function scheduleDecayCron() {
  if (process.env.POLSIA_IN_PROCESS_CRONS_ENABLED !== 'true') {
    console.log('[mod_gamification] Decay cron skipped: POLSIA_IN_PROCESS_CRONS_ENABLED != true');
    return;
  }
  if (cronScheduled) return;
  cronScheduled = true;

  cron.schedule('0 3 * * 0', async () => {
    console.log('[mod_gamification] Running weekly decay check...');
    const pool = getPool();
    if (!pool) { console.error('[mod_gamification] Decay cron skipped: pool unavailable'); return; }
    try {
      const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);

      // Mark users as 'decaying' if last_sweep_detected_at is null or > 3 weeks ago
      const decayResult = await pool.query(
        `UPDATE mod_gamification.user_xp
         SET decay_state      = 'decaying',
             decay_week_count = CASE
               WHEN last_sweep_detected_at IS NULL THEN decay_week_count + 1
               WHEN last_sweep_detected_at < $1     THEN decay_week_count + 1
               ELSE decay_week_count
             END,
             updated_at = NOW()
         WHERE (last_sweep_detected_at IS NULL OR last_sweep_detected_at < $1)
           AND decay_state != 'decaying'
         RETURNING user_id`,
        [threeWeeksAgo]
      );
      console.log(`[mod_gamification] Decay applied to ${decayResult.rowCount} users`);

      // Also increment decay_week_count for already-decaying users
      await pool.query(
        `UPDATE mod_gamification.user_xp
         SET decay_week_count = decay_week_count + 1,
             updated_at       = NOW()
         WHERE decay_state = 'decaying'
           AND (last_sweep_detected_at IS NULL OR last_sweep_detected_at < $1)`,
        [threeWeeksAgo]
      );

      console.log('[mod_gamification] Decay check complete.');
    } catch (err) {
      console.error('[mod_gamification] Decay cron error:', err.message);
    }
  });

  console.log('[mod_gamification] Decay cron scheduled (Sundays 03:00 UTC)');
}

// Schedule on module load
scheduleDecayCron();

// ─── Admin Middleware ─────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!isAdmin(req.session.userEmail || '')) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
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

/**
 * GET /api/mod_gamification/health
 */
router.get('/health', asyncRoute(async (req, res) => {
  const pool = getPool();
  const schemaCheck = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.schemata
       WHERE schema_name = 'mod_gamification'
     ) AS schema_exists`
  );
  const tablesCheck = await pool.query(
    `SELECT COUNT(*) AS table_count
     FROM information_schema.tables
     WHERE table_schema = 'mod_gamification'`
  );
  const levelGates = await getLevelGates().catch(() => []);

  res.json({
    status: 'ok',
    module: 'mod_gamification',
    version: '1.0.0',
    schema_exists: schemaCheck.rows[0]?.schema_exists,
    table_count: parseInt(tablesCheck.rows[0]?.table_count ?? 0),
    level_gates_loaded: levelGates.length,
    decay_cron: 'scheduled (Sundays 03:00 UTC)',
    timestamp: new Date().toISOString()
  });
}));

/**
 * POST /api/mod_gamification/xp/award
 *
 * Awards XP for a verified event. Inserts into xp_events, updates lifetime_xp.
 * Auto-promotes level if eligible (gate_type = 'auto' only).
 * Fires mint notification to The Wallet (graceful fallback if unavailable).
 *
 * Body: { userId, eventType, xpAmount, metadata? }
 * Auth: session or x-internal header (for module-to-module calls)
 */
router.post('/xp/award', asyncRoute(async (req, res) => {
  // Allow internal module-to-module calls via header
  const isInternal = req.headers['x-internal'];
  if (!isInternal && (!req.session || !req.session.userId)) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { userId, eventType, xpAmount, metadata } = req.body;

  if (!userId || !eventType || xpAmount == null) {
    return res.status(400).json({ error: 'userId, eventType, and xpAmount are required' });
  }
  if (typeof xpAmount !== 'number' || xpAmount < 0) {
    return res.status(400).json({ error: 'xpAmount must be a non-negative number' });
  }

  const pool = getPool();

  // Check decay state — if decaying, XP multipliers are paused (award still records but note it)
  await ensureUserXP(pool, userId);
  const xpRow = await getUserXPRow(pool, userId);
  const isDecaying = xpRow?.decay_state === 'decaying';

  // XP is still RECORDED even in decay (lifetime_xp never decreases)
  // Wallet mint is suppressed inside awardXPInternal when decaying
  const result = await awardXPInternal(pool, userId, eventType, xpAmount, metadata || {});

  res.json({
    success: true,
    ...result,
    decayWarning: isDecaying
      ? 'User is in decay state — XP recorded but wallet mint paused.'
      : null
  });
}));

/**
 * GET /api/mod_gamification/user/:userId/status
 *
 * Returns user's full gamification status.
 */
router.get('/user/:userId/status', requireAuth, asyncRoute(async (req, res) => {
  const pool = getPool();
  const userId = parseInt(req.params.userId, 10);

  // Users can only view their own status (admins can view anyone)
  if (req.session.userId !== userId && !isAdmin(req.session.userEmail || '')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await ensureUserXP(pool, userId);

  const result = await pool.query(
    `SELECT ux.*, u.subscription_plan
     FROM mod_gamification.user_xp ux
     JOIN users u ON u.id = ux.user_id
     WHERE ux.user_id = $1`,
    [userId]
  );

  if (!result.rows[0]) {
    return res.status(404).json({ error: 'User not found' });
  }

  const row = result.rows[0];
  const gates = await getLevelGates();
  const currentGate = gates.find(g => g.level === row.current_level);
  const nextGate = gates.find(g => g.level === row.current_level + 1);
  const lifetimeXP = Number(row.lifetime_xp);

  res.json({
    userId,
    lifetime_xp: lifetimeXP,
    current_level: row.current_level,
    identity_title: row.identity_title,
    decay_state: row.decay_state,
    decay_week_count: row.decay_week_count,
    last_sweep_detected_at: row.last_sweep_detected_at,
    tier_required: currentGate?.tier_required || 'free',
    next_level: nextGate ? nextGate.level : null,
    next_level_threshold: nextGate ? Number(nextGate.xp_threshold) : null,
    xp_to_next_level: nextGate ? Math.max(0, Number(nextGate.xp_threshold) - lifetimeXP) : 0,
    next_gate_type: nextGate?.gate_type || null,
    parent_user_id: row.parent_user_id
  });
}));

/**
 * POST /api/mod_gamification/admin/promote
 *
 * Admin-only manual level promotion (bypasses automation gates).
 * Used after Blueprint Strategy Call.
 *
 * Body: { userId, targetLevel, reason }
 */
router.post('/admin/promote', requireAdmin, asyncRoute(async (req, res) => {
  const { userId, targetLevel, reason } = req.body;

  if (!userId || !targetLevel || !reason) {
    return res.status(400).json({ error: 'userId, targetLevel, and reason are required' });
  }
  if (targetLevel < 1 || targetLevel > 12) {
    return res.status(400).json({ error: 'targetLevel must be between 1 and 12' });
  }

  const pool = getPool();
  await ensureUserXP(pool, userId);

  const gates = await getLevelGates();
  const gate = gates.find(g => g.level === targetLevel);
  if (!gate) {
    return res.status(400).json({ error: `No gate definition found for level ${targetLevel}` });
  }

  const xpRow = await getUserXPRow(pool, userId);
  if (!xpRow) {
    return res.status(404).json({ error: 'User not found' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update level + title
    await client.query(
      `UPDATE mod_gamification.user_xp
       SET current_level  = $2,
           identity_title = $3,
           updated_at     = NOW()
       WHERE user_id = $1`,
      [userId, targetLevel, gate.identity_title]
    );

    // Log admin promotion in xp_events (xp_awarded = 0 — admin doesn't award XP)
    await client.query(
      `INSERT INTO mod_gamification.xp_events
         (user_id, event_type, xp_awarded, metadata)
       VALUES ($1, 'admin_promotion', 0, $2)`,
      [userId, JSON.stringify({
        from_level: xpRow.current_level,
        to_level: targetLevel,
        reason,
        admin_email: req.session.userEmail,
        promoted_at: new Date().toISOString()
      })]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      userId,
      promoted_from: xpRow.current_level,
      promoted_to: targetLevel,
      identity_title: gate.identity_title,
      reason,
      admin: req.session.userEmail
    });

  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

/**
 * POST /api/mod_gamification/admin/verify-sweep
 *
 * Admin fallback: manually mark a Friday Sweep as verified for a user.
 * Used when Plaid isn't fully wired (stub for Phase 1).
 *
 * Body: { userId }
 */
router.post('/admin/verify-sweep', requireAdmin, asyncRoute(async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const pool = getPool();
  await ensureUserXP(pool, userId);

  await pool.query(
    `UPDATE mod_gamification.user_xp
     SET last_sweep_detected_at = NOW(),
         decay_state            = 'healthy',
         decay_week_count       = 0,
         updated_at             = NOW()
     WHERE user_id = $1`,
    [userId]
  );

  // Log sweep verification
  await pool.query(
    `INSERT INTO mod_gamification.xp_events
       (user_id, event_type, xp_awarded, metadata)
     VALUES ($1, 'sweep_verified_admin', 0, $2)`,
    [userId, JSON.stringify({ verified_by: req.session.userEmail, method: 'admin_manual' })]
  );

  res.json({ success: true, userId, sweep_verified_at: new Date().toISOString() });
}));

/**
 * GET /api/mod_gamification/admin/user/:userId/audit
 *
 * Full audit view: XP timeline, sweep history, decay state, all events.
 */
router.get('/admin/user/:userId/audit', requireAdmin, asyncRoute(async (req, res) => {
  const pool = getPool();
  const userId = parseInt(req.params.userId, 10);

  await ensureUserXP(pool, userId);

  // XP profile
  const profileResult = await pool.query(
    `SELECT ux.*, u.email, u.name, u.subscription_plan, u.subscription_status
     FROM mod_gamification.user_xp ux
     JOIN users u ON u.id = ux.user_id
     WHERE ux.user_id = $1`,
    [userId]
  );

  // Full XP event history
  const eventsResult = await pool.query(
    `SELECT id, event_type, xp_awarded, metadata, created_at
     FROM mod_gamification.xp_events
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 200`,
    [userId]
  );

  // Sweep history specifically
  const sweepsResult = await pool.query(
    `SELECT id, event_type, metadata, created_at
     FROM mod_gamification.xp_events
     WHERE user_id = $1
       AND event_type IN ('sweep_verified', 'sweep_verified_admin', 'friday_sweep_detected')
     ORDER BY created_at DESC`,
    [userId]
  );

  // Admin promotions
  const promotionsResult = await pool.query(
    `SELECT id, xp_awarded, metadata, created_at
     FROM mod_gamification.xp_events
     WHERE user_id = $1 AND event_type = 'admin_promotion'
     ORDER BY created_at DESC`,
    [userId]
  );

  const profile = profileResult.rows[0];
  const gates = await getLevelGates();
  const currentGate = gates.find(g => g.level === profile?.current_level);
  const nextGate = gates.find(g => g.level === (profile?.current_level ?? 0) + 1);
  const lifetimeXP = profile ? Number(profile.lifetime_xp) : 0;

  res.json({
    profile: profile ? {
      user_id: userId,
      email: profile.email,
      name: profile.name,
      subscription_plan: profile.subscription_plan,
      subscription_status: profile.subscription_status,
      lifetime_xp: lifetimeXP,
      current_level: profile.current_level,
      identity_title: profile.identity_title,
      decay_state: profile.decay_state,
      decay_week_count: profile.decay_week_count,
      last_sweep_detected_at: profile.last_sweep_detected_at,
      tier_required: currentGate?.tier_required,
      next_level: nextGate?.level,
      xp_to_next_level: nextGate ? Math.max(0, Number(nextGate.xp_threshold) - lifetimeXP) : 0,
      next_gate_type: nextGate?.gate_type,
      parent_user_id: profile.parent_user_id
    } : null,
    xp_events: eventsResult.rows,
    sweep_history: sweepsResult.rows,
    admin_promotions: promotionsResult.rows,
    level_gates: gates
  });
}));

/**
 * GET /api/mod_gamification/admin/dashboard
 *
 * Admin dashboard: summary stats for all users.
 * Active subscribers by tier, decay counts, top XP earners.
 */
router.get('/admin/dashboard', requireAdmin, asyncRoute(async (req, res) => {
  const pool = getPool();

  // Level distribution
  const levelDistResult = await pool.query(
    `SELECT current_level, COUNT(*) AS user_count
     FROM mod_gamification.user_xp
     GROUP BY current_level
     ORDER BY current_level ASC`
  );

  // Decay state distribution
  const decayResult = await pool.query(
    `SELECT decay_state, COUNT(*) AS user_count
     FROM mod_gamification.user_xp
     GROUP BY decay_state`
  );

  // Top XP earners
  const topEarnersResult = await pool.query(
    `SELECT ux.user_id, u.email, u.name, ux.lifetime_xp, ux.current_level, ux.identity_title
     FROM mod_gamification.user_xp ux
     JOIN users u ON u.id = ux.user_id
     ORDER BY ux.lifetime_xp DESC
     LIMIT 20`
  );

  // Recent XP events
  const recentEventsResult = await pool.query(
    `SELECT e.user_id, u.email, e.event_type, e.xp_awarded, e.created_at
     FROM mod_gamification.xp_events e
     JOIN users u ON u.id = e.user_id
     ORDER BY e.created_at DESC
     LIMIT 50`
  );

  // Active subscribers by tier (from users table)
  const tierResult = await pool.query(
    `SELECT
       CASE
         WHEN subscription_plan ILIKE '%sovereignty%' OR subscription_plan ILIKE '%sovereign%' THEN 'Sovereignty'
         WHEN subscription_plan ILIKE '%business%'  THEN 'Business'
         WHEN subscription_plan ILIKE '%elite%'     THEN 'Elite'
         ELSE 'Free'
       END AS tier,
       COUNT(*) AS count
     FROM users
     WHERE subscription_status IN ('active','trialing') OR subscription_plan IS NULL
     GROUP BY tier
     ORDER BY tier`
  );

  res.json({
    level_distribution: levelDistResult.rows,
    decay_distribution: decayResult.rows,
    top_earners: topEarnersResult.rows,
    recent_events: recentEventsResult.rows,
    tier_distribution: tierResult.rows,
    timestamp: new Date().toISOString()
  });
}));

/**
 * GET /api/mod_gamification/family/:userId
 *
 * Layer 3 stub — family relationship view.
 * Returns guardian and linked juniors based on guardian_id FK.
 * Phase 2: this endpoint will be redirected to /api/users/:userId/family
 *          after a call-site swap in the legacy server.
 *
 * Full implementation ships with Layer 3 (Junior Revolutionaries).
 * Returns empty/stub results safely for now.
 */
router.get('/family/:userId', requireAuth, asyncRoute(async (req, res) => {
  const pool = getPool();
  const userId = parseInt(req.params.userId, 10);

  // Users can only view their own family (admins can view anyone)
  if (req.session.userId !== userId && !isAdmin(req.session.userEmail || '')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Check if guardian_id column exists (schema may not be migrated yet)
  const colCheck = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'guardian_id'`
  ).catch(() => ({ rows: [] }));

  if (!colCheck.rows.length) {
    // Schema not migrated yet — return empty stub safely
    return res.json({
      user_id: userId,
      guardian: null,
      juniors: [],
      _stub: true,
      _note: 'Layer 3 schema not yet deployed. Run migrations to enable full family linking.'
    });
  }

  // User's own profile + role
  const userResult = await pool.query(
    `SELECT id, email, name, user_role, guardian_id, sandbox_mode, can_receive_sweep
     FROM users WHERE id = $1`,
    [userId]
  );
  const user = userResult.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Guardian (if this user is a junior)
  let guardian = null;
  if (user.guardian_id) {
    const guardianResult = await pool.query(
      `SELECT id, email, name, user_role FROM users WHERE id = $1`,
      [user.guardian_id]
    );
    guardian = guardianResult.rows[0] || null;
  }

  // Juniors linked to this user (if this user is an architect/guardian)
  const juniorsResult = await pool.query(
    `SELECT id, email, name, user_role, sandbox_mode, can_receive_sweep
     FROM users WHERE guardian_id = $1`,
    [userId]
  );

  res.json({
    user_id: userId,
    user_role: user.user_role || 'user',
    sandbox_mode: user.sandbox_mode || false,
    can_receive_sweep: user.can_receive_sweep || false,
    guardian: guardian || null,
    juniors: juniorsResult.rows || []
  });
}));

// ─── Module Export ────────────────────────────────────────────────────────────
module.exports = {
  metadata: {
    name: 'Gamification',
    description: 'The Brain — XP, Levels (1–12), Identity Titles, Structural Decay',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true,
    featureFlag: 'preview_only'
  },

  routes: router,

  healthCheck: async (pool) => {
    try {
      const schemaCheck = await pool.query(
        `SELECT EXISTS(
           SELECT 1 FROM information_schema.schemata
           WHERE schema_name = 'mod_gamification'
         ) AS schema_exists`
      );
      const levelGateCount = await pool.query(
        `SELECT COUNT(*) AS count FROM mod_gamification.level_gates`
      ).catch(() => ({ rows: [{ count: 0 }] }));

      return {
        module: 'mod_gamification',
        status: schemaCheck.rows[0]?.schema_exists ? 'ok' : 'schema_missing',
        version: '1.0.0',
        level_gates: parseInt(levelGateCount.rows[0]?.count ?? 0),
        decay_cron: 'scheduled',
        timestamp: new Date().toISOString()
      };
    } catch (err) {
      return {
        module: 'mod_gamification',
        status: 'error',
        error: err.message,
        timestamp: new Date().toISOString()
      };
    }
  }
};
