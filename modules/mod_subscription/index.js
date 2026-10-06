/**
 * mod_subscription — Subscription Tier Management
 *
 * Owns: tier upgrades/downgrades, admin tier overrides, tier confirmation flow,
 *       tier history events, family plan split logic.
 *
 * Does NOT own: Stripe payment link creation (that lives in legacy server.js),
 *               session management, gamification XP awards, or Plaid sync.
 *
 * Routes (auto-mounted at /api/mod_subscription):
 *   GET  /health                  — module health check
 *   GET  /current                 — current tier info for logged-in user
 *   POST /change-tier             — in-place tier upgrade/downgrade
 *   POST /admin/set-tier          — admin-only override (testing accounts only)
 *   GET  /tier-preview            — preview what features change before confirming
 *   GET  /history                 — tier change history for user
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const { asyncRoute } = require('../../module-error-boundary');

// ─── Admin emails (testing accounts with tier override privilege) ────────────
const ADMIN_TEST_EMAILS = [
  'chris.finrev@gmail.com',
  'ecci2760@gmail.com',
];

// ─── Canonical tier hierarchy ─────────────────────────────────────────────────
// pricing_tier values stored in users.pricing_tier
const TIER_HIERARCHY = [
  'free',
  'individual_pro',
  'tfr_pro',          // Family plan
  'business_core',
  'business_bundle',
  'tfr_elite',
  'sovereign_executive',
];

// Human-readable tier names
const TIER_DISPLAY_NAMES = {
  free:                 'Free',
  individual_pro:       'Individual',
  tfr_pro:              'Family',
  business_core:        'Business Core',
  business_bundle:      'Business',
  tfr_elite:            'Elite',
  sovereign_executive:  'Sovereign',
};

// Monthly prices in cents (display only — actual billing uses Stripe payment links)
// Canonical pricing matches /pricing.html marketing page
const TIER_MONTHLY_CENTS = {
  free:                 0,
  individual_pro:       1499,   // $14.99/mo
  tfr_pro:              2500,   // $25/mo
  business_core:        9700,   // $97/mo
  business_bundle:      29700,  // $297/mo
  tfr_elite:            19700,  // $197/mo
  sovereign_executive:  1999700, // one-time $19,997
};

// Features unlocked per tier (display for confirmation screen)
const TIER_FEATURES = {
  free: [
    'FACTS 6-bucket allocation tracking',
    'Basic income & spending ledger',
    'Phase Zero financial assessment',
  ],
  individual_pro: [
    'Everything in Free',
    'AI allocation coach (20 messages/mo)',
    'Transaction import & categorization',
    'Financial health scorecard',
    'Document vault',
  ],
  tfr_pro: [
    'Everything in Individual',
    'Family sharing (up to 6 members)',
    'AI coach (50 messages/mo)',
    'Shared goals & budgets',
    'Family dashboard',
  ],
  business_core: [
    'Everything in Family',
    'Business FACTS allocations',
    'Business path onboarding',
    'Heartbeat compliance tracking',
  ],
  business_bundle: [
    'Everything in Business Core',
    'AI coach (100 messages/mo)',
    'Bundle engine & add-ons',
    'Priority support',
  ],
  tfr_elite: [
    'Everything in Business',
    'HELOC engine & lending desk',
    'Sovereign wealth management',
    'AI coach (200 messages/mo)',
    'Brokerage tracker',
    'Elite analytics suite',
  ],
  sovereign_executive: [
    'Everything in Elite',
    'Unlimited AI coach',
    'Succession planning tools',
    'Sovereign oath & legacy vault',
    'Direct advisory access',
  ],
};

// Features LOST when downgrading (for downgrade warning)
const FEATURES_LOST_ON_DOWNGRADE = {
  from_family_to_individual: [
    'Family member access',
    'Shared goals & budgets',
    'Family dashboard',
  ],
  from_business_to_family: [
    'Business FACTS allocations',
    'Heartbeat compliance',
    'Business path',
  ],
  from_elite_to_business: [
    'HELOC engine',
    'Lending desk access',
    'Sovereignty scoring tools',
  ],
};

// ─── Stripe payment links (read from env, matching legacy) ───────────────────
function getStripeLink(tier, billing = 'monthly') {
  const links = {
    individual_pro: {
      monthly: process.env.STRIPE_INDIVIDUAL_MONTHLY_LINK,
      annual:  process.env.STRIPE_INDIVIDUAL_ANNUAL_LINK,
    },
    tfr_pro: {
      monthly: process.env.STRIPE_TFR_PRO_MONTHLY_LINK,
      annual:  process.env.STRIPE_TFR_PRO_ANNUAL_LINK,
    },
    business_core: {
      monthly: process.env.STRIPE_BUSINESS_CORE_MONTHLY_LINK,
    },
    business_bundle: {
      monthly: process.env.STRIPE_BUSINESS_BUNDLE_MONTHLY_LINK,
      annual:  process.env.STRIPE_BUSINESS_BUNDLE_ANNUAL_LINK,
    },
    tfr_elite: {
      monthly: process.env.STRIPE_TFR_ELITE_MONTHLY_LINK,
      annual:  process.env.STRIPE_TFR_ELITE_ANNUAL_LINK,
    },
    sovereign_executive: {
      one_time: process.env.STRIPE_SOVEREIGN_LINK,
    },
  };
  const tierLinks = links[tier];
  if (!tierLinks) return null;
  return tierLinks[billing] || tierLinks.monthly || tierLinks.one_time || null;
}

// ─── DB Pool (lazy-init, shared across requests) ──────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return _pool;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.userId = req.session.userId;
  next();
}

async function requireAdminTest(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.userId = req.session.userId;
  try {
    const pool = getPool();
    const r = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]);
    const email = (r.rows[0]?.email || '').toLowerCase();
    if (!ADMIN_TEST_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'Admin testing access required' });
    }
    req.userEmail = email;
    next();
  } catch (e) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

// ─── Tier utilities ───────────────────────────────────────────────────────────
function getTierRank(tier) {
  const idx = TIER_HIERARCHY.indexOf(tier);
  return idx >= 0 ? idx : -1;
}

function isUpgrade(fromTier, toTier) {
  return getTierRank(toTier) > getTierRank(fromTier);
}

function isDowngrade(fromTier, toTier) {
  return getTierRank(toTier) < getTierRank(fromTier);
}

function normalizeTier(tier) {
  // Accept legacy tier names and normalize to canonical
  const legacyMap = {
    pro:           'individual_pro',
    household_pro: 'tfr_pro',
    none:          'free',
  };
  return legacyMap[tier] || tier;
}

// ─── Get current tier for user ────────────────────────────────────────────────
async function getUserCurrentTier(userId) {
  const pool = getPool();
  const r = await pool.query(
    `SELECT pricing_tier, plan, paid_until, email, is_creator, subscription_tier
     FROM users WHERE id = $1`,
    [userId]
  );
  if (!r.rows.length) return { tier: 'free', plan: 'free', paid_until: null };

  const u = r.rows[0];
  // Owner emails always get sovereign
  const ownerEmails = (process.env.OWNER_EMAILS || 'ecci2760@gmail.com,ecci2760f@gmail.com,dianes3cps@gmail.com')
    .split(',').map(e => e.trim().toLowerCase());
  if (u.is_creator || ownerEmails.includes((u.email || '').toLowerCase())) {
    return { tier: 'sovereign_executive', plan: u.plan, paid_until: u.paid_until, email: u.email };
  }

  const tier = normalizeTier(u.pricing_tier || 'free');
  return { tier, plan: u.plan, paid_until: u.paid_until, email: u.email, subscription_tier: u.subscription_tier };
}

// ─── Record tier change event ─────────────────────────────────────────────────
async function recordTierChangeEvent(userId, fromTier, toTier, reason, isAdminOverride = false) {
  const pool = getPool();
  await pool.query(
    `INSERT INTO user_events (user_id, event_type, metadata, created_at)
     VALUES ($1, 'tier_change', $2, NOW())`,
    [userId, JSON.stringify({
      from_tier: fromTier,
      to_tier: toTier,
      reason,
      is_admin_override: isAdminOverride,
      direction: isUpgrade(fromTier, toTier) ? 'upgrade' : isDowngrade(fromTier, toTier) ? 'downgrade' : 'same',
    })]
  );
}

// ─── Router ───────────────────────────────────────────────────────────────────
const router = express.Router();

// GET /api/mod_subscription/health
router.get('/health', asyncRoute(async (req, res) => {
  res.json({ status: 'ok', module: 'mod_subscription', version: '1.0.0' });
}));

/**
 * GET /api/mod_subscription/current
 * Returns current tier info, feature list, upgrade options.
 */
router.get('/current', requireAuth, asyncRoute(async (req, res) => {
  const { tier, plan, paid_until } = await getUserCurrentTier(req.userId);

  const isActive = plan === 'paid' && paid_until && new Date(paid_until) > new Date();
  const effectiveTier = (isActive || tier === 'free' || tier === 'sovereign_executive') ? tier : 'free';

  const upgrades = TIER_HIERARCHY
    .filter(t => getTierRank(t) > getTierRank(effectiveTier) && t !== effectiveTier)
    .map(t => ({
      tier: t,
      display_name: TIER_DISPLAY_NAMES[t],
      monthly_cents: TIER_MONTHLY_CENTS[t],
      monthly_usd: (TIER_MONTHLY_CENTS[t] / 100).toFixed(2),
      features: TIER_FEATURES[t],
      stripe_link: getStripeLink(t, 'monthly'),
    }));

  res.json({
    current_tier: effectiveTier,
    display_name: TIER_DISPLAY_NAMES[effectiveTier] || effectiveTier,
    plan,
    paid_until,
    is_active: isActive || tier === 'free' || tier === 'sovereign_executive',
    features: TIER_FEATURES[effectiveTier] || [],
    upgrade_options: upgrades,
    monthly_cents: TIER_MONTHLY_CENTS[effectiveTier] || 0,
  });
}));

/**
 * GET /api/mod_subscription/tier-preview?to_tier=tfr_elite&billing=monthly
 * Returns preview of what changes when moving from current to target tier.
 * Used to populate the confirmation screen before Stripe redirect.
 */
router.get('/tier-preview', requireAuth, asyncRoute(async (req, res) => {
  const { to_tier, billing = 'monthly' } = req.query;

  if (!to_tier || !TIER_HIERARCHY.includes(to_tier)) {
    return res.status(400).json({ error: 'Valid to_tier required', valid_tiers: TIER_HIERARCHY });
  }

  const { tier: currentTier, paid_until } = await getUserCurrentTier(req.userId);

  const direction = isUpgrade(currentTier, to_tier) ? 'upgrade'
    : isDowngrade(currentTier, to_tier) ? 'downgrade' : 'same';

  const stripeLink = getStripeLink(to_tier, billing);
  const billingLabel = to_tier === 'sovereign_executive' ? 'one-time' : billing;

  res.json({
    from_tier: currentTier,
    from_display: TIER_DISPLAY_NAMES[currentTier] || currentTier,
    to_tier,
    to_display: TIER_DISPLAY_NAMES[to_tier] || to_tier,
    direction,
    billing: billingLabel,
    current_monthly_cents: TIER_MONTHLY_CENTS[currentTier] || 0,
    new_monthly_cents: TIER_MONTHLY_CENTS[to_tier] || 0,
    price_diff_cents: (TIER_MONTHLY_CENTS[to_tier] || 0) - (TIER_MONTHLY_CENTS[currentTier] || 0),
    new_features: TIER_FEATURES[to_tier] || [],
    current_paid_until: paid_until,
    stripe_link: stripeLink,
    // Downgrade-specific: what you lose
    features_lost: direction === 'downgrade' ? (TIER_FEATURES[currentTier] || []).filter(
      f => !(TIER_FEATURES[to_tier] || []).includes(f)
    ) : [],
    data_preserved: true, // We always preserve data on downgrade
    features_locked: direction === 'downgrade', // Features locked but data preserved
  });
}));

/**
 * POST /api/mod_subscription/change-tier
 * Body: { to_tier, billing, reason }
 *
 * For upgrades: returns stripe_link for redirect.
 * For downgrades: directly updates pricing_tier (data preserved, features locked).
 * Android fix: always returns stripe_link for new-payment upgrades instead of
 * redirecting to signup — client must open stripe_link in same tab.
 */
router.post('/change-tier', requireAuth, asyncRoute(async (req, res) => {
  const { to_tier, billing = 'monthly', reason = 'user_request' } = req.body;

  if (!to_tier || !TIER_HIERARCHY.includes(to_tier)) {
    return res.status(400).json({ error: 'Valid to_tier required' });
  }

  const pool = getPool();
  const { tier: currentTier, plan, paid_until, email } = await getUserCurrentTier(req.userId);

  if (currentTier === to_tier) {
    return res.status(400).json({ error: 'Already on this tier' });
  }

  const direction = isUpgrade(currentTier, to_tier) ? 'upgrade' : 'downgrade';

  if (direction === 'upgrade') {
    // For upgrades: return Stripe link (client redirects, no in-place change yet)
    const stripeLink = getStripeLink(to_tier, billing);
    if (!stripeLink) {
      return res.status(503).json({
        error: `Payment link for ${to_tier} not configured`,
        contact: 'admin@factsmoney.com',
      });
    }

    // Track the intent
    await recordTierChangeEvent(req.userId, currentTier, to_tier, `upgrade_intent:${reason}`);

    // Store upgrade intent in user_events for webhook reconciliation
    await pool.query(
      `INSERT INTO user_events (user_id, event_type, metadata, created_at)
       VALUES ($1, 'tier_upgrade_intent', $2, NOW())`,
      [req.userId, JSON.stringify({ from_tier: currentTier, to_tier, billing, email })]
    );

    return res.json({
      action: 'redirect_to_stripe',
      stripe_link: stripeLink,
      from_tier: currentTier,
      to_tier,
      billing,
      message: `Redirecting to payment for ${TIER_DISPLAY_NAMES[to_tier]} tier`,
    });
  }

  // Downgrade: update immediately, preserve all data, lock features
  await pool.query(
    `UPDATE users
     SET pricing_tier = $1,
         plan = CASE WHEN $1 = 'free' THEN 'free' ELSE plan END,
         updated_at = NOW()
     WHERE id = $2`,
    [to_tier, req.userId]
  );

  await recordTierChangeEvent(req.userId, currentTier, to_tier, reason);

  return res.json({
    action: 'downgraded',
    from_tier: currentTier,
    to_tier,
    display_name: TIER_DISPLAY_NAMES[to_tier],
    message: `Tier changed to ${TIER_DISPLAY_NAMES[to_tier]}. Your data is preserved. Some features are now locked.`,
    data_preserved: true,
    features_locked: true,
  });
}));

/**
 * POST /api/mod_subscription/admin/set-tier
 * Admin-only (chris.finrev@gmail.com, ecci2760@gmail.com).
 * Sets tier for ANY user, bypasses payment, adds "TESTING" marker.
 * Body: { target_email, tier }
 */
router.post('/admin/set-tier', requireAdminTest, asyncRoute(async (req, res) => {
  const { target_email, tier } = req.body;

  if (!target_email || !tier) {
    return res.status(400).json({ error: 'target_email and tier required' });
  }

  const normalizedTier = normalizeTier(tier);
  if (!TIER_HIERARCHY.includes(normalizedTier)) {
    return res.status(400).json({ error: 'Invalid tier', valid: TIER_HIERARCHY });
  }

  const pool = getPool();

  // Find target user
  const userResult = await pool.query(
    'SELECT id, email, pricing_tier FROM users WHERE LOWER(email) = LOWER($1)',
    [target_email]
  );

  if (!userResult.rows.length) {
    return res.status(404).json({ error: `User ${target_email} not found` });
  }

  const targetUser = userResult.rows[0];
  const previousTier = normalizeTier(targetUser.pricing_tier || 'free');

  // Set tier directly, mark as testing override
  const paidUntil = normalizedTier === 'free' ? null : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year

  await pool.query(
    `UPDATE users
     SET pricing_tier = $1,
         plan = CASE WHEN $1 = 'free' THEN 'free' ELSE 'paid' END,
         paid_until = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [normalizedTier, paidUntil, targetUser.id]
  );

  // Record admin override event
  await pool.query(
    `INSERT INTO user_events (user_id, event_type, metadata, created_at)
     VALUES ($1, 'tier_admin_override', $2, NOW())`,
    [targetUser.id, JSON.stringify({
      from_tier: previousTier,
      to_tier: normalizedTier,
      set_by: req.userEmail,
      testing: true,
      display_label: `TESTING: ${TIER_DISPLAY_NAMES[normalizedTier]}`,
    })]
  );

  res.json({
    success: true,
    target_email: targetUser.email,
    previous_tier: previousTier,
    new_tier: normalizedTier,
    display_name: `TESTING: ${TIER_DISPLAY_NAMES[normalizedTier]}`,
    paid_until: paidUntil,
    set_by: req.userEmail,
    message: `Tier set to TESTING: ${TIER_DISPLAY_NAMES[normalizedTier]} for ${targetUser.email}`,
  });
}));

/**
 * GET /api/mod_subscription/history
 * Returns tier change history for the current user.
 */
router.get('/history', requireAuth, asyncRoute(async (req, res) => {
  const pool = getPool();
  const r = await pool.query(
    `SELECT event_type, metadata, created_at
     FROM user_events
     WHERE user_id = $1
       AND event_type IN ('tier_change', 'tier_upgrade_intent', 'tier_admin_override')
     ORDER BY created_at DESC
     LIMIT 20`,
    [req.userId]
  );

  res.json({
    history: r.rows.map(row => ({
      event: row.event_type,
      ...row.metadata,
      occurred_at: row.created_at,
    }))
  });
}));

/**
 * GET /api/mod_subscription/admin/users
 * Admin-only. Lists all users with tier info for testing dashboard.
 */
router.get('/admin/users', requireAdminTest, asyncRoute(async (req, res) => {
  const pool = getPool();
  const r = await pool.query(
    `SELECT id, email, pricing_tier, plan, paid_until, created_at
     FROM users
     ORDER BY created_at DESC
     LIMIT 100`
  );

  res.json({
    users: r.rows.map(u => ({
      id: u.id,
      email: u.email,
      tier: normalizeTier(u.pricing_tier || 'free'),
      display_name: TIER_DISPLAY_NAMES[normalizeTier(u.pricing_tier || 'free')],
      plan: u.plan,
      paid_until: u.paid_until,
      created_at: u.created_at,
    }))
  });
}));

// ─── Module export ────────────────────────────────────────────────────────────
module.exports = {
  metadata: {
    name: 'Subscription Tier Management',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true,
  },
  routes: router,
  healthCheck: async () => ({
    module: 'mod_subscription',
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  }),
  // Expose tier utilities for use by other modules (e.g., mod_ai_coach)
  TIER_HIERARCHY,
  TIER_DISPLAY_NAMES,
  getTierRank,
};
