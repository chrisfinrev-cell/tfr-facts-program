/**
 * mod_ssc — Shopping Calculator Ecosystem
 *
 * Part 1: Ultimate Shopping Calculator (public/free lead magnet)
 *   - NEEDS/WANTS/TIPS entry with shadow-mapping to FACTS buckets
 *   - Local session management with cloud-sync on auth
 *   - XP Vault (locked potential points)
 *   - Onboarding gate (phone/email required to save)
 *
 * Part 2: SSC — Sovereign Shopping Calculator (Sovereignty tier)
 *   - All 6 FACTS pillars active
 *   - T-Dagsis Digital Ledger with full audit trail
 *   - Sovereign HUD: XP bar + capacity bars per bucket
 *   - Dynamic funding sources from user profile
 *   - Data migration from Ultimate → SSC (permission toggle)
 *
 * Schema: mod_ssc
 *
 * Routes (mounted at /api/mod_ssc):
 *   GET  /health
 *
 *   — Ultimate Calculator —
 *   POST /session/start        — create/resume a shopping session
 *   POST /session/item         — add a line item (NEEDS/WANTS/TIPS)
 *   DELETE /session/item/:id   — remove a line item
 *   GET  /session/:key         — get session summary
 *   POST /session/finalize     — finalize + save (requires auth)
 *   GET  /xp-vault             — locked XP for current user
 *
 *   — SSC / T-Dagsis Ledger —
 *   GET  /status               — tier check
 *   POST /entry                — create ledger entry (Sovereignty only)
 *   GET  /entries              — paginated ledger history
 *   PATCH /entry/:id           — edit (recorded in audit log)
 *   DELETE /entry/:id          — soft-delete
 *   GET  /capacity             — remaining monthly capacity per bucket
 *
 *   — Funding Sources —
 *   GET  /funding-sources      — user's configured accounts
 *   POST /funding-sources      — add a funding source
 *   PATCH /funding-sources/:id — edit label
 *   DELETE /funding-sources/:id — deactivate
 *
 *   — Migration —
 *   POST /migrate              — Ultimate → SSC permission toggle
 *
 * © T-Dagsis LLC. All rights reserved.
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const { asyncRoute } = require('../../module-error-boundary');
const { getMonthlyBucketDepositsCents } = require('../../db/bucket-deposits');

// ─── DB Pool ──────────────────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function requireAuth(req, res) {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  return true;
}

function optionalAuth(req) {
  return req.session?.userId || null;
}

// ─── Tier helpers ─────────────────────────────────────────────────────────────
const TIER_RANK = { free: 0, elite: 1, business: 2, sovereignty: 3 };

function normalizeTier(plan) {
  if (!plan) return 'free';
  const p = (plan || '').toLowerCase();
  if (p.includes('sovereignty') || p.includes('sovereign')) return 'sovereignty';
  if (p.includes('business')) return 'business';
  if (p.includes('elite')) return 'elite';
  if (p.includes('pro')) return 'elite'; // treat pro as elite for SSC access
  return 'free';
}

function tierRank(tier) {
  return TIER_RANK[tier] ?? -1;
}

async function getUserTier(pool, userId) {
  const { rows } = await pool.query(
    `SELECT pricing_tier, subscription_tier, plan FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0]) return 'free';
  const u = rows[0];
  const raw = u.pricing_tier || u.subscription_tier || u.plan || '';
  return normalizeTier(raw);
}

// ─── Shadow mapping ───────────────────────────────────────────────────────────
// Maps Ultimate Calculator categories to FACTS 2.0 buckets
const SHADOW_MAP = {
  needs: 'necessities',
  wants: 'lifestyle',
  tips: 'legacy'
};

// Maps SSC pillars (already FACTS 2.0)
const SSC_PILLARS = ['necessities', 'reserve', 'velocity', 'growth', 'lifestyle', 'legacy'];

// ─── XP calculation ───────────────────────────────────────────────────────────
// 1 XP per $1 spent (Cent-Standard: 100 locked XP per dollar = 1 pt on unlock)
function calcPotentialXp(totalCents) {
  return Math.floor(totalCents / 100);  // 1 XP per dollar
}

// ─── Category slug lookup ─────────────────────────────────────────────────────
async function getCategoryId(pool, bucketSlug) {
  const { rows } = await pool.query(
    `SELECT id FROM categories WHERE slug = $1 LIMIT 1`,
    [bucketSlug]
  );
  return rows[0]?.id || null;
}

// ─── Capacity calculation ─────────────────────────────────────────────────────
async function getBucketCapacity(pool, userId) {
  const depositedByBucket = await getMonthlyBucketDepositsCents(pool, userId);

  const spentResult = await pool.query(
    `SELECT bucket, COALESCE(SUM(total_cents), 0)::INTEGER as spent_cents
     FROM mod_ssc.t_dagsis_ledger
     WHERE user_id = $1
       AND is_deleted = false
       AND DATE_TRUNC('month', transaction_date) = DATE_TRUNC('month', CURRENT_DATE)
     GROUP BY bucket`,
    [userId]
  );

  const spentByBucket = {};
  for (const row of spentResult.rows) {
    spentByBucket[row.bucket] = parseInt(row.spent_cents, 10);
  }

  const capacity = {};
  let totalDepositedCents = 0;

  for (const pillar of SSC_PILLARS) {
    const budgetCents = depositedByBucket[pillar] || 0;
    totalDepositedCents += budgetCents;
    const spentCents = spentByBucket[pillar] || 0;
    const remainingCents = Math.max(0, budgetCents - spentCents);
    const usedPct = budgetCents > 0
      ? Math.min(100, Math.round((spentCents / budgetCents) * 100))
      : 0;

    capacity[pillar] = {
      budget_cents: budgetCents,
      deposited_cents: budgetCents,
      spent_cents: spentCents,
      remaining_cents: remainingCents,
      used_pct: usedPct,
      color: usedPct >= 90 ? 'red' : usedPct >= 70 ? 'yellow' : 'green'
    };
  }

  return {
    total_deposited_cents: totalDepositedCents,
    monthly_income_cents: totalDepositedCents,
    capacity
  };
}

// ─── Router ───────────────────────────────────────────────────────────────────
const router = express.Router();

// ── Health ─────────────────────────────────────────────────────────────────────
router.get('/health', asyncRoute(async (req, res) => {
  const pool = getPool();
  await pool.query('SELECT 1 FROM mod_ssc.t_dagsis_ledger LIMIT 0');
  res.json({ status: 'ok', module: 'mod_ssc', version: '1.0.0' });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// PART 1: ULTIMATE CALCULATOR — Session Management
// ═══════════════════════════════════════════════════════════════════════════════

// POST /session/start — create or resume a session
router.post('/session/start', asyncRoute(async (req, res) => {
  const pool = getPool();
  const userId = optionalAuth(req);
  const { session_key, tax_rate_bps } = req.body;

  if (!session_key || typeof session_key !== 'string' || session_key.length > 128) {
    return res.status(400).json({ error: 'session_key required (max 128 chars)' });
  }

  // Try to find existing open session
  const existing = await pool.query(
    `SELECT * FROM mod_ssc.shopping_sessions WHERE session_key = $1 AND status = 'open' LIMIT 1`,
    [session_key]
  );

  if (existing.rows[0]) {
    // If user is now logged in, associate the session
    if (userId && !existing.rows[0].user_id) {
      await pool.query(
        `UPDATE mod_ssc.shopping_sessions SET user_id = $1, updated_at = NOW() WHERE session_key = $2`,
        [userId, session_key]
      );
    }
    return res.json({ session_key, existing: true, session: existing.rows[0] });
  }

  // Create new session
  const taxRate = Math.min(Math.max(parseInt(tax_rate_bps || 875), 0), 2000);
  const { rows } = await pool.query(
    `INSERT INTO mod_ssc.shopping_sessions
       (session_key, user_id, tax_rate_bps, status)
     VALUES ($1, $2, $3, 'open')
     RETURNING *`,
    [session_key, userId, taxRate]
  );

  res.json({ session_key, existing: false, session: rows[0] });
}));

// POST /session/item — add a line item
router.post('/session/item', asyncRoute(async (req, res) => {
  const pool = getPool();
  const { session_key, label, amount_cents, category, tax_override } = req.body;

  if (!session_key) return res.status(400).json({ error: 'session_key required' });
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
    return res.status(400).json({ error: 'amount_cents must be a positive integer' });
  }
  const cat = (category || '').toLowerCase();
  if (!['needs', 'wants', 'tips'].includes(cat)) {
    return res.status(400).json({ error: 'category must be needs|wants|tips' });
  }

  // Get session
  const sessionResult = await pool.query(
    `SELECT * FROM mod_ssc.shopping_sessions WHERE session_key = $1 AND status = 'open' LIMIT 1`,
    [session_key]
  );
  if (!sessionResult.rows[0]) {
    return res.status(404).json({ error: 'Session not found or already closed' });
  }
  const session = sessionResult.rows[0];

  // Calculate tax
  const applyTax = tax_override !== undefined ? !!tax_override : session.tax_enabled;
  const taxAmountCents = applyTax ? Math.round(amount_cents * session.tax_rate_bps / 10000) : 0;

  const bucketShadow = SHADOW_MAP[cat];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert item
    const itemResult = await client.query(
      `INSERT INTO mod_ssc.shopping_items
         (session_id, label, amount_cents, category, bucket_shadow, tax_applied, tax_amount_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [session.id, label || null, amount_cents, cat, bucketShadow, applyTax, taxAmountCents]
    );

    // Update session totals
    const totalsResult = await client.query(
      `SELECT
         COALESCE(SUM(amount_cents), 0)::INTEGER as subtotal,
         COALESCE(SUM(tax_amount_cents), 0)::INTEGER as total_tax
       FROM mod_ssc.shopping_items WHERE session_id = $1`,
      [session.id]
    );
    const subtotalCents = totalsResult.rows[0].subtotal;
    const taxCents = totalsResult.rows[0].total_tax;

    // Get tip from session
    const tipCents = session.tip_cents || 0;
    const totalCents = subtotalCents + taxCents + tipCents;
    const xpLocked = calcPotentialXp(totalCents);

    await client.query(
      `UPDATE mod_ssc.shopping_sessions
       SET subtotal_cents = $1, total_cents = $2, xp_locked = $3, updated_at = NOW()
       WHERE id = $4`,
      [subtotalCents, totalCents, xpLocked, session.id]
    );

    await client.query('COMMIT');

    res.json({
      item: itemResult.rows[0],
      session: {
        subtotal_cents: subtotalCents,
        tax_cents: taxCents,
        tip_cents: tipCents,
        total_cents: totalCents,
        xp_locked: xpLocked
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// DELETE /session/item/:id — remove a line item
router.delete('/session/item/:id', asyncRoute(async (req, res) => {
  const pool = getPool();
  const { session_key } = req.body;
  const itemId = parseInt(req.params.id);

  if (!session_key) return res.status(400).json({ error: 'session_key required' });

  const sessionResult = await pool.query(
    `SELECT s.* FROM mod_ssc.shopping_sessions s
     JOIN mod_ssc.shopping_items i ON i.session_id = s.id
     WHERE s.session_key = $1 AND i.id = $2 AND s.status = 'open' LIMIT 1`,
    [session_key, itemId]
  );
  if (!sessionResult.rows[0]) {
    return res.status(404).json({ error: 'Item or session not found' });
  }
  const session = sessionResult.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM mod_ssc.shopping_items WHERE id = $1`, [itemId]);

    const totalsResult = await client.query(
      `SELECT
         COALESCE(SUM(amount_cents), 0)::INTEGER as subtotal,
         COALESCE(SUM(tax_amount_cents), 0)::INTEGER as total_tax
       FROM mod_ssc.shopping_items WHERE session_id = $1`,
      [session.id]
    );
    const subtotalCents = totalsResult.rows[0].subtotal;
    const taxCents = totalsResult.rows[0].total_tax;
    const tipCents = session.tip_cents || 0;
    const totalCents = subtotalCents + taxCents + tipCents;
    const xpLocked = calcPotentialXp(totalCents);

    await client.query(
      `UPDATE mod_ssc.shopping_sessions
       SET subtotal_cents = $1, total_cents = $2, xp_locked = $3, updated_at = NOW()
       WHERE id = $4`,
      [subtotalCents, totalCents, xpLocked, session.id]
    );

    await client.query('COMMIT');
    res.json({ deleted: true, session: { subtotal_cents: subtotalCents, total_cents: totalCents, xp_locked: xpLocked } });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// PATCH /session/tip — update tip
router.patch('/session/tip', asyncRoute(async (req, res) => {
  const pool = getPool();
  const { session_key, tip_cents } = req.body;

  if (!session_key) return res.status(400).json({ error: 'session_key required' });
  if (!Number.isInteger(tip_cents) || tip_cents < 0) {
    return res.status(400).json({ error: 'tip_cents must be a non-negative integer' });
  }

  const sessionResult = await pool.query(
    `SELECT * FROM mod_ssc.shopping_sessions WHERE session_key = $1 AND status = 'open' LIMIT 1`,
    [session_key]
  );
  if (!sessionResult.rows[0]) return res.status(404).json({ error: 'Session not found' });
  const session = sessionResult.rows[0];

  const totalCents = session.subtotal_cents + (session.subtotal_cents > 0 ?
    Math.round(session.subtotal_cents * session.tax_rate_bps / 10000 * (session.tax_enabled ? 1 : 0)) : 0)
    + tip_cents;
  // Recalculate from items
  const totalsResult = await pool.query(
    `SELECT
       COALESCE(SUM(amount_cents), 0)::INTEGER as subtotal,
       COALESCE(SUM(tax_amount_cents), 0)::INTEGER as total_tax
     FROM mod_ssc.shopping_items WHERE session_id = $1`,
    [session.id]
  );
  const subtotalCents = totalsResult.rows[0].subtotal;
  const taxCents = totalsResult.rows[0].total_tax;
  const newTotal = subtotalCents + taxCents + tip_cents;
  const xpLocked = calcPotentialXp(newTotal);

  await pool.query(
    `UPDATE mod_ssc.shopping_sessions
     SET tip_cents = $1, total_cents = $2, xp_locked = $3, updated_at = NOW()
     WHERE id = $4`,
    [tip_cents, newTotal, xpLocked, session.id]
  );

  res.json({ tip_cents, total_cents: newTotal, xp_locked: xpLocked });
}));

// PATCH /session/tax — toggle tax
router.patch('/session/tax', asyncRoute(async (req, res) => {
  const pool = getPool();
  const { session_key, tax_enabled, tax_rate_bps } = req.body;

  if (!session_key) return res.status(400).json({ error: 'session_key required' });

  const sessionResult = await pool.query(
    `SELECT * FROM mod_ssc.shopping_sessions WHERE session_key = $1 AND status = 'open' LIMIT 1`,
    [session_key]
  );
  if (!sessionResult.rows[0]) return res.status(404).json({ error: 'Session not found' });
  const session = sessionResult.rows[0];

  const newTaxEnabled = tax_enabled !== undefined ? !!tax_enabled : !session.tax_enabled;
  const newTaxRate = tax_rate_bps !== undefined ? Math.min(Math.max(parseInt(tax_rate_bps), 0), 2000) : session.tax_rate_bps;

  // Recalculate tax on all items
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE mod_ssc.shopping_items
       SET tax_applied = $1,
           tax_amount_cents = CASE WHEN $1 THEN ROUND(amount_cents * $2::NUMERIC / 10000) ELSE 0 END
       WHERE session_id = $3`,
      [newTaxEnabled, newTaxRate, session.id]
    );

    const totalsResult = await client.query(
      `SELECT
         COALESCE(SUM(amount_cents), 0)::INTEGER as subtotal,
         COALESCE(SUM(tax_amount_cents), 0)::INTEGER as total_tax
       FROM mod_ssc.shopping_items WHERE session_id = $1`,
      [session.id]
    );
    const subtotalCents = totalsResult.rows[0].subtotal;
    const taxCents = totalsResult.rows[0].total_tax;
    const totalCents = subtotalCents + taxCents + (session.tip_cents || 0);
    const xpLocked = calcPotentialXp(totalCents);

    await client.query(
      `UPDATE mod_ssc.shopping_sessions
       SET tax_enabled = $1, tax_rate_bps = $2, subtotal_cents = $3,
           total_cents = $4, xp_locked = $5, updated_at = NOW()
       WHERE id = $6`,
      [newTaxEnabled, newTaxRate, subtotalCents, totalCents, xpLocked, session.id]
    );

    await client.query('COMMIT');
    res.json({ tax_enabled: newTaxEnabled, tax_rate_bps: newTaxRate, total_cents: totalCents });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// GET /session/:key — get session summary
router.get('/session/:key', asyncRoute(async (req, res) => {
  const pool = getPool();
  const sessionKey = req.params.key;

  const sessionResult = await pool.query(
    `SELECT * FROM mod_ssc.shopping_sessions WHERE session_key = $1 LIMIT 1`,
    [sessionKey]
  );
  if (!sessionResult.rows[0]) return res.status(404).json({ error: 'Session not found' });
  const session = sessionResult.rows[0];

  const itemsResult = await pool.query(
    `SELECT * FROM mod_ssc.shopping_items WHERE session_id = $1 ORDER BY created_at ASC`,
    [session.id]
  );

  // Group by shadow bucket
  const bucketSummary = {};
  for (const item of itemsResult.rows) {
    if (!bucketSummary[item.bucket_shadow]) {
      bucketSummary[item.bucket_shadow] = { count: 0, total_cents: 0 };
    }
    bucketSummary[item.bucket_shadow].count++;
    bucketSummary[item.bucket_shadow].total_cents += item.amount_cents + item.tax_amount_cents;
  }

  res.json({
    session,
    items: itemsResult.rows,
    bucket_summary: bucketSummary
  });
}));

// POST /session/finalize — finalize and save session (requires auth)
router.post('/session/finalize', asyncRoute(async (req, res) => {
  const pool = getPool();
  const userId = optionalAuth(req);
  if (!userId) {
    return res.status(401).json({ error: 'Authentication required to save history', requires_auth: true });
  }

  const { session_key, merchant } = req.body;
  if (!session_key) return res.status(400).json({ error: 'session_key required' });

  const sessionResult = await pool.query(
    `SELECT * FROM mod_ssc.shopping_sessions WHERE session_key = $1 AND status = 'open' LIMIT 1`,
    [session_key]
  );
  if (!sessionResult.rows[0]) return res.status(404).json({ error: 'Session not found' });
  const session = sessionResult.rows[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Associate session with user
    await client.query(
      `UPDATE mod_ssc.shopping_sessions
       SET user_id = $1, status = 'saved', updated_at = NOW()
       WHERE id = $2`,
      [userId, session.id]
    );

    // Accumulate XP vault
    if (session.xp_locked > 0) {
      await client.query(
        `INSERT INTO mod_ssc.xp_vault (user_id, locked_points)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE
         SET locked_points = mod_ssc.xp_vault.locked_points + $2,
             updated_at = NOW()`,
        [userId, session.xp_locked]
      );
    }

    // Track SSC onboarding
    await client.query(
      `UPDATE users SET ssc_onboarded_at = COALESCE(ssc_onboarded_at, NOW()) WHERE id = $1`,
      [userId]
    );

    await client.query('COMMIT');

    res.json({
      finalized: true,
      xp_locked: session.xp_locked,
      total_cents: session.total_cents
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// GET /xp-vault — locked XP for current user
router.get('/xp-vault', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const { rows } = await pool.query(
    `SELECT * FROM mod_ssc.xp_vault WHERE user_id = $1`,
    [userId]
  );

  const vault = rows[0] || { locked_points: 0, converted_at: null };
  res.json({
    locked_points: vault.locked_points || 0,
    is_locked: !vault.converted_at,
    converted_at: vault.converted_at || null,
    spendable_if_unlocked: Math.floor((vault.locked_points || 0) / 100)
  });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// PART 2: SSC / T-DAGSIS LEDGER
// ═══════════════════════════════════════════════════════════════════════════════

// GET /status — tier check
router.get('/status', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const tier = await getUserTier(pool, userId);
  const hasSSCAccess = tierRank(tier) >= tierRank('sovereignty');

  let xpVault = null;
  if (req.session.userId) {
    const vault = await pool.query(
      `SELECT locked_points, converted_at FROM mod_ssc.xp_vault WHERE user_id = $1`,
      [userId]
    );
    if (vault.rows[0]) {
      xpVault = {
        locked_points: vault.rows[0].locked_points,
        is_locked: !vault.rows[0].converted_at
      };
    }
  }

  res.json({
    tier,
    has_ssc_access: hasSSCAccess,
    upgrade_required: !hasSSCAccess,
    xp_vault: xpVault
  });
}));

// POST /entry — create a ledger entry (Sovereignty tier)
router.post('/entry', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const tier = await getUserTier(pool, userId);
  if (tierRank(tier) < tierRank('sovereignty')) {
    return res.status(403).json({
      error: 'Sovereignty tier required for SSC',
      tier,
      upgrade_url: '/pricing.html'
    });
  }

  const {
    merchant, description, transaction_date,
    subtotal_cents, tax_cents, tip_cents,
    bucket, allocation_pct,
    funding_source_id, tax_enabled, tax_rate_bps,
    session_id
  } = req.body;

  // Validate
  if (!Number.isInteger(subtotal_cents) || subtotal_cents <= 0) {
    return res.status(400).json({ error: 'subtotal_cents must be a positive integer' });
  }
  const bucketNorm = (bucket || '').toLowerCase();
  if (!SSC_PILLARS.includes(bucketNorm)) {
    return res.status(400).json({ error: `bucket must be one of: ${SSC_PILLARS.join('|')}` });
  }

  const taxCentsVal = Math.max(0, parseInt(tax_cents || 0));
  const tipCentsVal = Math.max(0, parseInt(tip_cents || 0));
  const totalCents = subtotal_cents + taxCentsVal + tipCentsVal;

  // Get funding source label
  let fundingLabel = null;
  if (funding_source_id) {
    const fsResult = await pool.query(
      `SELECT label FROM mod_ssc.funding_sources WHERE id = $1 AND user_id = $2 AND is_active = true`,
      [funding_source_id, userId]
    );
    fundingLabel = fsResult.rows[0]?.label || null;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO mod_ssc.t_dagsis_ledger
         (user_id, session_id, merchant, description, transaction_date,
          subtotal_cents, tax_cents, tip_cents, total_cents,
          bucket, allocation_pct,
          funding_source_id, funding_label,
          tax_enabled, tax_rate_bps)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        userId,
        session_id || null,
        merchant || null,
        description || null,
        transaction_date || new Date().toISOString().split('T')[0],
        subtotal_cents, taxCentsVal, tipCentsVal, totalCents,
        bucketNorm,
        Math.min(100, Math.max(1, parseInt(allocation_pct || 100))),
        funding_source_id || null, fundingLabel,
        !!tax_enabled,
        parseInt(tax_rate_bps || 875)
      ]
    );

    const entry = rows[0];

    // Audit log
    await client.query(
      `INSERT INTO mod_ssc.ledger_audit_log (ledger_id, user_id, action)
       VALUES ($1, $2, 'created')`,
      [entry.id, userId]
    );

    // Award XP via mod_rewards if available
    const xpPoints = calcPotentialXp(totalCents);
    if (xpPoints > 0) {
      await pool.query(
        `INSERT INTO mod_ssc.xp_vault (user_id, locked_points, converted_at)
         VALUES ($1, 0, NOW())
         ON CONFLICT (user_id) DO NOTHING`,
        [userId]
      ).catch(() => {});
    }

    await client.query('COMMIT');
    res.status(201).json({ entry });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// GET /entries — paginated ledger history
router.get('/entries', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const tier = await getUserTier(pool, userId);
  if (tierRank(tier) < tierRank('sovereignty')) {
    return res.status(403).json({ error: 'Sovereignty tier required', upgrade_url: '/pricing.html' });
  }

  const page = Math.max(1, parseInt(req.query.page || 1));
  const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page || 25)));
  const offset = (page - 1) * perPage;
  const bucket = req.query.bucket || null;
  const month = req.query.month || null; // YYYY-MM

  let whereClause = `WHERE l.user_id = $1 AND l.is_deleted = false`;
  const params = [userId];
  let paramIdx = 2;

  if (bucket) {
    whereClause += ` AND l.bucket = $${paramIdx}`;
    params.push(bucket);
    paramIdx++;
  }
  if (month) {
    whereClause += ` AND TO_CHAR(l.transaction_date, 'YYYY-MM') = $${paramIdx}`;
    params.push(month);
    paramIdx++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM mod_ssc.t_dagsis_ledger l ${whereClause}`,
    params
  );
  const totalCount = parseInt(countResult.rows[0].count);

  params.push(perPage, offset);
  const { rows } = await pool.query(
    `SELECT l.*, fs.label as fs_label
     FROM mod_ssc.t_dagsis_ledger l
     LEFT JOIN mod_ssc.funding_sources fs ON fs.id = l.funding_source_id
     ${whereClause}
     ORDER BY l.transaction_date DESC, l.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    params
  );

  res.json({
    entries: rows,
    pagination: { page, per_page: perPage, total: totalCount, pages: Math.ceil(totalCount / perPage) }
  });
}));

// PATCH /entry/:id — edit ledger entry
router.patch('/entry/:id', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const entryId = parseInt(req.params.id);

  const tier = await getUserTier(pool, userId);
  if (tierRank(tier) < tierRank('sovereignty')) {
    return res.status(403).json({ error: 'Sovereignty tier required' });
  }

  const { rows: existing } = await pool.query(
    `SELECT * FROM mod_ssc.t_dagsis_ledger WHERE id = $1 AND user_id = $2 AND is_deleted = false`,
    [entryId, userId]
  );
  if (!existing[0]) return res.status(404).json({ error: 'Entry not found' });
  const entry = existing[0];

  const { merchant, description, bucket, funding_source_id } = req.body;
  const updates = [];
  const auditLogs = [];
  const params = [];
  let idx = 1;

  if (merchant !== undefined && merchant !== entry.merchant) {
    updates.push(`merchant = $${idx++}`);
    params.push(merchant);
    auditLogs.push({ field: 'merchant', old: entry.merchant, new: merchant });
  }
  if (description !== undefined && description !== entry.description) {
    updates.push(`description = $${idx++}`);
    params.push(description);
    auditLogs.push({ field: 'description', old: entry.description, new: description });
  }
  if (bucket !== undefined) {
    const bucketNorm = bucket.toLowerCase();
    if (!SSC_PILLARS.includes(bucketNorm)) {
      return res.status(400).json({ error: `bucket must be one of: ${SSC_PILLARS.join('|')}` });
    }
    if (bucketNorm !== entry.bucket) {
      updates.push(`bucket = $${idx++}`);
      params.push(bucketNorm);
      auditLogs.push({ field: 'bucket', old: entry.bucket, new: bucketNorm });
    }
  }
  if (funding_source_id !== undefined) {
    updates.push(`funding_source_id = $${idx++}`);
    params.push(funding_source_id);
    auditLogs.push({ field: 'funding_source_id', old: String(entry.funding_source_id), new: String(funding_source_id) });
  }

  if (updates.length === 0) return res.json({ entry, updated: false });

  updates.push(`edit_count = edit_count + 1`, `updated_at = NOW()`);
  params.push(entryId, userId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: updated } = await client.query(
      `UPDATE mod_ssc.t_dagsis_ledger SET ${updates.join(', ')}
       WHERE id = $${idx} AND user_id = $${idx + 1}
       RETURNING *`,
      params
    );

    for (const log of auditLogs) {
      await client.query(
        `INSERT INTO mod_ssc.ledger_audit_log (ledger_id, user_id, action, field_changed, old_value, new_value)
         VALUES ($1, $2, 'edited', $3, $4, $5)`,
        [entryId, userId, log.field, log.old, log.new]
      );
    }

    await client.query('COMMIT');
    res.json({ entry: updated[0], updated: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// DELETE /entry/:id — soft delete
router.delete('/entry/:id', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const entryId = parseInt(req.params.id);

  const { rows } = await pool.query(
    `UPDATE mod_ssc.t_dagsis_ledger SET is_deleted = true, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_deleted = false
     RETURNING id`,
    [entryId, userId]
  );

  if (!rows[0]) return res.status(404).json({ error: 'Entry not found' });

  await pool.query(
    `INSERT INTO mod_ssc.ledger_audit_log (ledger_id, user_id, action)
     VALUES ($1, $2, 'deleted')`,
    [entryId, userId]
  );

  res.json({ deleted: true });
}));

// GET /capacity — remaining monthly capacity per bucket
router.get('/capacity', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const tier = await getUserTier(pool, userId);
  if (tierRank(tier) < tierRank('sovereignty')) {
    return res.status(403).json({ error: 'Sovereignty tier required' });
  }

  const data = await getBucketCapacity(pool, userId);
  res.json(data);
}));

// ═══════════════════════════════════════════════════════════════════════════════
// FUNDING SOURCES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /funding-sources
router.get('/funding-sources', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const { rows } = await pool.query(
    `SELECT * FROM mod_ssc.funding_sources WHERE user_id = $1 AND is_active = true
     ORDER BY sort_order ASC, created_at ASC`,
    [userId]
  );
  res.json({ funding_sources: rows });
}));

// POST /funding-sources
router.post('/funding-sources', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  const { label, description } = req.body;
  if (!label || typeof label !== 'string' || label.trim().length === 0) {
    return res.status(400).json({ error: 'label required' });
  }
  if (label.trim().length > 100) {
    return res.status(400).json({ error: 'label max 100 characters' });
  }

  // Max 20 active funding sources
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM mod_ssc.funding_sources WHERE user_id = $1 AND is_active = true`,
    [userId]
  );
  if (parseInt(countResult.rows[0].count) >= 20) {
    return res.status(400).json({ error: 'Maximum 20 funding sources allowed' });
  }

  const { rows } = await pool.query(
    `INSERT INTO mod_ssc.funding_sources (user_id, label, description)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [userId, label.trim(), description?.trim() || null]
  );
  res.status(201).json({ funding_source: rows[0] });
}));

// PATCH /funding-sources/:id
router.patch('/funding-sources/:id', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const id = parseInt(req.params.id);

  const { label, description } = req.body;
  const updates = [];
  const params = [];
  let idx = 1;

  if (label !== undefined) {
    if (typeof label !== 'string' || label.trim().length === 0) {
      return res.status(400).json({ error: 'label cannot be empty' });
    }
    updates.push(`label = $${idx++}`);
    params.push(label.trim());
  }
  if (description !== undefined) {
    updates.push(`description = $${idx++}`);
    params.push(description?.trim() || null);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  updates.push(`updated_at = NOW()`);
  params.push(id, userId);

  const { rows } = await pool.query(
    `UPDATE mod_ssc.funding_sources
     SET ${updates.join(', ')}
     WHERE id = $${idx} AND user_id = $${idx + 1} AND is_active = true
     RETURNING *`,
    params
  );
  if (!rows[0]) return res.status(404).json({ error: 'Funding source not found' });
  res.json({ funding_source: rows[0] });
}));

// DELETE /funding-sources/:id
router.delete('/funding-sources/:id', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const id = parseInt(req.params.id);

  const { rows } = await pool.query(
    `UPDATE mod_ssc.funding_sources SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND is_active = true
     RETURNING id`,
    [id, userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Funding source not found' });
  res.json({ deleted: true });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// DATA MIGRATION: Ultimate → SSC
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/migrate', asyncRoute(async (req, res) => {
  const pool = getPool();
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;

  // Must be Sovereignty tier
  const tier = await getUserTier(pool, userId);
  if (tierRank(tier) < tierRank('sovereignty')) {
    return res.status(403).json({
      error: 'Sovereignty tier required for SSC migration',
      upgrade_url: '/pricing.html'
    });
  }

  // Check if already migrated
  const existing = await pool.query(
    `SELECT ssc_upgraded_at FROM users WHERE id = $1`,
    [userId]
  );
  if (existing.rows[0]?.ssc_upgraded_at) {
    return res.json({ migrated: false, message: 'Already migrated' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find all finalized Ultimate sessions for this user
    const sessions = await client.query(
      `SELECT s.*, array_agg(
         json_build_object(
           'amount_cents', i.amount_cents,
           'category', i.category,
           'bucket_shadow', i.bucket_shadow,
           'tax_amount_cents', i.tax_amount_cents,
           'label', i.label,
           'created_at', i.created_at
         ) ORDER BY i.created_at
       ) as items
       FROM mod_ssc.shopping_sessions s
       JOIN mod_ssc.shopping_items i ON i.session_id = s.id
       WHERE s.user_id = $1 AND s.status = 'saved'
       GROUP BY s.id`,
      [userId]
    );

    let migratedCount = 0;
    for (const session of sessions.rows) {
      // Group items by bucket_shadow and create a ledger entry per session
      const bucketGroups = {};
      for (const item of (session.items || [])) {
        const bucket = item.bucket_shadow;
        if (!bucketGroups[bucket]) {
          bucketGroups[bucket] = { total_cents: 0, tax_cents: 0 };
        }
        bucketGroups[bucket].total_cents += item.amount_cents;
        bucketGroups[bucket].tax_cents += item.tax_amount_cents;
      }

      for (const [bucket, amounts] of Object.entries(bucketGroups)) {
        await client.query(
          `INSERT INTO mod_ssc.t_dagsis_ledger
             (user_id, session_id, description, transaction_date,
              subtotal_cents, tax_cents, tip_cents, total_cents,
              bucket, allocation_pct, migrated_from,
              tax_enabled, tax_rate_bps)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,100,'ultimate',$10,$11)`,
          [
            userId, session.id,
            `Migrated from Ultimate Calculator`,
            new Date(session.created_at).toISOString().split('T')[0],
            amounts.total_cents, amounts.tax_cents, 0,
            amounts.total_cents + amounts.tax_cents,
            bucket,
            session.tax_enabled, session.tax_rate_bps
          ]
        );
        migratedCount++;
      }

      // Mark session as migrated
      await client.query(
        `UPDATE mod_ssc.shopping_sessions SET status = 'migrated' WHERE id = $1`,
        [session.id]
      );
    }

    // Convert locked XP vault to spendable wallet points
    const vault = await client.query(
      `SELECT locked_points FROM mod_ssc.xp_vault WHERE user_id = $1 AND converted_at IS NULL`,
      [userId]
    );

    let convertedPoints = 0;
    if (vault.rows[0]?.locked_points > 0) {
      const lockedPts = vault.rows[0].locked_points;
      convertedPoints = Math.floor(lockedPts / 100); // 100 locked = 1 spendable

      if (convertedPoints > 0) {
        // Mint to mod_rewards wallet using correct rewards_ledger schema.
        // Also records in mod_sweep.vault_unlock_log to prevent double-minting.
        try {
          // Ensure wallet row exists
          await client.query(
            `INSERT INTO mod_rewards.user_wallet (user_id) VALUES ($1)
             ON CONFLICT (user_id) DO NOTHING`,
            [userId]
          );

          // Get current real balance for running total
          const walletRow = await client.query(
            `SELECT balance_real FROM mod_rewards.user_wallet WHERE user_id = $1 FOR UPDATE`,
            [userId]
          );
          const currentBalance = parseInt(walletRow.rows[0]?.balance_real || 0);
          const balanceAfter = currentBalance + convertedPoints;

          // Insert ledger entry (correct schema: event_type, points, balance_after)
          await client.query(
            `INSERT INTO mod_rewards.rewards_ledger
               (user_id, event_type, points, balance_after, metadata, sandbox)
             VALUES ($1, 'vault_unlock', $2, $3, $4, false)`,
            [
              userId,
              convertedPoints,
              balanceAfter,
              JSON.stringify({
                source: 'xp_vault_conversion',
                locked_points_converted: lockedPts,
                conversion_rate: '100:1 (Cent-Standard)',
                triggered_by: 'mod_ssc/migrate'
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
            [userId, convertedPoints]
          );

          // Record in vault_unlock_log if mod_sweep schema exists (prevents double-mint)
          await client.query(
            `INSERT INTO mod_sweep.vault_unlock_log (user_id, locked_points, minted_points)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id) DO NOTHING`,
            [userId, lockedPts, convertedPoints]
          ).catch(() => {}); // non-fatal if mod_sweep not yet migrated

        } catch (mintErr) {
          console.warn('[mod_ssc] vault_unlock mint warning:', mintErr.message);
          // Non-fatal — migration can still succeed; vault will unlock via mod_sweep endpoint
        }

        await client.query(
          `UPDATE mod_ssc.xp_vault
           SET converted_at = NOW(), converted_points = $1, updated_at = NOW()
           WHERE user_id = $2`,
          [convertedPoints, userId]
        );
      }
    }

    // Mark user as upgraded
    await client.query(
      `UPDATE users SET ssc_upgraded_at = NOW() WHERE id = $1`,
      [userId]
    );

    await client.query('COMMIT');

    res.json({
      migrated: true,
      sessions_migrated: sessions.rows.length,
      ledger_entries_created: migratedCount,
      vault_converted: convertedPoints
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// ─── Module exports ───────────────────────────────────────────────────────────
async function healthCheck(pool) {
  try {
    await pool.query('SELECT COUNT(*) FROM mod_ssc.t_dagsis_ledger LIMIT 0');
    return { status: 'ok', version: '1.0.0', lastMigration: 'mod_ssc_ledger' };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

module.exports = {
  routes: router,
  healthCheck,
  metadata: {
    name: 'mod_ssc',
    version: '1.0.0',
    description: 'Shopping Calculator Ecosystem — Ultimate Calculator + SSC + T-Dagsis Digital Ledger',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true
  }
};
