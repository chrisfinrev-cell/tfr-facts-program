/**
 * mod_legacy_lens — Legacy Lens Module
 *
 * Add-on: $29/mo for Elite, included in Business/Sovereignty
 *
 * Features:
 *   - Sovereign Health Score (3-pillar: Floor / Shield / Engine)
 *   - Equity Visualization (3 asset classes)
 *   - Entity Hierarchy Visualizer (corporate structure)
 *   - Silent Architect Overlay (PII stripping for Business/Sovereignty)
 *   - Tier-aware rendering & blurred preview for locked users
 *
 * Schema: mod_legacy_lens (entities, equity_assets)
 *
 * Routes (mounted at /api/mod_legacy_lens):
 *   GET  /health
 *   GET  /status           — tier check + access info
 *   GET  /health-score     — 3-pillar Sovereign Health Score
 *   GET  /equity           — equity assets by class
 *   POST /equity           — add equity asset
 *   PATCH /equity/:id      — update equity asset
 *   DELETE /equity/:id     — remove equity asset
 *   GET  /entities         — entity hierarchy tree
 *   POST /entities         — add entity
 *   PATCH /entities/:id    — update entity
 *   DELETE /entities/:id   — remove entity
 *
 * © T-Dagsis LLC. All rights reserved.
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const { asyncRoute } = require('../../module-error-boundary');
const { checkModuleAccess, computeHealthScore, normalizeTier, tierRank } = require('./health-score');

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

// ─── Silent Architect overlay ─────────────────────────────────────────────────
// For Business/Sovereignty users: strip PII from data
function applySilentArchitect(data, tier) {
  if (tierRank(tier) < tierRank('business')) return data;

  // Replace identifying info with pseudo-labels
  const pseudoify = (str, prefix) => {
    if (!str) return null;
    // Keep first char, hash rest
    const hash = Buffer.from(str).toString('base64').substring(0, 6).toUpperCase();
    return `${prefix}-${hash}`;
  };

  if (Array.isArray(data)) {
    return data.map(item => applySilentArchitectItem(item, tier, pseudoify));
  }
  return applySilentArchitectItem(data, tier, pseudoify);
}

function applySilentArchitectItem(item, tier, pseudoify) {
  if (!item || typeof item !== 'object') return item;
  const clean = { ...item };
  if (clean.ein) clean.ein = pseudoify(clean.ein, 'EIN');
  if (clean.account_mask) clean.account_mask = '****';
  if (clean.institution_name) clean.institution_name = pseudoify(clean.institution_name, 'INST');
  // Sovereignty: also strip entity names beyond initials
  if (tierRank(tier) >= tierRank('sovereignty')) {
    if (clean.email) clean.email = pseudoify(clean.email, 'EMAIL');
  }
  return clean;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
const router = express.Router();

// Health check — no auth required
router.get('/health', asyncRoute(async (req, res) => {
  const pool = getPool();
  try {
    await pool.query('SELECT 1 FROM mod_legacy_lens.entities LIMIT 1');
    res.json({ status: 'ok', module: 'mod_legacy_lens', version: '1.0.0' });
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

  const access = await checkModuleAccess(user, 'legacy_lens', pool);
  res.json({
    module: 'legacy_lens',
    ...access,
    user_tier: access.tier
  });
}));

// ─── Sovereign Health Score ────────────────────────────────────────────────────
router.get('/health-score', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'legacy_lens', pool);
  if (!access.allowed) {
    // Return preview data (real but blurred on frontend)
    const score = await computeHealthScore(req.session.userId, pool);
    return res.status(423).json({
      locked: true,
      reason: access.reason,
      price_cents: access.price_cents,
      tier: access.tier,
      preview: {
        composite_score: score.composite_score,
        sovereignty_level: score.sovereignty_level,
        // Tease 3 metrics but blur values on frontend
        teaser: [
          { label: 'The Floor', status: score.necessities_index?.status || 'unknown' },
          { label: 'The Shield', status: score.reserve_index?.status || 'unknown' },
          { label: 'The Engine', status: score.growth_index?.status || 'unknown' }
        ]
      }
    });
  }

  const score = await computeHealthScore(req.session.userId, pool);

  // Apply PII overlay for Business/Sovereignty
  const tier = normalizeTier(user.pricing_tier || user.subscription_tier);
  const response = tierRank(tier) >= tierRank('business')
    ? { ...score, silent_architect: true }
    : score;

  res.json(response);
}));

// ─── Equity Assets ────────────────────────────────────────────────────────────

const VALID_ASSET_CLASSES = ['digital_assets', 'intellectual_property', 'information_systems'];

router.get('/equity', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'legacy_lens', pool);
  if (!access.allowed) {
    return res.status(423).json({ locked: true, reason: access.reason, price_cents: access.price_cents });
  }

  const { rows } = await pool.query(
    `SELECT ea.*, e.entity_name
     FROM mod_legacy_lens.equity_assets ea
     LEFT JOIN mod_legacy_lens.entities e ON ea.entity_id = e.id
     WHERE ea.user_id = $1 AND ea.is_active = true
     ORDER BY ea.asset_class, ea.created_at DESC`,
    [req.session.userId]
  );

  // Group by asset class
  const grouped = {
    digital_assets: [],
    intellectual_property: [],
    information_systems: []
  };

  const tier = normalizeTier(user.pricing_tier || user.subscription_tier);
  const assets = applySilentArchitect(rows, tier);
  for (const asset of assets) {
    if (grouped[asset.asset_class]) grouped[asset.asset_class].push(asset);
  }

  // Totals per class
  const totals = {};
  for (const cls of VALID_ASSET_CLASSES) {
    totals[cls] = grouped[cls].reduce((sum, a) => sum + (a.estimated_value_cents || 0), 0);
  }
  const grand_total = Object.values(totals).reduce((s, v) => s + v, 0);

  res.json({ assets: grouped, totals, grand_total });
}));

router.post('/equity', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'legacy_lens', pool);
  if (!access.allowed) return res.status(423).json({ locked: true, reason: access.reason });

  const { asset_class, asset_name, estimated_value_cents, notes, entity_id } = req.body;
  if (!asset_class || !VALID_ASSET_CLASSES.includes(asset_class)) {
    return res.status(400).json({ error: 'Invalid asset_class. Must be: ' + VALID_ASSET_CLASSES.join(', ') });
  }
  if (!asset_name?.trim()) return res.status(400).json({ error: 'asset_name required' });

  const { rows } = await pool.query(
    `INSERT INTO mod_legacy_lens.equity_assets
       (user_id, asset_class, asset_name, estimated_value_cents, notes, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      req.session.userId,
      asset_class,
      asset_name.trim(),
      Math.max(0, parseInt(estimated_value_cents) || 0),
      notes || null,
      entity_id || null
    ]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/equity/:id', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'legacy_lens', pool);
  if (!access.allowed) return res.status(423).json({ locked: true });

  const { asset_name, estimated_value_cents, notes, entity_id, is_active } = req.body;
  const { rows } = await pool.query(
    `UPDATE mod_legacy_lens.equity_assets
     SET asset_name           = COALESCE($1, asset_name),
         estimated_value_cents = COALESCE($2, estimated_value_cents),
         notes                = COALESCE($3, notes),
         entity_id            = COALESCE($4, entity_id),
         is_active            = COALESCE($5, is_active),
         updated_at           = NOW()
     WHERE id = $6 AND user_id = $7
     RETURNING *`,
    [
      asset_name?.trim() || null,
      estimated_value_cents != null ? parseInt(estimated_value_cents) : null,
      notes !== undefined ? notes : null,
      entity_id !== undefined ? entity_id : null,
      is_active !== undefined ? is_active : null,
      parseInt(req.params.id),
      req.session.userId
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Asset not found' });
  res.json(rows[0]);
}));

router.delete('/equity/:id', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  await pool.query(
    `UPDATE mod_legacy_lens.equity_assets SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [parseInt(req.params.id), req.session.userId]
  );
  res.json({ ok: true });
}));

// ─── Entity Hierarchy ─────────────────────────────────────────────────────────

const VALID_ENTITY_TYPES = ['holding_co', 'operating_llc', 'brokerage', 'trust', 'individual', 'other'];

router.get('/entities', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'legacy_lens', pool);
  if (!access.allowed) {
    return res.status(423).json({ locked: true, reason: access.reason, price_cents: access.price_cents });
  }

  const { rows } = await pool.query(
    `SELECT e.*,
       json_agg(json_build_object(
         'id', ea.id,
         'asset_class', ea.asset_class,
         'asset_name', ea.asset_name,
         'estimated_value_cents', ea.estimated_value_cents
       ) ORDER BY ea.created_at) FILTER (WHERE ea.id IS NOT NULL) AS tagged_assets
     FROM mod_legacy_lens.entities e
     LEFT JOIN mod_legacy_lens.equity_assets ea
       ON ea.entity_id = e.id AND ea.is_active = true
     WHERE e.user_id = $1 AND e.is_active = true
     GROUP BY e.id
     ORDER BY e.display_order, e.created_at`,
    [req.session.userId]
  );

  const tier = normalizeTier(user.pricing_tier || user.subscription_tier);
  const entities = applySilentArchitect(rows, tier);

  // Build tree structure
  const rootEntities = [];
  const entityMap = {};
  for (const e of entities) {
    entityMap[e.id] = { ...e, children: [] };
  }
  for (const e of entities) {
    if (e.parent_id && entityMap[e.parent_id]) {
      entityMap[e.parent_id].children.push(entityMap[e.id]);
    } else {
      rootEntities.push(entityMap[e.id]);
    }
  }

  // All personal → show onboarding CTA
  const allPersonal = entities.every(e => e.entity_type === 'individual');

  res.json({
    entities: rootEntities,
    all_personal: allPersonal,
    show_onboarding_cta: allPersonal && entities.length > 0,
    total_entities: entities.length
  });
}));

router.post('/entities', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'legacy_lens', pool);
  if (!access.allowed) return res.status(423).json({ locked: true, reason: access.reason });

  const { entity_name, entity_type = 'individual', parent_id, description, state_of_formation, ein, display_order = 0 } = req.body;
  if (!entity_name?.trim()) return res.status(400).json({ error: 'entity_name required' });
  if (!VALID_ENTITY_TYPES.includes(entity_type)) {
    return res.status(400).json({ error: 'Invalid entity_type. Must be: ' + VALID_ENTITY_TYPES.join(', ') });
  }

  const { rows } = await pool.query(
    `INSERT INTO mod_legacy_lens.entities
       (user_id, entity_name, entity_type, parent_id, description, state_of_formation, ein, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      req.session.userId,
      entity_name.trim(),
      entity_type,
      parent_id || null,
      description || null,
      state_of_formation || null,
      ein || null,
      display_order
    ]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/entities/:id', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkModuleAccess(user, 'legacy_lens', pool);
  if (!access.allowed) return res.status(423).json({ locked: true });

  const { entity_name, entity_type, parent_id, description, state_of_formation, ein, display_order, is_active } = req.body;
  const { rows } = await pool.query(
    `UPDATE mod_legacy_lens.entities
     SET entity_name        = COALESCE($1, entity_name),
         entity_type        = COALESCE($2, entity_type),
         parent_id          = COALESCE($3, parent_id),
         description        = COALESCE($4, description),
         state_of_formation = COALESCE($5, state_of_formation),
         ein                = COALESCE($6, ein),
         display_order      = COALESCE($7, display_order),
         is_active          = COALESCE($8, is_active),
         updated_at         = NOW()
     WHERE id = $9 AND user_id = $10
     RETURNING *`,
    [
      entity_name?.trim() || null,
      entity_type || null,
      parent_id !== undefined ? parent_id : null,
      description !== undefined ? description : null,
      state_of_formation !== undefined ? state_of_formation : null,
      ein !== undefined ? ein : null,
      display_order != null ? parseInt(display_order) : null,
      is_active !== undefined ? is_active : null,
      parseInt(req.params.id),
      req.session.userId
    ]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Entity not found' });
  res.json(rows[0]);
}));

router.delete('/entities/:id', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  await pool.query(
    `UPDATE mod_legacy_lens.entities SET is_active = false, updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [parseInt(req.params.id), req.session.userId]
  );
  res.json({ ok: true });
}));

// ─── Module export ─────────────────────────────────────────────────────────────
module.exports = {
  metadata: {
    name: 'Legacy Lens',
    moduleId: 'legacy_lens',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: false,
    addonPriceCents: 2900,
    description: 'Entity Hierarchy Visualizer, Equity Vault, and Sovereign Health Score'
  },

  routes: router,

  healthCheck: async (pool) => {
    try {
      await pool.query('SELECT 1 FROM mod_legacy_lens.entities LIMIT 1');
      return { module: 'mod_legacy_lens', status: 'ok', version: '1.0.0' };
    } catch (e) {
      return { module: 'mod_legacy_lens', status: 'degraded', error: e.message };
    }
  }
};
