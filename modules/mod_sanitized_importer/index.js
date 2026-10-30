/**
 * mod_sanitized_importer — Sovereign Sanitized Importer
 *
 * Add-on: $19.99/mo for Elite tier
 * Privacy Protocol: Silent_Architect_Zero_PII
 *
 * Features:
 *   - PII Radioactive Pattern firewall (SSN, account numbers, names)
 *   - Mathematical extraction only: TICKER, QTY, BASIS, YLD, CLASS, DATE, UID
 *   - Post-import CSV purge (raw file NEVER persisted)
 *   - Sovereign Credit Score computation
 *   - Monthly Income Estimate: SUM(QTY × BASIS × YLD / 100 / 12)
 *   - Sanitized template download
 *   - Upsell triggers for free and elite-without-addon users
 *   - Blurred preview for locked users
 *   - Cross-module bridge to lending_desk (liquidity recalc) and legacy_lens (heatmap)
 *
 * Stripe: https://buy.stripe.com/8x2eVe4hB8WZ7VMalJ7Re0g ($19.99/mo)
 *
 * Schema: mod_brokerage (shared with mod_brokerage)
 *
 * Routes (mounted at /api/mod_sanitized_importer):
 *   GET  /health
 *   GET  /status          — access check + upsell triggers
 *   GET  /template        — download sanitized CSV template
 *   POST /import          — full CSV sanitization + import pipeline
 *   GET  /sessions        — past import sessions
 *   GET  /positions       — imported portfolio positions
 *   GET  /metrics         — sovereign credit score + monthly income est
 *   GET  /preview         — blurred preview payload for locked users
 *   POST /upsell/dismiss  — dismiss a upsell trigger for 7 days
 *
 * © T-Dagsis LLC. All rights reserved.
 */

'use strict';

const express  = require('express');
const multer   = require('multer');
const { parse: csvParse } = require('csv-parse/sync');
const { Pool } = require('pg');
const { asyncRoute } = require('../../module-error-boundary');

// ─── Stripe add-on link ───────────────────────────────────────────────────────
const STRIPE_LINK = 'https://buy.stripe.com/8x2eVe4hB8WZ7VMalJ7Re0g';
const ADDON_ID    = 'sanitized_importer';

// ─── DB Pool (lazy-init) ─────────────────────────────────────────────────────
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

// ─── Access check ─────────────────────────────────────────────────────────────
async function checkAccess(user, pool) {
  const tier = normalizeTier(user.pricing_tier || user.subscription_tier || user.plan || '');

  // Business/Sovereignty → always included
  if (tierRank(tier) >= tierRank('business')) {
    return { allowed: true, tier, reason: 'included', stripe_link: null };
  }

  // Elite → check per-user add-on flag
  if (tier === 'elite') {
    // Check bundle coverage
    const bundleRow = await pool.query(
      `SELECT ub.id FROM core.user_bundles ub
       WHERE ub.user_id = $1
         AND ub.status = 'active'
         AND (ub.selected_modules ? $2 OR
              EXISTS (SELECT 1 FROM core.bundles b
                      WHERE b.bundle_id = ub.bundle_id AND b.is_full_stack = true))
       LIMIT 1`,
      [user.id, ADDON_ID]
    );
    if (bundleRow.rows.length > 0) {
      return { allowed: true, tier, reason: 'bundle', stripe_link: null };
    }

    // Check individual add-on flag
    const { rows } = await pool.query(
      `SELECT status FROM core.module_flags
       WHERE module_id = $1 AND user_id = $2 LIMIT 1`,
      [ADDON_ID, user.id]
    );
    if (rows[0]?.status === 'enabled') {
      return { allowed: true, tier, reason: 'addon', stripe_link: null };
    }
    return { allowed: false, tier, reason: 'addon_required', stripe_link: STRIPE_LINK };
  }

  return { allowed: false, tier, reason: 'tier_upgrade_required', stripe_link: null };
}

// ─── Get user row ─────────────────────────────────────────────────────────────
async function getUser(userId, pool) {
  const { rows } = await pool.query(
    `SELECT id, email, first_name, pricing_tier, subscription_tier, plan
     FROM users WHERE id = $1`,
    [userId]
  );
  return rows[0] || null;
}

// ─── PII Radioactive Scanner ──────────────────────────────────────────────────
const RADIOACTIVE_PATTERNS = [
  /\b\d{9,16}\b/,                           // Account numbers / SSN / card numbers
  /\b(Name|Owner|SSN|Social Security)\b/i,  // PII headers
];

function scanForRadioactiveData(rows, headers) {
  // Check headers
  for (const h of headers) {
    if (RADIOACTIVE_PATTERNS.some(p => p.test(h))) {
      return { contaminated: true, reason: `Radioactive header detected: "${h}"` };
    }
  }
  // Check cell values
  for (const row of rows) {
    for (const [key, val] of Object.entries(row)) {
      const cellStr = String(val ?? '');
      for (const pattern of RADIOACTIVE_PATTERNS) {
        if (pattern.test(cellStr)) {
          return {
            contaminated: true,
            reason: `Radioactive data detected in column "${key}": potential PII pattern found`
          };
        }
      }
    }
  }
  return { contaminated: false };
}

// ─── Allowed CSV fields ───────────────────────────────────────────────────────
const ALLOWED_FIELDS = ['UID', 'TICKER', 'CLASS', 'QTY', 'BASIS', 'YLD', 'DATE'];
const VALID_ASSET_CLASSES = ['EQ', 'FI', 'OPT', 'REIT', 'CRYPTO', 'OTHER'];

function parseRow(raw) {
  return {
    uid:    String(raw.UID   || raw.uid   || '').trim(),
    ticker: String(raw.TICKER|| raw.ticker|| '').trim().toUpperCase(),
    class_: String(raw.CLASS || raw.class || 'EQ').trim().toUpperCase(),
    qty:    parseFloat(raw.QTY   || raw.qty   || '0') || 0,
    basis:  parseFloat(raw.BASIS || raw.basis || '0') || 0,
    yld:    parseFloat(raw.YLD   || raw.yld   || '0') || 0,
    date:   String(raw.DATE  || raw.date  || '').trim()
  };
}

function normalizeDate(d) {
  if (!d) return null;
  if (/^\d{8}$/.test(d)) {
    // YYYYMMDD → YYYY-MM-DD
    return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
  }
  return d;  // accept ISO or other formats
}

// ─── Sovereign Credit Score ───────────────────────────────────────────────────
function computeSovereignCreditScore(positions) {
  if (!positions.length) return 0;

  // Diversity: unique tickers
  const uniqueTickers  = new Set(positions.map(p => p.ticker)).size;
  const diversityScore = Math.min(uniqueTickers / 10, 1) * 40;  // max 40 pts

  // Class diversity
  const uniqueClasses = new Set(positions.map(p => p.class_)).size;
  const classDivScore = Math.min(uniqueClasses / 4, 1) * 20;  // max 20 pts

  // Yield consistency: avg yield
  const avgYield = positions.reduce((sum, p) => sum + p.yld, 0) / positions.length;
  const yieldScore = Math.min(avgYield / 10, 1) * 20;  // max 20 pts

  // Cost basis recovery: ratio of high-basis assets
  const basisValues = positions.map(p => p.basis).filter(b => b > 0);
  const avgBasis    = basisValues.length
    ? basisValues.reduce((s, b) => s + b, 0) / basisValues.length
    : 0;
  const basisScore  = Math.min(avgBasis / 100, 1) * 20;  // max 20 pts

  return Math.round((diversityScore + classDivScore + yieldScore + basisScore) * 10) / 10;
}

// ─── Monthly Income Estimate ──────────────────────────────────────────────────
// SUM(QTY × BASIS × YLD / 100 / 12)
function computeMonthlyIncome(positions) {
  return positions.reduce((sum, p) => sum + (p.qty * p.basis * (p.yld / 100) / 12), 0);
}

// ─── Multer (in-memory only — no disk write) ───────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB cap
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted by the Sanitized Importer.'));
    }
  }
});

// ─── Router ───────────────────────────────────────────────────────────────────
const router = express.Router();

// GET /health
router.get('/health', asyncRoute(async (req, res) => {
  const pool = getPool();
  try {
    await pool.query(`SELECT 1 FROM mod_brokerage.importer_sessions LIMIT 1`);
    res.json({ status: 'ok', module: 'mod_sanitized_importer', version: '1.0.0' });
  } catch (e) {
    res.json({ status: 'schema_missing', module: 'mod_sanitized_importer', error: e.message });
  }
}));

// GET /status — access check + upsell trigger hints
router.get('/status', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const access = await checkAccess(user, pool);

  // Count manual entries to decide upsell trigger
  const manualCount = await pool.query(
    `SELECT COUNT(*) AS cnt FROM mod_brokerage.assets
     WHERE user_id = $1 AND import_source = 'manual'`,
    [user.id]
  ).catch(() => ({ rows: [{ cnt: 0 }] }));
  const manualEntryCount = parseInt(manualCount.rows[0]?.cnt || 0);

  // Check 7-day dismiss cooldown
  async function isDismissed(triggerId) {
    const r = await pool.query(
      `SELECT dismissed_at FROM core.addon_upsell_dismissals
       WHERE user_id = $1 AND trigger_id = $2
         AND dismissed_at > NOW() - INTERVAL '7 days'
       LIMIT 1`,
      [user.id, triggerId]
    ).catch(() => ({ rows: [] }));
    return r.rows.length > 0;
  }

  let upsellTrigger = null;
  if (!access.allowed && manualEntryCount > 5) {
    const tier = normalizeTier(user.pricing_tier || user.subscription_tier || user.plan || '');
    if (tier === 'elite') {
      const dismissed = await isDismissed('importer_elite_addon');
      if (!dismissed) {
        upsellTrigger = {
          trigger_id: 'importer_elite_addon',
          headline: "You're entering positions one by one.",
          message: "The Sanitized Importer lets you bulk-load your entire portfolio in one shot — zero PII touches your dashboard.",
          cta: 'Activate Module — $19.99/mo →',
          stripe_link: STRIPE_LINK
        };
      }
    } else {
      const dismissed = await isDismissed('importer_free_upgrade');
      if (!dismissed) {
        upsellTrigger = {
          trigger_id: 'importer_free_upgrade',
          headline: "Managing multiple positions.",
          message: "To maintain your Silent Architect privacy while scaling your portfolio, unlock the Sanitized Importer. It air-gaps your brokerage data from your identity.",
          cta: 'Upgrade to Elite →',
          stripe_link: null  // Elite upgrade link — handled by billing page
        };
      }
    }
  }

  res.json({
    ...access,
    manual_entry_count: manualEntryCount,
    upsell_trigger: upsellTrigger,
    stripe_link: STRIPE_LINK
  });
}));

// GET /template — download sanitized CSV template
router.get('/template', asyncRoute(async (req, res) => {
  const headers = 'UID,TICKER,CLASS,QTY,BASIS,YLD,DATE';
  const sampleRow = 'Portfolio_1,AGNC,EQ,100,9.45,14.5,20260425';
  const instructions = [
    '# SANITIZED TEMPLATE — FACTS Financial Revolution',
    '# Fill in your positions using ONLY mathematical data.',
    '# No account numbers. No names. No SSNs.',
    '# The system will reject any file containing identity data.',
    '#',
    '# Columns:',
    '#   UID    — Your portfolio label (not an account number)',
    '#   TICKER — Stock/fund ticker symbol',
    '#   CLASS  — EQ, FI, OPT, REIT, CRYPTO, or OTHER',
    '#   QTY    — Number of shares/units',
    '#   BASIS  — Cost basis per unit',
    '#   YLD    — Annual yield percentage (e.g. 14.5 = 14.5%)',
    '#   DATE   — Date as YYYYMMDD or YYYY-MM-DD',
    '#',
  ].join('\n');
  const csv = `${instructions}\n${headers}\n${sampleRow}\n`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sanitized-template.csv"');
  res.send(csv);
}));

// POST /import — full sanitization pipeline
router.post('/import', upload.single('file'), asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const user = await getUser(req.session.userId, pool);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Access gate
  const access = await checkAccess(user, pool);
  if (!access.allowed) {
    return res.status(403).json({
      error: 'Module not activated',
      reason: access.reason,
      stripe_link: STRIPE_LINK,
      message: access.reason === 'addon_required'
        ? 'Activate Sanitized Importer ($19.99/mo) to bulk-import your portfolio.'
        : 'Elite tier required to use the Sanitized Importer.'
    });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Send CSV as multipart form field "file".' });
  }

  // Raw file is ONLY in req.file.buffer — never touches disk
  let csvText;
  try {
    csvText = req.file.buffer.toString('utf-8');
  } catch (e) {
    return res.status(400).json({ error: 'Could not read file. Ensure UTF-8 CSV encoding.' });
  }

  // Parse CSV (strip comment lines)
  const cleanedLines = csvText.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
  let records;
  try {
    records = csvParse(cleanedLines, { columns: true, skip_empty_lines: true, trim: true });
  } catch (parseErr) {
    return res.status(400).json({ error: `CSV parse error: ${parseErr.message}` });
  }

  if (!records.length) {
    return res.status(400).json({ error: 'CSV file is empty or has no data rows.' });
  }

  const headers = Object.keys(records[0]);

  // ─── PII Radioactive Scan ─────────────────────────────────────────────────
  const scan = scanForRadioactiveData(records, headers);
  if (scan.contaminated) {
    // Explicitly null out buffer (best-effort in Node GC)
    req.file.buffer = null;
    csvText = null;
    return res.status(422).json({
      error: '🛡️ Radioactive data detected. File purged. Please use the Sanitized Template to strip PII before upload.',
      detail: scan.reason,
      template_url: '/api/mod_sanitized_importer/template'
    });
  }

  // ─── Extract allowed fields only ─────────────────────────────────────────
  const positions = records.map(parseRow).filter(p => p.ticker.length > 0);
  if (!positions.length) {
    return res.status(400).json({ error: 'No valid positions found. Ensure TICKER column is populated.' });
  }

  // Validate asset classes
  for (const pos of positions) {
    if (!VALID_ASSET_CLASSES.includes(pos.class_)) {
      pos.class_ = 'EQ';  // default unknown to equity
    }
  }

  // ─── Compute derived fields ───────────────────────────────────────────────
  const sovereignScore  = computeSovereignCreditScore(positions);
  const monthlyIncome   = computeMonthlyIncome(positions);
  const monthlyIncomeCents = Math.round(monthlyIncome * 100);

  // ─── Purge raw buffer immediately (before DB writes) ──────────────────────
  req.file.buffer = null;
  csvText = null;

  // ─── Write to DB in transaction ───────────────────────────────────────────
  const client = await pool.connect();
  let sessionId;
  try {
    await client.query('BEGIN');

    // Create import session record
    const sessionRes = await client.query(
      `INSERT INTO mod_brokerage.importer_sessions
         (user_id, row_count, status, sovereign_credit_score, monthly_income_est_cents)
       VALUES ($1, $2, 'processing', $3, $4)
       RETURNING id`,
      [user.id, positions.length, sovereignScore, monthlyIncomeCents]
    );
    sessionId = sessionRes.rows[0].id;

    // Insert assets + transactions
    for (const pos of positions) {
      const assetRes = await client.query(
        `INSERT INTO mod_brokerage.assets
           (user_id, ticker_symbol, asset_class, portfolio_label, share_count,
            cost_basis, yield_pct, import_source, session_id, manually_categorized)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'sanitized_csv', $8, false)
         RETURNING id`,
        [user.id, pos.ticker, pos.class_, pos.uid || null,
         pos.qty, pos.basis, pos.yld, sessionId]
      );
      const assetId = assetRes.rows[0].id;

      // Create purchase transaction (negative cash_flow = cost basis paid out)
      const txDate = normalizeDate(pos.date) || new Date().toISOString().slice(0, 10);
      await client.query(
        `INSERT INTO mod_brokerage.transactions
           (user_id, asset_id, session_id, date, share_count, cash_flow,
            import_source, manually_categorized)
         VALUES ($1, $2, $3, $4, $5, $6, 'sanitized_csv', false)`,
        [user.id, assetId, sessionId, txDate,
         pos.qty, -(pos.qty * pos.basis)]
      );
    }

    // Mark session complete
    await client.query(
      `UPDATE mod_brokerage.importer_sessions
       SET status = 'completed', completed_at = NOW()
       WHERE id = $1`,
      [sessionId]
    );

    await client.query('COMMIT');
  } catch (dbErr) {
    await client.query('ROLLBACK');
    client.release();
    // Mark session failed if it was created
    if (sessionId) {
      await pool.query(
        `UPDATE mod_brokerage.importer_sessions SET status = 'failed' WHERE id = $1`,
        [sessionId]
      );
    }
    throw dbErr;
  }
  client.release();

  // ─── Cross-module bridge: notify lending_desk of updated equity ───────────
  // Fire-and-forget (non-blocking). lending_desk recalculates liquidity ratios.
  setImmediate(async () => {
    try {
      const totalEquityCents = positions.reduce((s, p) => s + Math.round(p.qty * p.basis * 100), 0);
      const diversityScore   = sovereignScore;
      // Internal API call — both modules share the same Express instance
      const pool2 = getPool();
      await pool2.query(
        `INSERT INTO core.module_events
           (user_id, module_id, event_type, metadata, occurred_at)
         VALUES ($1, 'mod_sanitized_importer', 'portfolio_imported', $2, NOW())`,
        [user.id, JSON.stringify({
          session_id: sessionId,
          row_count: positions.length,
          total_equity_cents: totalEquityCents,
          portfolio_diversity_score: diversityScore,
          monthly_income_est_cents: monthlyIncomeCents
        })]
      );
    } catch (_) { /* silent — bridge event is best-effort */ }
  });

  res.status(201).json({
    success: true,
    session_id: sessionId,
    positions_imported: positions.length,
    sovereign_credit_score: sovereignScore,
    monthly_income_est: {
      cents: monthlyIncomeCents,
      formatted: `$${(monthlyIncomeCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    },
    message: `${positions.length} positions imported. Raw file purged. Zero PII retained.`
  });
}));

// GET /sessions — import history
router.get('/sessions', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, row_count, status, rejection_reason,
            sovereign_credit_score, monthly_income_est_cents, completed_at, created_at
     FROM mod_brokerage.importer_sessions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [req.session.userId]
  );
  res.json({ sessions: rows });
}));

// GET /positions — current imported positions
router.get('/positions', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  const access = await checkAccess(await getUser(req.session.userId, pool), pool);
  if (!access.allowed) {
    return res.status(403).json({ error: 'Module not activated', stripe_link: STRIPE_LINK });
  }

  const { rows } = await pool.query(
    `SELECT a.id, a.ticker_symbol, a.asset_class, a.portfolio_label,
            a.share_count, a.cost_basis, a.yield_pct, a.import_source,
            a.created_at
     FROM mod_brokerage.assets a
     WHERE a.user_id = $1 AND a.is_active = true
     ORDER BY a.ticker_symbol ASC`,
    [req.session.userId]
  );
  res.json({ positions: rows, count: rows.length });
}));

// GET /metrics — sovereign credit score + monthly income
router.get('/metrics', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  const access = await checkAccess(await getUser(req.session.userId, pool), pool);
  if (!access.allowed) {
    // Return blurred/placeholder metrics for preview
    return res.json({
      locked: true,
      stripe_link: STRIPE_LINK,
      preview: {
        positions_imported: 47,
        sovereign_credit_score: '??',
        monthly_income_est: '$X,XXX.XX'
      }
    });
  }

  const session = await pool.query(
    `SELECT sovereign_credit_score, monthly_income_est_cents, completed_at
     FROM mod_brokerage.importer_sessions
     WHERE user_id = $1 AND status = 'completed'
     ORDER BY completed_at DESC LIMIT 1`,
    [req.session.userId]
  );

  const posCount = await pool.query(
    `SELECT COUNT(*) AS cnt FROM mod_brokerage.assets
     WHERE user_id = $1 AND is_active = true`,
    [req.session.userId]
  );

  const latest = session.rows[0];
  res.json({
    locked: false,
    positions_imported: parseInt(posCount.rows[0]?.cnt || 0),
    sovereign_credit_score: latest?.sovereign_credit_score || null,
    monthly_income_est_cents: latest?.monthly_income_est_cents || 0,
    monthly_income_est_formatted: latest
      ? `$${(latest.monthly_income_est_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
      : '$0.00',
    last_import: latest?.completed_at || null
  });
}));

// GET /preview — blurred preview payload for locked users
router.get('/preview', asyncRoute(async (req, res) => {
  res.json({
    locked: true,
    stripe_link: STRIPE_LINK,
    addon_price: '$19.99/mo',
    preview_metrics: {
      positions_imported: { value: 47, blurred: true },
      monthly_income_est: { value: '$X,XXX', blurred: true },
      sovereign_credit_score: { value: '??', blurred: true }
    },
    cta: {
      label: 'Activate Sanitized Importer — $19.99/mo',
      url: STRIPE_LINK
    },
    features: [
      'Bulk CSV portfolio import',
      'Zero-PII privacy firewall',
      'Sovereign Credit Score',
      'Monthly Income Estimate',
      'Auto-purge after processing'
    ]
  });
}));

// POST /upsell/dismiss — record 7-day dismiss
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

// ─── Module export ─────────────────────────────────────────────────────────────
module.exports = {
  metadata: {
    name: 'Sovereign Sanitized Importer',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: false,  // gated: Elite + active add-on
    addon_id: ADDON_ID,
    price_cents: 1999,
    stripe_link: STRIPE_LINK
  },

  routes: router,

  healthCheck: async (pool) => {
    try {
      await pool.query(`SELECT 1 FROM mod_brokerage.importer_sessions LIMIT 1`);
      return { module: 'mod_sanitized_importer', status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() };
    } catch (e) {
      return { module: 'mod_sanitized_importer', status: 'error', error: e.message, timestamp: new Date().toISOString() };
    }
  }
};
