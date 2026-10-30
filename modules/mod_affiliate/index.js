/**
 * Affiliate Program Module
 * Referral, commissions, and the 10-tier orphan split engine (FACTS / factsmoney.com).
 */

'use strict';

const express = require('express');
const { pool } = require('../../db/pool');
const { asyncRoute } = require('../../module-error-boundary');
const { withManualExecutionNotice } = require('../shared/edu-compliance');
const { seedDefaultAllocations } = require('./seed-allocations');
const { recordAffiliateMilestone } = require('./milestones');
const {
  routeOrphanUser,
  getTierForCount,
  assignsToCompany,
  decidePlacement,
  resolveCompanyRootId,
  ORPHAN_TIERS
} = require('./orphan-router');

const MIGRATION_NAME = 'orphan_split_engine_and_bucket_state';
const COMPANY_KEEP_SAMPLES = [1, 50, 51, 52, 201, 203, 19551, 19601];

async function flag(pool, sql, params) {
  try {
    const r = await pool.query(sql, params || []);
    const v = r.rows[0] && Object.values(r.rows[0])[0];
    return v === true || v === 't' || v === 1;
  } catch (_) {
    return false;
  }
}

function splitSample(nextIndex) {
  const preview = decidePlacement(nextIndex, 'AFFILIATE', 'COMPANY');
  return {
    next_index: nextIndex,
    tier_level: preview.tierLevel,
    split: preview.splitLabel,
    cycle_size: preview.cycleSize,
    assigns_to_company: preview.destination === 'company',
    destination: preview.destination
  };
}

function getRecommendedTools(userProfile) {
  return withManualExecutionNotice({
    status: 'matched',
    profile_received: !!(userProfile && typeof userProfile === 'object'),
    external_links: [
      { tool: 'High-Yield Savings Portal', category: 'RESERVE', outbound_type: 'CPL' },
      { tool: 'Business Entity Management', category: 'LEGACY', outbound_type: 'CPS' }
    ]
  });
}

async function handleNewRegistration(args) {
  const userId = parseInt(args && args.newUserId, 10);
  if (!userId) return null;
  const { userBlockedFromIncomePrograms } = require('../../config/adminIncomePolicy');
  const { isAffiliateEligible } = require('../../lib/relationshipTags');

  try {
    const userRes = await pool.query(
      `SELECT id, email, affiliate_tier, is_affiliate_disabled, income_programs_blocked, is_admin, is_creator
       FROM users WHERE id = $1`,
      [userId]
    );
    if (userRes.rows[0] && !isAffiliateEligible(userRes.rows[0])) {
      await seedDefaultAllocations(pool, userId);
      return { skipped: true, reason: 'affiliate_excluded' };
    }
  } catch (_) {
    // continue with legacy income-block check
  }

  if (await userBlockedFromIncomePrograms(pool, userId)) {
    await seedDefaultAllocations(pool, userId);
    return { skipped: true, reason: 'admin_income_blocked' };
  }
  const [placement] = await Promise.all([
    routeOrphanUser(pool, args),
    seedDefaultAllocations(pool, userId)
  ]);
  return placement;
}

function wrapSignupResponse(req, res, next) {
  const url = req.originalUrl || req.path || '';
  const isAuthSignup = req.method === 'POST' && /\/api\/auth\/signup\/?$/.test(url.split('?')[0]);
  const isVaultCreate = req.method === 'POST' && /\/api\/mod_onboarding\/vault\/create\/?$/.test(url.split('?')[0]);
  if (!isAuthSignup && !isVaultCreate) return next();

  const origJson = res.json.bind(res);
  res.json = function (body) {
    try {
      const ok = body && body.success !== false && !body.error;
      const userId = body && (
        body.userId ||
        body.user_id ||
        (body.user && (body.user.id || body.user.user_id))
      );
      const refCode = (req.body && (
        req.body.ref_code || req.body.refCode || req.body.referral_code || req.body.ref
      )) || null;
      if (ok && userId) {
        handleNewRegistration({ newUserId: userId, refCode }).catch(function (err) {
          console.error('[mod_affiliate] registration hook:', err.message);
        });
      }
    } catch (err) {
      console.error('[mod_affiliate] signup wrap:', err.message);
    }
    return origJson(body);
  };
  next();
}

const router = express.Router();

router.get('/health', asyncRoute(async function (req, res) {
  res.json({
    status: 'ok',
    version: '1.2.0',
    orphan_tiers: ORPHAN_TIERS.map(function (t) {
      return { level: t.level, range: [t.min, t.max === Infinity ? null : t.max], split: t.label, cycle: t.cycleSize };
    })
  });
}));

router.get('/recommended-tools', asyncRoute(async function (req, res) {
  res.json(getRecommendedTools(req.query || {}));
}));

router.post('/recommended-tools', asyncRoute(async function (req, res) {
  res.json(getRecommendedTools(req.body || {}));
}));

router.post('/on-register', asyncRoute(async function (req, res) {
  const sessionUserId = req.session && req.session.userId;
  if (!sessionUserId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const bodyId = parseInt(
    (req.body && (req.body.user_id || req.body.userId || req.body.newUserId)) || sessionUserId,
    10
  );
  const userId = parseInt(sessionUserId, 10);
  if (bodyId && bodyId !== userId) {
    return res.status(403).json({ error: 'user_id mismatch' });
  }
  if (!userId) {
    return res.status(400).json({ error: 'user_id required' });
  }
  const refCode = (req.body && (req.body.ref_code || req.body.refCode || req.body.referral_code)) || null;
  const affiliateId = req.body && req.body.affiliate_id ? parseInt(req.body.affiliate_id, 10) : undefined;
  const placement = await handleNewRegistration({ newUserId: userId, refCode, affiliateId });
  res.json({ ok: true, placement });
}));

router.get('/orphan-preview', asyncRoute(async function (req, res) {
  if (req.query.examples === '1' || req.query.matrix === '1') {
    return res.json({
      rule: 'Company keep is the last slot of the current tier cycle (position % cycleSize === 0). Split is company:field.',
      note: 'Index 51 is Tier 2 field (1:1 cycle start), not a Tier 10 company keep. Tier 10 company keep example is 19601.',
      samples: COMPANY_KEEP_SAMPLES.map(splitSample)
    });
  }
  const n = parseInt(req.query.next_index || req.query.n, 10);
  if (!n) return res.status(400).json({ error: 'next_index required' });
  const preview = splitSample(n);
  res.json(preview);
}));

// Fallback code generator if custom partnerCode isn't passed
function generatePartnerCode(user) {
  const rawName =
    user.username ||
    user.first_name ||
    user.name ||
    (user.email && String(user.email).split('@')[0]) ||
    'MEMBER';
  const cleanName = String(rawName)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const idPart = String(user.id);
  // Keep within partners.partner_code VARCHAR(50): FR- + name + - + id + - + 4 digits
  const budget = 50 - (3 + 1 + idPart.length + 1 + 4);
  const namePart = (cleanName || 'MEMBER').slice(0, Math.max(1, budget));
  return `FR-${namePart}-${idPart}-${randomSuffix}`;
}

/**
 * @route   POST /api/mod_affiliate/register  (alias: POST /api/affiliates/register)
 * @desc    Register a user as an official FACTS affiliate partner (1 code per user)
 */
router.post('/register', asyncRoute(async function (req, res) {
  const body = req.body || {};
  const sessionUserId = req.session && req.session.userId;
  const userId = parseInt(body.userId || body.user_id || sessionUserId, 10);
  let partnerCode = String(body.partnerCode || body.partner_code || '').trim();
  const parentPartnerId = body.parentPartnerId != null || body.parent_partner_id != null
    ? parseInt(body.parentPartnerId || body.parent_partner_id, 10)
    : null;
  const parentId =
    Number.isInteger(parentPartnerId) && parentPartnerId > 0 ? parentPartnerId : null;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }
  if (sessionUserId && parseInt(sessionUserId, 10) !== userId) {
    return res.status(403).json({ error: 'userId mismatch' });
  }

  // 1-code-per-user: return existing partner node (idempotent)
  const existing = await pool.query(
    `SELECT * FROM partners WHERE user_id = $1 ORDER BY id ASC LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) {
    return res.status(200).json({
      status: 'success',
      partner: existing.rows[0],
      existing: true
    });
  }

  const userRes = await pool.query(
    `SELECT id, name, email FROM users WHERE id = $1`,
    [userId]
  );
  if (!userRes.rows[0]) {
    return res.status(404).json({ error: 'user not found' });
  }

  const autoGenerate = !partnerCode;
  if (autoGenerate) {
    partnerCode = generatePartnerCode(userRes.rows[0]);
  }

  if (!/^[A-Za-z0-9_-]{3,50}$/.test(partnerCode)) {
    return res.status(400).json({
      error: 'partnerCode must be 3–50 chars (letters, numbers, _ or -)'
    });
  }

  const maxAttempts = autoGenerate ? 5 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await pool.query(
        `INSERT INTO partners (user_id, partner_code, parent_partner_id)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [userId, partnerCode, parentId]
      );
      return res.status(201).json({ status: 'success', partner: result.rows[0] });
    } catch (error) {
      if (error && error.code === '23505') {
        // Race: another request created this user's partner
        const raced = await pool.query(
          `SELECT * FROM partners WHERE user_id = $1 ORDER BY id ASC LIMIT 1`,
          [userId]
        );
        if (raced.rows[0]) {
          return res.status(200).json({
            status: 'success',
            partner: raced.rows[0],
            existing: true
          });
        }
        if (autoGenerate && attempt < maxAttempts) {
          partnerCode = generatePartnerCode(userRes.rows[0]);
          continue;
        }
        return res.status(409).json({ error: 'partnerCode already in use' });
      }
      console.error('[AFFILIATE REGISTRATION ERROR]', error);
      return res.status(500).json({ error: 'Failed to register partner account' });
    }
  }

  return res.status(409).json({ error: 'partnerCode already in use' });
}));

/**
 * @route   POST /api/mod_affiliate/milestones
 *          (alias: POST /api/affiliates/milestones)
 * @desc    Record a partner milestone for a referred user (idempotent)
 * Body: { referredUserId, milestoneType, rewardUnits? }
 */
router.post('/milestones', asyncRoute(async function (req, res) {
  const body = req.body || {};
  const referredUserId = parseInt(body.referredUserId || body.referred_user_id || body.userId, 10);
  const milestoneType = String(body.milestoneType || body.milestone_type || '').trim();
  const rewardUnits = body.rewardUnits != null || body.reward_units != null
    ? Number(body.rewardUnits || body.reward_units)
    : undefined;

  if (!referredUserId || !milestoneType) {
    return res.status(400).json({ error: 'referredUserId and milestoneType are required' });
  }

  const result = await recordAffiliateMilestone(pool, referredUserId, milestoneType, rewardUnits);
  if (!result.recorded && result.reason === 'no_referral') {
    return res.status(404).json({ status: 'noop', ...result });
  }
  return res.status(result.recorded ? 201 : 200).json({ status: 'success', ...result });
}));

/**
 * @route   GET /api/mod_affiliate/dashboard/:partnerId
 *          (alias: GET /api/affiliates/dashboard/:partnerId)
 * @desc    Retrieve metrics, referral counts, and milestone stats for a partner
 */
router.get('/dashboard/:partnerId', asyncRoute(async function (req, res) {
  const partnerId = parseInt(req.params.partnerId, 10);
  if (!partnerId) {
    return res.status(400).json({ error: 'partnerId required' });
  }

  try {
    const result = await pool.query(
      `SELECT
         COUNT(DISTINCT ar.id) AS total_referrals,
         COUNT(DISTINCT am.id) AS total_milestones,
         COALESCE(SUM(am.reward_units), 0) AS total_rewards
       FROM partners p
       LEFT JOIN affiliate_referrals ar ON p.id = ar.partner_id
       LEFT JOIN affiliate_milestones am ON p.id = am.partner_id
       WHERE p.id = $1
       GROUP BY p.id`,
      [partnerId]
    );
    return res.status(200).json({ status: 'success', metrics: result.rows[0] || {} });
  } catch (error) {
    console.error('[AFFILIATE DASHBOARD ERROR]', error);
    return res.status(500).json({ error: 'Failed to retrieve partner metrics' });
  }
}));

router.get('/activation-status', asyncRoute(async function (req, res) {
  const envRaw = process.env.COMPANY_ROOT_ID;
  const envId = parseInt(envRaw, 10);
  const envConfigured = Number.isInteger(envId) && envId > 0;

  const schema = {
    migration_applied: await flag(
      pool,
      `SELECT EXISTS (SELECT 1 FROM _migrations WHERE name = $1) AS ok`,
      [MIGRATION_NAME]
    ),
    orphan_assignment_events: await flag(
      pool,
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'orphan_assignment_events'
       ) AS ok`
    ),
    user_bucket_state: await flag(
      pool,
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'user_bucket_state'
       ) AS ok`
    ),
    orphans_assigned_count: await flag(
      pool,
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'affiliates'
            AND column_name = 'orphans_assigned_count'
       ) AS ok`
    ),
    referred_by_affiliate_id: await flag(
      pool,
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'users'
            AND column_name = 'referred_by_affiliate_id'
       ) AS ok`
    )
  };

  let masterNodeId = null;
  let resolvedCompanyRootId = null;
  try {
    resolvedCompanyRootId = await resolveCompanyRootId(pool);
    const master = await pool.query(
      `SELECT id FROM affiliates WHERE is_master_node = true ORDER BY id ASC LIMIT 1`
    );
    masterNodeId = master.rows[0] ? master.rows[0].id : null;
  } catch (_) { /* schema may not exist yet */ }

  const schemaReady = Object.keys(schema).every(function (k) { return schema[k]; });
  const companyReady = envConfigured || masterNodeId != null;

  res.json({
    ready: schemaReady && companyReady,
    migrate: {
      runner: 'npm run migrate',
      not_knex: true,
      file: 'migrations/20260913180000_orphan_split_engine_and_bucket_state.js',
      name: MIGRATION_NAME,
      schema: schema
    },
    company_root: {
      option_a_env_configured: envConfigured,
      option_b_master_node_id: masterNodeId,
      resolved_id: resolvedCompanyRootId,
      ready: companyReady
    },
    verification: {
      idempotent_signup: {
        triggers: [
          'POST /api/auth/signup',
          'POST /api/mod_onboarding/vault/create',
          'POST /api/mod_affiliate/on-register'
        ],
        log_table: 'orphan_assignment_events',
        unique_on: 'new_user_id',
        expected: 'One row per user: affiliate_id, new_user_id, assigned_to_id, tier_level, created_at. Duplicate hooks replay and do not increment orphans_assigned_count.'
      },
      modulo_split: {
        endpoint: 'GET /api/mod_affiliate/orphan-preview?examples=1',
        samples: COMPANY_KEEP_SAMPLES.map(splitSample)
      },
      bucket_dashboard: {
        endpoint: 'GET /api/mod_sweep/bucket-dashboard',
        auth: 'session required',
        tier_gated: false,
        defaults: {
          necessities: 50,
          reserve: 10,
          velocity: 10,
          growth: 10,
          lifestyle: 10,
          legacy: 10
        }
      },
      velocity_paydown: {
        surface: 'app dashboard #velocity-paydown-strip + debts tab',
        automated_payouts: false,
        expected: 'Educational suggested_apply_cents from remaining Velocity; user pays the creditor.'
      }
    }
  });
}));

module.exports = {
  metadata: {
    name: 'Affiliate Program',
    version: '1.2.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true
  },
  routes: router,
  aliasPath: '/api/affiliates',
  aliasRouter: router,
  mountRoot: function (app) {
    app.use(wrapSignupResponse);
  },
  healthCheck: async function (dbPool) {
    const p = dbPool || pool;
    let migrationApplied = false;
    let companyRootId = null;
    let partnersReady = false;
    try {
      const applied = await p.query(
        `SELECT 1 FROM _migrations WHERE name = $1 LIMIT 1`,
        [MIGRATION_NAME]
      );
      migrationApplied = applied.rows.length > 0;
      companyRootId = await resolveCompanyRootId(p);
      const partners = await p.query(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'partners'
         ) AS ok`
      );
      partnersReady = !!(partners.rows[0] && partners.rows[0].ok);
    } catch (_) { /* DB may be unavailable during boot */ }
    return {
      module: 'mod_affiliate',
      status: 'ok',
      version: '1.2.0',
      migration_applied: migrationApplied,
      partners_schema: partnersReady,
      company_root_resolved: companyRootId != null,
      timestamp: new Date().toISOString()
    };
  },
  getRecommendedTools,
  routeOrphanUser,
  handleNewRegistration,
  recordAffiliateMilestone
};
