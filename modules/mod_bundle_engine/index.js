/**
 * mod_bundle_engine — Elite Add-On Bundle Pricing Engine
 *
 * Elite tier only ($147/mo base).
 * Business / Sovereignty already include all modules — bundles not applicable.
 *
 * Bundle Registry:
 *   BNDL_STARTER   — Privacy Starter     — 2 modules — $39/mo
 *   BNDL_SOVEREIGN — Sovereign Architect — 3 modules — $59/mo  (RECOMMENDED)
 *   BNDL_LEGACY    — Legacy Protocol     — 4 modules — $79/mo  (ULTIMATE PRIVACY)
 *
 * A-la-carte pricing (individual add-ons):
 *   sanitized_importer — $19.99/mo
 *   lending_desk       — $29/mo
 *   vault_automation   — $29/mo
 *   legacy_lens        — $29/mo
 *
 * Upsell Triggers (with 7-day dismiss cooldown):
 *   T1 — Single add-on in cart → "save 20% with Privacy Starter"
 *   T2 — Two add-ons exceed $39 → "convert to Privacy Starter bundle"
 *   T3 — Three active add-ons → "unlock full Legacy Protocol for $20 more"
 *
 * Cross-Module Data Bridges:
 *   Link 1 — Importer → Lending:  portfolio equity → recalc HELOC strike power
 *   Link 2 — Lending  → Vault:    debt milestone → PDF receipt in vault
 *   Link 3 — Importer → Legacy:   ticker data → diversification heatmap
 *
 * Stripe links:
 *   BNDL_STARTER:   https://buy.stripe.com/cNibJ25lFc9b5NEfG37Re0h ($39)
 *   BNDL_SOVEREIGN: https://buy.stripe.com/8x2bJ229tddf1xo79x7Re0i ($59)
 *   BNDL_LEGACY:    https://buy.stripe.com/eVq8wQ15p2yB6RIbpN7Re0j ($79)
 *
 * Routes (mounted at /api/mod_bundle_engine):
 *   GET  /health
 *   GET  /bundles                — list all bundles with savings callout
 *   GET  /my-bundle              — current user's active bundle
 *   POST /bundle/activate        — activate a bundle (cancel individual subs)
 *   POST /bundle/cancel          — cancel active bundle
 *   GET  /addons/status          — user's active add-ons + bundle coverage
 *   GET  /upsell/triggers        — evaluate and return active upsell triggers
 *   POST /upsell/dismiss         — dismiss a trigger (7-day cooldown)
 *   GET  /bridges/status         — cross-module bridge health
 *   POST /bridges/importer-lending — push equity update to lending module
 *   GET  /diversification-heatmap — ticker concentration from importer data
 *   GET  /pricing                — full pricing page data payload
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
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

// ─── Auth helper ──────────────────────────────────────────────────────────────
function requireAuth(req, res) {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  return true;
}

// ─── Tier helpers ─────────────────────────────────────────────────────────────
const TIER_RANK = { free: 0, elite: 1, business: 2, sovereignty: 3 };
function normalizeTier(plan) {
  if (!plan) return 'free';
  const p = plan.toLowerCase();
  if (p.includes('sovereignty') || p.includes('sovereign')) return 'sovereignty';
  if (p.includes('business')) return 'business';
  if (p.includes('elite')) return 'elite';
  return 'free';
}
function tierRank(t) { return TIER_RANK[t] ?? -1; }

// ─── Bundle Registry (matches DB seed) ────────────────────────────────────────
const BUNDLE_REGISTRY = [
  {
    bundle_id: 'BNDL_STARTER',
    display_name: 'Privacy Starter',
    slots: 2,
    fixed_price_cents: 3900,
    is_full_stack: false,
    eligible_modules: ['sanitized_importer', 'vault_automation', 'lending_desk', 'legacy_lens'],
    stripe_link: 'https://buy.stripe.com/cNibJ25lFc9b5NEfG37Re0h',
    badge: null
  },
  {
    bundle_id: 'BNDL_SOVEREIGN',
    display_name: 'Sovereign Architect',
    slots: 3,
    fixed_price_cents: 5900,
    is_full_stack: false,
    eligible_modules: ['sanitized_importer', 'vault_automation', 'lending_desk', 'legacy_lens'],
    stripe_link: 'https://buy.stripe.com/8x2bJ229tddf1xo79x7Re0i',
    badge: 'RECOMMENDED'
  },
  {
    bundle_id: 'BNDL_LEGACY',
    display_name: 'Legacy Protocol Suite',
    slots: 4,
    fixed_price_cents: 7900,
    is_full_stack: true,
    eligible_modules: ['sanitized_importer', 'vault_automation', 'lending_desk', 'legacy_lens'],
    stripe_link: 'https://buy.stripe.com/eVq8wQ15p2yB6RIbpN7Re0j',
    badge: 'ULTIMATE PRIVACY'
  }
];

// ─── A-la-carte pricing ───────────────────────────────────────────────────────
const ALACARTE_PRICES = {
  sanitized_importer: { price_cents: 1999, stripe_link: 'https://buy.stripe.com/8x2eVe4hB8WZ7VMalJ7Re0g' },
  lending_desk:       { price_cents: 2900, stripe_link: 'https://buy.stripe.com/dRm3cwdSba13foe65t7Re0k' },
  vault_automation:   { price_cents: 2900, stripe_link: 'https://buy.stripe.com/bJe28scO7flngsi1Pd7Re0l' },
  legacy_lens:        { price_cents: 2900, stripe_link: 'https://buy.stripe.com/9B6fZi01l3CFdg679x7Re0m' }
};

// ─── Module descriptions (for UI cards) ───────────────────────────────────────
const MODULE_META = {
  sanitized_importer: { icon: '🛡️', name: 'Sanitized Importer',  desc: 'Bulk CSV import. Zero PII.' },
  vault_automation:   { icon: '🏛️', name: 'Vault Automation',    desc: 'Auto-file receipts & milestones.' },
  lending_desk:       { icon: '⚡', name: 'Sovereign Lending',    desc: '9-pod lending. HELOC strike power.' },
  legacy_lens:        { icon: '🔭', name: 'Legacy Lens',          desc: 'Entity hierarchy & health score.' }
};

// ─── Compute savings vs a-la-carte ─────────────────────────────────────────────
function computeSavings(bundle, selectedModules) {
  const modules = bundle.is_full_stack ? bundle.eligible_modules : selectedModules;
  const alacartTotal = modules.reduce((sum, m) => sum + (ALACARTE_PRICES[m]?.price_cents || 0), 0);
  return { alacart_total_cents: alacartTotal, savings_cents: alacartTotal - bundle.fixed_price_cents };
}

// ─── Get user row ─────────────────────────────────────────────────────────────
async function getUser(userId, pool) {
  const { rows } = await pool.query(
    `SELECT id, email, pricing_tier, subscription_tier, plan
     FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// ─── Get user's active add-ons ────────────────────────────────────────────────
async function getActiveAddons(userId, pool) {
  const { rows } = await pool.query(
    `SELECT module_id FROM core.module_flags
     WHERE user_id = $1 AND status = 'enabled'`,
    [userId]
  );
  return rows.map(r => r.module_id);
}

// ─── Get user's active bundle ─────────────────────────────────────────────────
async function getActiveBundle(userId, pool) {
  const { rows } = await pool.query(
    `SELECT ub.*, b.display_name, b.slots, b.fixed_price_cents,
            b.is_full_stack, b.eligible_modules, b.stripe_link
     FROM core.user_bundles ub
     JOIN core.bundles b ON b.bundle_id = ub.bundle_id
     WHERE ub.user_id = $1 AND ub.status = 'active'
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

// ─── Check 7-day dismiss cooldown ────────────────────────────────────────────
async function isDismissed(userId, triggerId, pool) {
  const { rows } = await pool.query(
    `SELECT 1 FROM core.addon_upsell_dismissals
     WHERE user_id = $1 AND trigger_id = $2
       AND dismissed_at > NOW() - INTERVAL '7 days'
     LIMIT 1`,
    [userId, triggerId]
  );
  return rows.length > 0;
}

// ─── Router ───────────────────────────────────────────────────────────────────
const router = express.Router();

// GET /health
router.get('/health', asyncRoute(async (req, res) => {
  const pool = getPool();
  try {
    await pool.query(`SELECT 1 FROM core.bundles LIMIT 1`);
    res.json({ status: 'ok', module: 'mod_bundle_engine', version: '1.0.0' });
  } catch (e) {
    res.json({ status: 'schema_missing', module: 'mod_bundle_engine', error: e.message });
  }
}));

// GET /bundles — full bundle list with savings callout
router.get('/bundles', asyncRoute(async (req, res) => {
  const pool = getPool();
  let userBundle = null;
  let userAddons = [];

  if (req.session?.userId) {
    [userBundle, userAddons] = await Promise.all([
      getActiveBundle(req.session.userId, pool),
      getActiveAddons(req.session.userId, pool)
    ]);
  }

  const bundles = BUNDLE_REGISTRY.map(b => {
    const maxSavings = computeSavings(b, b.eligible_modules.slice(0, b.slots));
    return {
      ...b,
      price_usd: (b.fixed_price_cents / 100).toFixed(2),
      max_savings_usd: (maxSavings.savings_cents / 100).toFixed(2),
      module_cards: b.eligible_modules.map(m => ({
        ...MODULE_META[m],
        addon_id: m,
        individual_price_usd: (ALACARTE_PRICES[m]?.price_cents / 100 || 0).toFixed(2),
        is_covered: userBundle
          ? (userBundle.is_full_stack || (userBundle.selected_modules || []).includes(m))
          : userAddons.includes(m)
      })),
      is_active_bundle: userBundle?.bundle_id === b.bundle_id
    };
  });

  res.json({
    bundles,
    alacarte_prices: Object.fromEntries(
      Object.entries(ALACARTE_PRICES).map(([k, v]) => [k, { ...v, price_usd: (v.price_cents / 100).toFixed(2) }])
    ),
    tier_note: 'Bundles available for Elite tier ($147/mo). Business and Sovereignty already include all modules.'
  });
}));

// GET /my-bundle — current user's active bundle
router.get('/my-bundle', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const bundle = await getActiveBundle(req.session.userId, pool);

  if (!bundle) {
    const addons = await getActiveAddons(req.session.userId, pool);
    return res.json({
      has_bundle: false,
      active_addons: addons,
      alacarte_total_cents: addons.reduce((s, m) => s + (ALACARTE_PRICES[m]?.price_cents || 0), 0)
    });
  }

  res.json({
    has_bundle: true,
    bundle_id: bundle.bundle_id,
    display_name: bundle.display_name,
    selected_modules: bundle.selected_modules,
    price_cents: bundle.fixed_price_cents,
    price_usd: (bundle.fixed_price_cents / 100).toFixed(2),
    status: bundle.status,
    activated_at: bundle.activated_at
  });
}));

// POST /bundle/activate — activate a bundle, cancel individual subs for covered modules
router.post('/bundle/activate', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { bundle_id, selected_modules, stripe_subscription_id } = req.body;

  if (!bundle_id) return res.status(400).json({ error: 'bundle_id required' });

  const bundle = BUNDLE_REGISTRY.find(b => b.bundle_id === bundle_id);
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });

  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const tier = normalizeTier(user.pricing_tier || user.subscription_tier || user.plan || '');
  if (tierRank(tier) < tierRank('elite')) {
    return res.status(403).json({ error: 'Elite tier required to activate bundles' });
  }

  // Validate selected modules
  const modules = bundle.is_full_stack
    ? bundle.eligible_modules
    : (selected_modules || []).filter(m => bundle.eligible_modules.includes(m));

  if (!bundle.is_full_stack && modules.length !== bundle.slots) {
    return res.status(400).json({
      error: `This bundle requires exactly ${bundle.slots} modules. Got ${modules.length}.`,
      eligible_modules: bundle.eligible_modules
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Cancel any existing active bundle for this user
    await client.query(
      `UPDATE core.user_bundles
       SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND status = 'active'`,
      [user.id]
    );

    // Create new bundle record
    await client.query(
      `INSERT INTO core.user_bundles
         (user_id, bundle_id, selected_modules, stripe_subscription_id, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [user.id, bundle_id, JSON.stringify(modules), stripe_subscription_id || null]
    );

    // Enable module flags for covered modules (no-double-charge guarantee)
    for (const moduleId of modules) {
      await client.query(
        `INSERT INTO core.module_flags (module_id, user_id, status, created_at, updated_at)
         VALUES ($1, $2, 'enabled', NOW(), NOW())
         ON CONFLICT (module_id, user_id)
         DO UPDATE SET status = 'enabled', updated_at = NOW()`,
        [moduleId, user.id]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    throw e;
  }
  client.release();

  res.json({
    success: true,
    bundle_id,
    modules_activated: modules,
    message: `${bundle.display_name} bundle activated. Individual subscriptions for covered modules cancelled.`
  });
}));

// POST /bundle/cancel — cancel active bundle
router.post('/bundle/cancel', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  const bundle = await getActiveBundle(req.session.userId, pool);
  if (!bundle) return res.status(404).json({ error: 'No active bundle found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE core.user_bundles
       SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND status = 'active'`,
      [req.session.userId]
    );

    // Disable module flags for all bundle-covered modules
    // Only explicitly re-subscribed modules should remain active
    const coveredModules = bundle.is_full_stack
      ? bundle.eligible_modules
      : (bundle.selected_modules || []);

    for (const moduleId of coveredModules) {
      await client.query(
        `UPDATE core.module_flags
         SET status = 'disabled', updated_at = NOW()
         WHERE module_id = $1 AND user_id = $2`,
        [moduleId, req.session.userId]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    throw e;
  }
  client.release();

  res.json({
    success: true,
    cancelled_bundle: bundle.bundle_id,
    message: 'Bundle cancelled. Re-subscribe to individual modules to restore access.'
  });
}));

// GET /addons/status — user's add-ons + bundle coverage map
router.get('/addons/status', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const [bundle, addons] = await Promise.all([
    getActiveBundle(req.session.userId, pool),
    getActiveAddons(req.session.userId, pool)
  ]);

  const coveredByBundle = bundle
    ? (bundle.is_full_stack ? bundle.eligible_modules : (bundle.selected_modules || []))
    : [];

  const status = Object.entries(ALACARTE_PRICES).map(([moduleId, pricing]) => ({
    addon_id: moduleId,
    ...MODULE_META[moduleId],
    is_active: addons.includes(moduleId) || coveredByBundle.includes(moduleId),
    covered_by_bundle: coveredByBundle.includes(moduleId),
    bundle_id: coveredByBundle.includes(moduleId) ? bundle?.bundle_id : null,
    individual_price_cents: pricing.price_cents,
    stripe_link: pricing.stripe_link
  }));

  const totalAlacarte = addons
    .filter(m => !coveredByBundle.includes(m))
    .reduce((s, m) => s + (ALACARTE_PRICES[m]?.price_cents || 0), 0);

  res.json({
    active_bundle: bundle ? { bundle_id: bundle.bundle_id, display_name: bundle.display_name } : null,
    addons: status,
    alacarte_total_cents: totalAlacarte,
    total_active: status.filter(s => s.is_active).length
  });
}));

// GET /upsell/triggers — evaluate all active upsell triggers for the current user
router.get('/upsell/triggers', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const [user, bundle, addons] = await Promise.all([
    getUser(req.session.userId, pool),
    getActiveBundle(req.session.userId, pool),
    getActiveAddons(req.session.userId, pool)
  ]);

  if (!user) return res.status(404).json({ error: 'User not found' });

  const tier = normalizeTier(user.pricing_tier || user.subscription_tier || user.plan || '');
  if (tierRank(tier) >= tierRank('business')) {
    return res.json({ triggers: [], reason: 'all_included' });
  }
  if (tier !== 'elite') {
    return res.json({ triggers: [], reason: 'elite_required' });
  }
  if (bundle) {
    return res.json({ triggers: [], reason: 'bundle_active', bundle_id: bundle.bundle_id });
  }

  const triggers = [];
  const activeAddonCount = addons.filter(m => ALACARTE_PRICES[m]).length;
  const alacartTotal = addons.reduce((s, m) => s + (ALACARTE_PRICES[m]?.price_cents || 0), 0);

  // Trigger 1 — Single add-on in cart/active
  if (activeAddonCount === 1 && !(await isDismissed(req.session.userId, 'upsell_t1', pool))) {
    triggers.push({
      trigger_id: 'upsell_t1',
      message: "Excellent choice. To further protect your assets, you can add a second Elite module and save 20% by activating the Privacy Starter bundle.",
      cta: 'See Privacy Starter — $39/mo',
      bundle_id: 'BNDL_STARTER',
      stripe_link: 'https://buy.stripe.com/cNibJ25lFc9b5NEfG37Re0h',
      savings_cents: 100
    });
  }

  // Trigger 2 — Two add-ons exceeding bundle price
  if (activeAddonCount === 2 && alacartTotal > 3900 &&
      !(await isDismissed(req.session.userId, 'upsell_t2', pool))) {
    triggers.push({
      trigger_id: 'upsell_t2',
      message: `Architect Notice: I can convert these selections into the Privacy Starter bundle for $39.00/mo. You're currently paying $${(alacartTotal / 100).toFixed(2)}/mo.`,
      cta: 'Convert to Privacy Starter — $39/mo',
      bundle_id: 'BNDL_STARTER',
      stripe_link: 'https://buy.stripe.com/cNibJ25lFc9b5NEfG37Re0h',
      savings_cents: alacartTotal - 3900
    });
  }

  // Trigger 3 — Three active add-ons (dashboard retention upsell)
  if (activeAddonCount === 3 && !(await isDismissed(req.session.userId, 'upsell_t3', pool))) {
    const legacySavings = alacartTotal - 7900;
    triggers.push({
      trigger_id: 'upsell_t3',
      message: `You are currently running 3 Elite modules. For only $${((7900 - alacartTotal) / 100 * -1).toFixed(2)} more, you can unlock the full Legacy Protocol, adding the 4th module to secure your generational wealth strategy.`,
      cta: 'Unlock Legacy Protocol Suite — $79/mo',
      bundle_id: 'BNDL_LEGACY',
      stripe_link: 'https://buy.stripe.com/eVq8wQ15p2yB6RIbpN7Re0j',
      savings_cents: legacySavings > 0 ? legacySavings : 0
    });
  }

  res.json({ triggers });
}));

// POST /upsell/dismiss — 7-day cooldown
router.post('/upsell/dismiss', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { trigger_id } = req.body;
  if (!trigger_id) return res.status(400).json({ error: 'trigger_id required' });

  const pool = getPool();
  await pool.query(
    `INSERT INTO core.addon_upsell_dismissals (user_id, trigger_id, dismissed_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id, trigger_id)
     DO UPDATE SET dismissed_at = NOW()`,
    [req.session.userId, trigger_id]
  );

  res.json({ dismissed: true, cooldown_days: 7 });
}));

// ─── Cross-Module Bridge: Importer → Lending ──────────────────────────────────
// When sanitized_importer updates equity → push to lending_desk for HELOC recalc
router.post('/bridges/importer-lending', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const { total_equity, liquid_equity, portfolio_diversity_score } = req.body;
  if (total_equity === undefined) {
    return res.status(400).json({ error: 'total_equity required' });
  }

  const pool = getPool();

  // Record the bridge event
  await pool.query(
    `INSERT INTO core.module_events
       (user_id, module_id, event_type, metadata, occurred_at)
     VALUES ($1, 'mod_bundle_engine', 'bridge_importer_lending', $2, NOW())`,
    [req.session.userId, JSON.stringify({
      total_equity_cents: Math.round(total_equity * 100),
      liquid_equity_cents: Math.round((liquid_equity || 0) * 100),
      portfolio_diversity_score: portfolio_diversity_score || 0
    })]
  );

  // Update lending desk pods with new liquidity ratios (if mod_lending_desk schema exists)
  try {
    const totalCents = Math.round(total_equity * 100);
    const liquidCents = Math.round((liquid_equity || total_equity * 0.3) * 100);

    // Store computed values for lending_desk to consume
    await pool.query(
      `INSERT INTO core.module_events
         (user_id, module_id, event_type, metadata, occurred_at)
       VALUES ($1, 'mod_lending_desk', 'liquidity_update', $2, NOW())`,
      [req.session.userId, JSON.stringify({
        source: 'sanitized_importer',
        total_equity_cents: totalCents,
        liquid_equity_cents: liquidCents,
        portfolio_diversity_score: portfolio_diversity_score || 0,
        heloc_strike_power_cents: Math.round(liquidCents * 0.8)  // 80% of liquid
      })]
    );
  } catch (_) { /* lending module may not be installed — non-fatal */ }

  res.json({
    success: true,
    bridge: 'importer_lending',
    message: 'Liquidity ratios updated. Lending desk HELOC strike power recalculated.'
  });
}));

// GET /bridges/status — health of all cross-module bridges
router.get('/bridges/status', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  const bridges = [
    { id: 'importer_lending', name: 'Importer → Lending', description: 'Portfolio equity → HELOC strike power' },
    { id: 'lending_vault',    name: 'Lending → Vault',    description: 'Debt milestone → PDF receipt archiving' },
    { id: 'importer_legacy',  name: 'Importer → Legacy',  description: 'Ticker data → Diversification Heatmap' }
  ];

  const events = await pool.query(
    `SELECT event_type, MAX(occurred_at) as last_fired
     FROM core.module_events
     WHERE user_id = $1
       AND event_type IN ('bridge_importer_lending','bridge_lending_vault','bridge_importer_legacy')
     GROUP BY event_type`,
    [req.session.userId]
  ).catch(() => ({ rows: [] }));

  const lastFired = {};
  for (const row of events.rows) {
    lastFired[row.event_type] = row.last_fired;
  }

  res.json({
    bridges: bridges.map(b => ({
      ...b,
      last_fired: lastFired[`bridge_${b.id.replace('-', '_')}`] || null,
      status: 'ready'
    }))
  });
}));

// GET /diversification-heatmap — groups importer data by asset_class
router.get('/diversification-heatmap', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  // Check if mod_brokerage schema exists
  const schemaCheck = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.schemata WHERE schema_name = 'mod_brokerage'
     )`, []
  );

  if (!schemaCheck.rows[0].exists) {
    return res.json({ heatmap: [], message: 'No portfolio data yet. Import positions first.' });
  }

  const { rows } = await pool.query(
    `SELECT
       asset_class,
       COUNT(*)::int                            AS position_count,
       SUM(share_count * cost_basis)            AS total_value,
       ROUND(AVG(yield_pct)::numeric, 2)        AS avg_yield,
       array_agg(DISTINCT ticker_symbol)        AS tickers
     FROM mod_brokerage.assets
     WHERE user_id = $1 AND is_active = true
     GROUP BY asset_class
     ORDER BY total_value DESC NULLS LAST`,
    [req.session.userId]
  );

  const totalValue = rows.reduce((s, r) => s + parseFloat(r.total_value || 0), 0);
  const heatmap = rows.map(r => ({
    asset_class: r.asset_class,
    position_count: r.position_count,
    total_value: parseFloat(r.total_value || 0),
    concentration_pct: totalValue > 0
      ? Math.round((parseFloat(r.total_value || 0) / totalValue) * 1000) / 10
      : 0,
    avg_yield: parseFloat(r.avg_yield || 0),
    tickers: r.tickers || [],
    risk_flag: parseFloat(r.total_value || 0) / totalValue > 0.5 ? 'HIGH_CONCENTRATION' : null
  }));

  res.json({
    heatmap,
    total_portfolio_value: totalValue,
    concentration_risk: heatmap.some(h => h.risk_flag === 'HIGH_CONCENTRATION')
      ? 'Warning: One asset class exceeds 50% of portfolio value.'
      : 'Diversification looks healthy.'
  });
}));

// GET /pricing — full pricing page data payload (for bundle selection UI)
router.get('/pricing', asyncRoute(async (req, res) => {
  const pool = getPool();
  let userBundle = null;
  let userAddons = [];

  if (req.session?.userId) {
    [userBundle, userAddons] = await Promise.all([
      getActiveBundle(req.session.userId, pool),
      getActiveAddons(req.session.userId, pool)
    ]);
  }

  const bundles = BUNDLE_REGISTRY.map(b => {
    const alacartMax = b.eligible_modules.slice(0, b.slots)
      .reduce((s, m) => s + (ALACARTE_PRICES[m]?.price_cents || 0), 0);
    return {
      ...b,
      price_usd: (b.fixed_price_cents / 100).toFixed(2),
      max_savings_usd: ((alacartMax - b.fixed_price_cents) / 100).toFixed(2),
      module_cards: b.eligible_modules.map(m => ({
        ...MODULE_META[m],
        addon_id: m,
        individual_price_usd: ((ALACARTE_PRICES[m]?.price_cents || 0) / 100).toFixed(2)
      }))
    };
  });

  res.json({
    bundles,
    individual_addons: Object.entries(ALACARTE_PRICES).map(([id, p]) => ({
      addon_id: id,
      ...MODULE_META[id],
      price_usd: (p.price_cents / 100).toFixed(2),
      stripe_link: p.stripe_link,
      is_active: userAddons.includes(id)
    })),
    user_context: {
      has_bundle: !!userBundle,
      active_bundle_id: userBundle?.bundle_id || null,
      active_addons: userAddons
    }
  });
}));

// ─── Module export ─────────────────────────────────────────────────────────────
module.exports = {
  metadata: {
    name: 'Bundle Pricing Engine',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true
  },

  routes: router,

  healthCheck: async (pool) => {
    try {
      await pool.query(`SELECT 1 FROM core.bundles LIMIT 1`);
      return { module: 'mod_bundle_engine', status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() };
    } catch (e) {
      return { module: 'mod_bundle_engine', status: 'error', error: e.message, timestamp: new Date().toISOString() };
    }
  }
};
