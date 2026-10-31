/**
 * mod_credit_analysis — Forensic Credit Scan (EDUCATIONAL / CROA-SAFE)
 *
 * Owns: PDF credit report ingestion, AI-powered structural vulnerability analysis,
 *       result storage, anonymous + authenticated rate limiting.
 *
 * Does NOT own: user auth sessions, Stripe payments, FACTS allocations,
 *               gamification XP, Plaid bank sync.
 *
 * REGULATORY POSTURE (CROA):
 *   - Passive reporting only: parse uploaded PDF + return educational metrics.
 *   - NO endpoints that generate, mail, email, fax, or transmit dispute letters
 *     to Equifax, Experian, TransUnion, or any furnisher on the user's behalf.
 *   - FACTS is not a credit repair organization and does not promise deletions
 *     or score increases.
 *
 * Routes (auto-mounted at /api/mod_credit_analysis):
 *   GET  /health         — liveness check
 *   POST /analyze        — upload PDF credit report → returns Structural Vulnerability Report
 *   POST /posture        — read-only educational classification of a transaction list (CROA-safe)
 *   GET  /analysis/:id   — retrieve a previously run analysis
 *   GET  /history        — list user's analyses (authenticated only)
 *
 * Unified vault + forensic (authenticated Import Documents flow):
 *   POST /api/vault/upload-credit-report  — store PDF in vault, clear credit gate, run analyzeReport
 *
 * Rate limits (enforced in /analyze):
 *   Anonymous (no account): 1 scan per IP address, ever.
 *   Free tier:              3 scans per calendar month.
 *   Paid tiers:             Unlimited.
 */

'use strict';

const crypto   = require('crypto');
const express  = require('express');
const { pool } = require('../../db/pool');
const multer   = require('multer');
const { getOpenAI } = require('../../lib/aiClient');
const { asyncRoute } = require('../../module-error-boundary');
const { withManualExecutionNotice } = require('../shared/edu-compliance');

function newAccessToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Use shared pool from db/pool.js — no private Pool creation
function getPool() { return pool; }

// ─── Multer — PDF only, 20 MB max ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') return cb(null, true);
    cb(new Error('Only PDF files are accepted. Export your credit report as PDF and try again.'));
  },
});

// ─── Tier helpers ─────────────────────────────────────────────────────────────
function normalizeTier(plan) {
  if (!plan) return 'free';
  const p = plan.toLowerCase();
  if (p.includes('sovereign')) return 'sovereign';
  if (p.includes('elite'))     return 'elite';
  if (p.includes('business'))  return 'business';
  if (p.includes('family') || p.includes('tfr_pro') || p.includes('household')) return 'family';
  if (p.includes('individual')) return 'individual';
  return 'free';
}

async function getUserTier(userId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT pricing_tier, subscription_tier, plan FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0]) return 'free';
  const u = rows[0];
  return normalizeTier(u.pricing_tier || u.subscription_tier || u.plan || '');
}

// ─── IP extraction ─────────────────────────────────────────────────────────────
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// ─── Rate limit check ──────────────────────────────────────────────────────────
async function checkRateLimit(req) {
  const pool   = getPool();
  const userId = req.session?.userId || null;
  const ip     = getClientIP(req);

  if (!userId) {
    // Anonymous: 1 scan per IP ever
    const { rows } = await pool.query(
      `SELECT COUNT(*) as cnt FROM ip_scan_log WHERE ip_address = $1`,
      [ip]
    );
    if (parseInt(rows[0].cnt) >= 1) {
      return {
        allowed: false,
        reason: 'anonymous_limit',
        message: 'You have used your free scan. Create a free FACTS account to run additional scans and save your history.'
      };
    }
    return { allowed: true, userId: null, ip, tier: 'anonymous' };
  }

  const tier = await getUserTier(userId);
  if (tier !== 'free') {
    // Paid tiers: unlimited
    return { allowed: true, userId, ip, tier };
  }

  // Free tier: 3 per calendar month
  const { rows } = await pool.query(
    `SELECT COUNT(*) as cnt FROM credit_analyses
     WHERE user_id = $1
       AND created_at >= date_trunc('month', NOW())`,
    [userId]
  );
  if (parseInt(rows[0].cnt) >= 3) {
    return {
      allowed: false,
      reason: 'free_monthly_limit',
      message: 'Free accounts are limited to 3 scans per month. Upgrade to a paid plan for unlimited scans.'
    };
  }
  return { allowed: true, userId, ip, tier };
}

// ─── AI Analysis ──────────────────────────────────────────────────────────────
// Extract text from PDF buffer using pdf-parse, then run structured AI analysis.
// Returns the full Structural Vulnerability Report as a JSON object.
async function analyzeReport(pdfBuffer) {
  // pdf-parse is loaded lazily so startup doesn't fail if the package isn't available
  let pdfText = '';
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(pdfBuffer);
    pdfText = data.text || '';
  } catch (err) {
    console.error('[mod_credit_analysis] pdf-parse error:', err.message);
    throw new Error('Could not read the PDF. Make sure your file is a valid credit report PDF.');
  }

  if (!pdfText || pdfText.trim().length < 100) {
    throw new Error('The PDF appears to be empty or image-only. Export a text-based credit report PDF and try again.');
  }

  const aiClient = getOpenAI();

  const { AI_SYSTEM_GUARDRAILS } = require('../shared/edu-compliance');

  const systemPrompt = `You are an educational credit-report literacy assistant for FACTS (Financial Allocation Control & Tracking System).
Analyze the provided credit report text and produce a structured Structural Vulnerability Report in JSON format for educational awareness only.

IMPORTANT: This is NOT credit repair services, legal advice, or a guarantee of score/item outcomes.
Frame findings as educational observations. Prefer wording like "may warrant review with a licensed professional" over directives to dispute/delete.
Do not claim FACTS will remove items, raise scores, or act with bureaus on the user's behalf.

${AI_SYSTEM_GUARDRAILS}

Your job is to identify (educationally):
1. Personal data anomalies — stale/invalid/duplicate addresses. For each, note which negative accounts appear associated (educational observation only; do not direct the user to delete or dispute).
2. Negative items — collections, late payments, charge-offs, judgments. For each: creditor, amount, type, dates, severity (high/medium/low), educational_topic, and which stale address (if any) appears associated.
3. Hard inquiries — each inquiry's creditor, date, type (hard/soft), drop-off date (2-year rule from inquiry date).
4. Account utilization — each open revolving account's credit limit, balance, utilization %, and educational priority note.
5. Action summary — a prioritized numbered list of educational review topics (NOT directives to dispute, delete, or negotiate as a service).

Output ONLY valid JSON matching this exact schema (no markdown, no explanation):
{
  "report_version": "1.0",
  "generated_at": "<ISO timestamp>",
  "educational_only": true,
  "address_vulnerabilities": [
    {
      "address": "<full address string>",
      "status": "stale" | "duplicate" | "typo" | "unknown",
      "years_on_file": <number or null>,
      "anchored_items": [
        { "creditor": "<name>", "account_partial": "<last 4 digits or description>", "type": "<collection|late_payment|charge_off|judgment>", "amount": <number or null> }
      ],
      "forensic_strategy": "<1-2 sentence educational observation; do not instruct deletion or dispute filing>"
    }
  ],
  "negative_items": [
    {
      "creditor": "<name>",
      "type": "<collection|late_payment|charge_off|judgment|other>",
      "amount": <number or null>,
      "date_opened": "<YYYY-MM or null>",
      "last_reported": "<YYYY-MM or null>",
      "severity": "high" | "medium" | "low",
      "educational_topic": "accuracy_review" | "utilization_review" | "aging_observation",
      "recommended_action": "accuracy_review" | "utilization_review" | "aging_observation",
      "anchor_address": "<address string or null>",
      "drop_off_date": "<YYYY-MM or null>"
    }
  ],
  "hard_inquiries": [
    {
      "creditor": "<name>",
      "date": "<YYYY-MM-DD or YYYY-MM>",
      "drop_off_date": "<YYYY-MM-DD>",
      "flagged": <boolean — true if appears unauthorized or unrecognized>
    }
  ],
  "accounts": [
    {
      "creditor": "<name>",
      "account_type": "revolving" | "installment" | "mortgage" | "other",
      "balance": <number or null>,
      "credit_limit": <number or null>,
      "utilization_pct": <number 0-100 or null>,
      "paydown_priority": <1-based integer rank, 1 = most impactful>,
      "status": "current" | "delinquent" | "closed" | "other"
    }
  ],
  "action_summary": [
    "<action string>"
  ],
  "overall_severity": "high" | "medium" | "low",
  "summary_headline": "<1 sentence: e.g. '4 stale addresses anchoring 7 negative items found'>"
}`;

  const userPrompt = `Credit report text (truncated to 12000 chars for processing):\n\n${pdfText.slice(0, 12000)}`;

  const response = await aiClient.chat.completions.create({
    model: 'gpt-4o',
    task: 'credit-analysis',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.1,
    max_tokens: 3000,
  });

  const raw = response.choices[0]?.message?.content || '';

  let analysis;
  try {
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
    analysis = JSON.parse(cleaned);
  } catch (parseErr) {
    console.error('[mod_credit_analysis] AI JSON parse error:', parseErr.message);
    console.error('[mod_credit_analysis] Raw AI response:', raw.slice(0, 500));
    throw new Error('Analysis failed — the AI returned an unexpected format. Please try again.');
  }

  return { analysis, rawText: pdfText.slice(0, 50000) };
}

/**
 * Read-only deterministic classification (CROA compliant).
 * Does not generate, mail, or transmit dispute letters.
 */
function analyzeCreditPosture(transactionHistory = []) {
  const history = Array.isArray(transactionHistory) ? transactionHistory : [];
  return withManualExecutionNotice({
    status: 'analyzed',
    total_records_processed: history.length,
    educational_guidance: 'Review recurring subscription liabilities to improve monthly debt-to-income ratio.'
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────
const router = express.Router();

// GET /health
router.get('/health', (req, res) => {
  res.json({ status: 'ok', module: 'mod_credit_analysis' });
});

router.post('/posture', asyncRoute(async (req, res) => {
  const history = req.body?.transactionHistory || req.body?.transaction_history || [];
  res.json(analyzeCreditPosture(history));
}));

// POST /analyze — main endpoint: accept PDF, parse, analyze, store, return report
router.post('/analyze', upload.single('credit_report'), asyncRoute(async (req, res) => {
  const pool = getPool();

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Please upload your credit report as a PDF.' });
  }

  // Rate limit check
  const limit = await checkRateLimit(req);
  if (!limit.allowed) {
    return res.status(429).json({ error: limit.message, reason: limit.reason });
  }

  const accessToken = newAccessToken();
  let rec;
  try {
    const inserted = await pool.query(
      `INSERT INTO credit_analyses (user_id, ip_address, status, access_token)
       VALUES ($1, $2, 'processing', $3) RETURNING id`,
      [limit.userId, limit.ip, accessToken]
    );
    rec = inserted.rows[0];
  } catch (insertErr) {
    const inserted = await pool.query(
      `INSERT INTO credit_analyses (user_id, ip_address, status)
       VALUES ($1, $2, 'processing') RETURNING id`,
      [limit.userId, limit.ip]
    );
    rec = inserted.rows[0];
  }
  const analysisId = rec.id;

  // Log IP scan (for anonymous rate limiting)
  if (!limit.userId) {
    await pool.query(
      `INSERT INTO ip_scan_log (ip_address, analysis_id) VALUES ($1, $2)`,
      [limit.ip, analysisId]
    );
  }

  try {
    const { analysis, rawText } = await analyzeReport(req.file.buffer);

    await pool.query(
      `UPDATE credit_analyses SET status = 'complete', analysis = $1, raw_text = $2, updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(analysis), rawText, analysisId]
    );

    return res.json({
      success: true,
      analysis_id: analysisId,
      access_token: accessToken,
      analysis,
      authenticated: !!limit.userId,
      tier: limit.tier,
      disclaimer: 'Educational analysis only. Not credit-repair services, legal advice, or a guarantee of score/item outcomes. Consult a licensed professional before acting.',
    });
  } catch (err) {
    await pool.query(
      `UPDATE credit_analyses SET status = 'error', updated_at = NOW() WHERE id = $1`,
      [analysisId]
    );
    console.error('[mod_credit_analysis] Analysis error:', err.message);
    return res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
}));

// GET /analysis/:id — retrieve a completed analysis (deny by default)
router.get('/analysis/:id', asyncRoute(async (req, res) => {
  const pool = getPool();
  const id   = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid analysis ID.' });

  const token = String(req.query.token || req.get('x-analysis-token') || '').trim();
  const userId = req.session?.userId || null;

  let row;
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, status, analysis, created_at, access_token
       FROM credit_analyses WHERE id = $1`,
      [id]
    );
    row = rows[0];
  } catch (err) {
    const { rows } = await pool.query(
      `SELECT id, user_id, status, analysis, created_at
       FROM credit_analyses WHERE id = $1`,
      [id]
    );
    row = rows[0];
  }
  if (!row) return res.status(404).json({ error: 'Analysis not found.' });

  const isOwner = !!(userId && row.user_id && Number(row.user_id) === Number(userId));
  const tokenOk = !!(token && row.access_token && token === row.access_token);
  if (!isOwner && !tokenOk) {
    return res.status(404).json({ error: 'Analysis not found.' });
  }

  return res.json({
    id: row.id,
    status: row.status,
    analysis: row.analysis,
    created_at: row.created_at,
    authenticated: !!userId,
    disclaimer: 'Educational analysis only. Not credit-repair services, legal advice, or a guarantee of score/item outcomes.',
  });
}));

// GET /history — list this user's analyses (authenticated)
router.get('/history', asyncRoute(async (req, res) => {
  const userId = req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });

  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, status, analysis->>'summary_headline' as headline,
            analysis->>'overall_severity' as severity, created_at
     FROM credit_analyses
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [userId]
  );

  return res.json({ analyses: rows });
}));

/**
 * Alias: run forensic audit from an already-vaulted document.
 * Proxies to the vault implementation (same session cookie auth).
 * POST /api/mod_credit_analysis/run-from-vault  { documentId }
 */
router.post('/run-from-vault', asyncRoute(async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  // Forward internally by reusing vault route handler via HTTP-less require pattern:
  // Call the shared vault path logic by issuing a synthetic request is awkward;
  // instead duplicate the fetch+analyze using the same primitives.
  const userId = req.session.userId;
  const documentId = parseInt(req.body?.documentId || req.body?.document_id, 10);
  if (!documentId) return res.status(400).json({ error: 'No document selected for audit.' });

  req.userId = userId;
  // Delegate to vault endpoint implementation by requiring pool ops inline
  const { ensureVaultSchema } = require('../../lib/ensureVaultSchema');
  await ensureVaultSchema(pool);

  const limit = await checkRateLimit(req);
  if (!limit.allowed) {
    return res.status(429).json({ error: limit.message, reason: limit.reason });
  }

  const docRes = await pool.query(
    `SELECT id, category, file_name, file_mime_type, file_data
     FROM user_documents WHERE id = $1 AND user_id = $2`,
    [documentId, userId]
  );
  const doc = docRes.rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  if (doc.category !== 'credit_reports') {
    return res.status(400).json({ error: 'Only credit report documents can be audited here.' });
  }
  if (!doc.file_data) {
    return res.status(400).json({ error: 'Document file data is missing. Re-upload the PDF.' });
  }
  const nameLower = String(doc.file_name || '').toLowerCase();
  const mime = String(doc.file_mime_type || '');
  if (!mime.includes('pdf') && !nameLower.endsWith('.pdf')) {
    return res.status(400).json({ error: 'Selected file is not a PDF credit report.' });
  }

  const buffer = Buffer.isBuffer(doc.file_data) ? doc.file_data : Buffer.from(doc.file_data);
  await pool.query(`UPDATE user_documents SET audit_status = 'processing' WHERE id = $1`, [documentId]).catch(() => {});

  const accessToken = newAccessToken();
  const ip = getClientIP(req);
  let analysisId;
  try {
    analysisId = (await pool.query(
      `INSERT INTO credit_analyses (user_id, ip_address, status, access_token)
       VALUES ($1, $2, 'processing', $3) RETURNING id`,
      [userId, ip, accessToken]
    )).rows[0].id;
  } catch (e) {
    analysisId = (await pool.query(
      `INSERT INTO credit_analyses (user_id, ip_address, status) VALUES ($1, $2, 'processing') RETURNING id`,
      [userId, ip]
    )).rows[0].id;
  }

  try {
    const parsed = await analyzeReport(buffer);
    await pool.query(
      `UPDATE credit_analyses SET status = 'complete', analysis = $1, raw_text = $2, updated_at = NOW() WHERE id = $3`,
      [JSON.stringify(parsed.analysis), parsed.rawText, analysisId]
    );
    await pool.query(
      `UPDATE user_documents
       SET audit_status = 'audited', analysis_id = $2, audited_at = NOW(),
           audit_headline = $3, audit_severity = $4
       WHERE id = $1`,
      [
        documentId,
        analysisId,
        parsed.analysis?.summary_headline ? String(parsed.analysis.summary_headline).slice(0, 500) : null,
        parsed.analysis?.overall_severity || null
      ]
    ).catch(() => {});
    await pool.query(
      `UPDATE users SET credit_report_uploaded = TRUE, credit_gate_status = 'uploaded' WHERE id = $1`,
      [userId]
    ).catch(() => {});

    return res.json({
      success: true,
      message: 'Forensic credit audit completed successfully.',
      document_id: documentId,
      analysis_id: analysisId,
      access_token: accessToken,
      analysis: parsed.analysis,
      audit_status: 'audited',
      redirect: '/credit-analysis?id=' + analysisId + '&token=' + encodeURIComponent(accessToken),
      disclaimer: 'Educational analysis only. Not credit-repair services, legal advice, or a guarantee of score/item outcomes.'
    });
  } catch (err) {
    await pool.query(`UPDATE credit_analyses SET status = 'error' WHERE id = $1`, [analysisId]).catch(() => {});
    await pool.query(`UPDATE user_documents SET audit_status = 'error' WHERE id = $1`, [documentId]).catch(() => {});
    return res.status(500).json({ error: err.message || 'Failed to run forensic credit audit on selected document.' });
  }
}));

module.exports = {
  metadata: { name: 'Forensic Credit Scan', version: '1.0.0', defaultEnabled: true },
  routes: router,
  analyzeCreditPosture,
  analyzeReport,
  checkRateLimit,
  getClientIP,
  newAccessToken,
  getUserTier
};
