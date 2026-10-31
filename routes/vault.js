'use strict';

/**
 * Document vault, benefits data, vault health, and bank/cash accounts.
 * Mount:
 *   app.use('/api/vault', router)           // after /api/vault/admin
 *   app.use('/api/bank-accounts', bankAccountsRouter)
 *   app.use('/api/accounts', accountsRouter) // /all, /transfer
 */

const express = require('express');
const multer = require('multer');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');

const router = express.Router();
const bankAccountsRouter = express.Router();
const accountsRouter = express.Router();

const runtime = {};
function bindVaultRuntime(helpers) {
  Object.assign(runtime, helpers || {});
}

function hasProAccess(userOrId) {
  if (typeof runtime.hasProAccess === 'function') return runtime.hasProAccess(userOrId);
  return Promise.resolve(false);
}

function getSovereignLensLastCycle() {
  if (typeof runtime.getSovereignLensLastCycle === 'function') {
    return runtime.getSovereignLensLastCycle();
  }
  return { lastRun: null, lastDealsChecked: 0, lastAlertsGenerated: 0 };
}

const vaultUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const allowed = ['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif', '.csv', '.ofx', '.qfx'];
    if (allowed.some(ext => name.endsWith(ext))) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, JPG, PNG, HEIC, CSV, OFX, and QFX files are supported'));
    }
  }
});

const VAULT_CATEGORIES = ['receipts', 'financial_transactions', 'credit_reports', 'benefits_packages', 'life_insurance', 'other_documents'];
const IMPORT_DOC_CATEGORIES = ['credit_reports', 'benefits_packages', 'life_insurance', 'other_documents'];

async function ensureVaultTables() {
  try {
    const { ensureVaultSchema } = require('../lib/ensureVaultSchema');
    await ensureVaultSchema(pool);
  } catch (err) {
    console.error('[Vault] ensureVaultSchema:', err.message);
  }
}

const creditReportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || String(file.originalname || '').toLowerCase().endsWith('.pdf')) {
      return cb(null, true);
    }
    cb(new Error('Only PDF credit reports are accepted for forensic analysis.'));
  }
});

/**
 * One-upload credit report flow:
 * 1) store PDF in user_documents vault
 * 2) clear credit gate flags
 * 3) run Forensic Credit Scan (OCR + AI) into credit_analyses
 * 4) best-effort map negative/revolving balances into debts (educational ledger)
 *
 * POST /api/vault/upload-credit-report  (field: file)
 */
router.post('/upload-credit-report', requireAuth, (req, res, next) => {
  creditReportUpload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Invalid upload' });
    }
    next();
  });
}, async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No credit report file provided.' });
    }

    await ensureVaultTables();

    const creditMod = require('../modules/mod_credit_analysis');
    const limit = await creditMod.checkRateLimit(req);
    if (!limit.allowed) {
      return res.status(429).json({ error: limit.message, reason: limit.reason });
    }

    // 1) Vault storage
    let document;
    try {
      const docResult = await pool.query(
        `INSERT INTO user_documents (user_id, category, file_name, file_mime_type, file_size_bytes, file_data, notes)
         VALUES ($1, 'credit_reports', $2, $3, $4, $5, $6)
         RETURNING id, category, file_name, file_mime_type, file_size_bytes, notes, created_at`,
        [
          userId,
          req.file.originalname,
          req.file.mimetype || 'application/pdf',
          req.file.size,
          req.file.buffer,
          'Unified credit report upload + forensic scan'
        ]
      );
      document = docResult.rows[0];
    } catch (vaultErr) {
      console.error('[Vault] unified credit vault insert failed:', vaultErr.message);
      await ensureVaultTables();
      const docResult = await pool.query(
        `INSERT INTO user_documents (user_id, category, file_name, file_mime_type, file_size_bytes, file_data, notes)
         VALUES ($1, 'credit_reports', $2, $3, $4, $5, $6)
         RETURNING id, category, file_name, file_mime_type, file_size_bytes, notes, created_at`,
        [
          userId,
          req.file.originalname,
          req.file.mimetype || 'application/pdf',
          req.file.size,
          req.file.buffer,
          'Unified credit report upload + forensic scan'
        ]
      );
      document = docResult.rows[0];
    }

    // 2) Credit gate
    try {
      await pool.query(
        `UPDATE users SET credit_report_uploaded = TRUE, credit_gate_status = 'uploaded', updated_at = NOW() WHERE id = $1`,
        [userId]
      );
    } catch (gateErr) {
      console.error('[Vault] credit gate update skipped:', gateErr.message);
    }

    // 3) Forensic analysis row + AI parse
    const accessToken = creditMod.newAccessToken();
    const ip = creditMod.getClientIP(req);
    let analysisId = null;
    try {
      const inserted = await pool.query(
        `INSERT INTO credit_analyses (user_id, ip_address, status, access_token)
         VALUES ($1, $2, 'processing', $3) RETURNING id`,
        [userId, ip, accessToken]
      );
      analysisId = inserted.rows[0].id;
    } catch (insertErr) {
      const inserted = await pool.query(
        `INSERT INTO credit_analyses (user_id, ip_address, status)
         VALUES ($1, $2, 'processing') RETURNING id`,
        [userId, ip]
      );
      analysisId = inserted.rows[0].id;
    }

    let analysis = null;
    let debtsMapped = 0;
    try {
      const parsed = await creditMod.analyzeReport(req.file.buffer);
      analysis = parsed.analysis;
      await pool.query(
        `UPDATE credit_analyses
         SET status = 'complete', analysis = $1, raw_text = $2, updated_at = NOW()
         WHERE id = $3`,
        [JSON.stringify(analysis), parsed.rawText, analysisId]
      );

      // 4) Best-effort debt ledger mapping from negative items + revolving balances
      debtsMapped = await mapCreditAnalysisToDebts(pool, userId, analysis);
      await markDocumentAudited(pool, document.id, analysisId, analysis);
      document.audit_status = 'audited';
      document.analysis_id = analysisId;
      document.audit_headline = analysis?.summary_headline || null;
      document.audit_severity = analysis?.overall_severity || null;
    } catch (analyzeErr) {
      console.error('[Vault] unified forensic analyze error:', analyzeErr.message);
      if (analysisId) {
        await pool.query(
          `UPDATE credit_analyses SET status = 'error', updated_at = NOW() WHERE id = $1`,
          [analysisId]
        ).catch(() => {});
      }
      await pool.query(
        `UPDATE user_documents SET audit_status = 'error' WHERE id = $1`,
        [document.id]
      ).catch(() => {});
      // Vault + gate already succeeded — return partial success
      return res.status(200).json({
        success: true,
        partial: true,
        message: 'Credit report stored in vault, but forensic analysis failed.',
        document,
        analysis_id: analysisId,
        error: analyzeErr.message,
        redirect: '/credit-analysis'
      });
    }

    return res.json({
      success: true,
      message: 'Credit report stored, parsed, and mapped.',
      document,
      analysis_id: analysisId,
      access_token: accessToken,
      analysis,
      debts_mapped: debtsMapped,
      authenticated: true,
      tier: limit.tier,
      redirect: analysisId ? ('/credit-analysis?id=' + analysisId) : '/credit-analysis',
      disclaimer:
        'Educational analysis only. Not credit-repair services, legal advice, or a guarantee of score/item outcomes.'
    });
  } catch (err) {
    console.error('[Vault] unified upload error:', err.message);
    return res.status(500).json({ error: 'Failed to process and analyze credit report.' });
  }
});

/**
 * Run forensic credit audit on an already-vaulted PDF.
 * POST /api/vault/run-credit-audit  { documentId }
 * Alias also available at POST /api/mod_credit_analysis/run-from-vault
 */
router.post('/run-credit-audit', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const documentId = parseInt(req.body?.documentId || req.body?.document_id, 10);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });
    if (!documentId) return res.status(400).json({ error: 'No document selected for audit.' });

    await ensureVaultTables();

    const creditMod = require('../modules/mod_credit_analysis');
    const limit = await creditMod.checkRateLimit(req);
    if (!limit.allowed) {
      return res.status(429).json({ error: limit.message, reason: limit.reason });
    }

    const docRes = await pool.query(
      `SELECT id, category, file_name, file_mime_type, file_data, audit_status, analysis_id
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

    await pool.query(
      `UPDATE user_documents SET audit_status = 'processing' WHERE id = $1`,
      [documentId]
    ).catch(() => {});

    const accessToken = creditMod.newAccessToken();
    const ip = creditMod.getClientIP(req);
    let analysisId = null;
    try {
      const inserted = await pool.query(
        `INSERT INTO credit_analyses (user_id, ip_address, status, access_token)
         VALUES ($1, $2, 'processing', $3) RETURNING id`,
        [userId, ip, accessToken]
      );
      analysisId = inserted.rows[0].id;
    } catch (insertErr) {
      const inserted = await pool.query(
        `INSERT INTO credit_analyses (user_id, ip_address, status)
         VALUES ($1, $2, 'processing') RETURNING id`,
        [userId, ip]
      );
      analysisId = inserted.rows[0].id;
    }

    try {
      const parsed = await creditMod.analyzeReport(buffer);
      const analysis = parsed.analysis;
      await pool.query(
        `UPDATE credit_analyses
         SET status = 'complete', analysis = $1, raw_text = $2, updated_at = NOW()
         WHERE id = $3`,
        [JSON.stringify(analysis), parsed.rawText, analysisId]
      );

      await pool.query(
        `UPDATE users SET credit_report_uploaded = TRUE, credit_gate_status = 'uploaded', updated_at = NOW() WHERE id = $1`,
        [userId]
      ).catch(() => {});

      const debtsMapped = await mapCreditAnalysisToDebts(pool, userId, analysis);
      await markDocumentAudited(pool, documentId, analysisId, analysis);

      return res.json({
        success: true,
        message: 'Forensic credit audit completed successfully.',
        document_id: documentId,
        analysis_id: analysisId,
        access_token: accessToken,
        analysis,
        debts_mapped: debtsMapped,
        audit_status: 'audited',
        redirect: '/credit-analysis?id=' + analysisId + '&token=' + encodeURIComponent(accessToken),
        disclaimer:
          'Educational analysis only. Not credit-repair services, legal advice, or a guarantee of score/item outcomes.'
      });
    } catch (analyzeErr) {
      console.error('[Vault] run-credit-audit analyze error:', analyzeErr.message);
      if (analysisId) {
        await pool.query(
          `UPDATE credit_analyses SET status = 'error', updated_at = NOW() WHERE id = $1`,
          [analysisId]
        ).catch(() => {});
      }
      await pool.query(
        `UPDATE user_documents SET audit_status = 'error' WHERE id = $1`,
        [documentId]
      ).catch(() => {});
      return res.status(500).json({
        error: analyzeErr.message || 'Failed to run forensic credit audit on selected document.'
      });
    }
  } catch (err) {
    console.error('[Vault] run-credit-audit error:', err.message);
    return res.status(500).json({ error: 'Failed to run forensic credit audit on selected document.' });
  }
});

async function markDocumentAudited(db, documentId, analysisId, analysis) {
  try {
    await db.query(
      `UPDATE user_documents
       SET audit_status = 'audited',
           analysis_id = $2,
           audited_at = NOW(),
           audit_headline = $3,
           audit_severity = $4
       WHERE id = $1`,
      [
        documentId,
        analysisId,
        analysis?.summary_headline ? String(analysis.summary_headline).slice(0, 500) : null,
        analysis?.overall_severity ? String(analysis.overall_severity).slice(0, 16) : null
      ]
    );
  } catch (err) {
    // Older schemas may lack audit columns — ensure then retry once
    console.warn('[Vault] markDocumentAudited:', err.message);
    await ensureVaultTables();
    await db.query(
      `UPDATE user_documents
       SET audit_status = 'audited',
           analysis_id = $2,
           audited_at = NOW(),
           audit_headline = $3,
           audit_severity = $4
       WHERE id = $1`,
      [
        documentId,
        analysisId,
        analysis?.summary_headline ? String(analysis.summary_headline).slice(0, 500) : null,
        analysis?.overall_severity ? String(analysis.overall_severity).slice(0, 16) : null
      ]
    );
  }
}

/**
 * Map educational forensic findings into debts ledger (best-effort, non-fatal).
 * Does not invent APRs; balance-only rows for awareness / velocity planning.
 */
async function mapCreditAnalysisToDebts(db, userId, analysis) {
  if (!analysis || typeof analysis !== 'object') return 0;
  let mapped = 0;

  const candidates = [];
  for (const item of analysis.negative_items || []) {
    const amount = Number(item.amount);
    if (!item.creditor || !Number.isFinite(amount) || amount <= 0) continue;
    candidates.push({
      name: String(item.creditor).slice(0, 200) + (item.type ? ` (${item.type})` : ''),
      balance: amount,
      notes: 'Imported from credit report forensic scan (educational)'
    });
  }
  for (const acct of analysis.accounts || []) {
    const balance = Number(acct.balance);
    if (!acct.creditor || !Number.isFinite(balance) || balance <= 0) continue;
    if (acct.account_type && !['revolving', 'installment', 'other'].includes(acct.account_type)) continue;
    candidates.push({
      name: String(acct.creditor).slice(0, 220),
      balance,
      notes: 'Imported revolving/installment balance from credit report scan (educational)'
    });
  }

  for (const row of candidates.slice(0, 40)) {
    try {
      const existing = await db.query(
        `SELECT id FROM debts WHERE user_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
        [userId, row.name]
      );
      if (existing.rows[0]) {
        await db.query(
          `UPDATE debts SET balance = $2, notes = COALESCE(notes, $3), updated_at = NOW() WHERE id = $1`,
          [existing.rows[0].id, row.balance, row.notes]
        );
      } else {
        await db.query(
          `INSERT INTO debts (user_id, name, balance, interest_rate, minimum_payment, notes)
           VALUES ($1, $2, $3, 0, 0, $4)`,
          [userId, row.name, row.balance, row.notes]
        );
      }
      mapped += 1;
    } catch (mapErr) {
      console.warn('[Vault] debt map skip:', mapErr.message);
    }
  }
  return mapped;
}

// GET /api/vault/summary — count + last upload per category
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);
    let result;
    try {
      result = await pool.query(
        `SELECT category, COUNT(*) AS count, MAX(created_at) AS last_upload
         FROM user_documents WHERE user_id = $1 GROUP BY category`,
        [req.userId]
      );
    } catch (selectErr) {
      console.error('[Vault] summary SELECT failed, self-healing:', selectErr.message);
      await ensureVaultTables();
      result = await pool.query(
        `SELECT category, COUNT(*) AS count, MAX(created_at) AS last_upload
         FROM user_documents WHERE user_id = $1 GROUP BY category`,
        [req.userId]
      );
    }
    const summary = {};
    VAULT_CATEGORIES.forEach(cat => {
      summary[cat] = { count: 0, last_upload: null };
    });
    result.rows.forEach(row => {
      summary[row.category] = { count: parseInt(row.count), last_upload: row.last_upload };
    });
    res.json({ success: true, summary, has_pro: hasPro });
  } catch (err) {
    console.error('[Vault] summary error:', err.message);
    res.status(500).json({ error: 'Failed to load vault summary' });
  }
});

// GET /api/vault/documents — list documents, optionally by category
router.get('/documents', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);
    const { category } = req.query;
    if (category && !VAULT_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }
    if (!hasPro && category && !IMPORT_DOC_CATEGORIES.includes(category)) {
      return res.status(403).json({ error: 'Paid plan required', upgrade_required: true });
    }

    let query = `SELECT id, category, file_name, file_mime_type, file_size_bytes, notes, created_at,
                        COALESCE(audit_status, 'stored') AS audit_status,
                        analysis_id, audited_at, audit_headline, audit_severity
                 FROM user_documents WHERE user_id = $1`;
    const params = [req.userId];
    if (category) {
      query += ` AND category = $2`;
      params.push(category);
    } else if (!hasPro) {
      query += ` AND category = ANY($2)`;
      params.push(IMPORT_DOC_CATEGORIES);
    }
    query += ' ORDER BY created_at DESC';

    let result;
    try {
      result = await pool.query(query, params);
    } catch (selectErr) {
      console.error('[Vault] list SELECT failed, self-healing:', selectErr.message);
      await ensureVaultTables();
      // Fallback without audit columns if still missing mid-heal
      try {
        result = await pool.query(query, params);
      } catch (retryErr) {
        const legacy = `SELECT id, category, file_name, file_mime_type, file_size_bytes, notes, created_at
                        FROM user_documents WHERE user_id = $1` +
          (category ? ' AND category = $2' : (!hasPro ? ' AND category = ANY($2)' : '')) +
          ' ORDER BY created_at DESC';
        result = await pool.query(legacy, params);
        result.rows = result.rows.map((row) => Object.assign({
          audit_status: 'stored',
          analysis_id: null,
          audited_at: null,
          audit_headline: null,
          audit_severity: null
        }, row));
      }
    }
    res.json({ success: true, documents: result.rows, has_pro: hasPro });
  } catch (err) {
    console.error('[Vault] list error:', err.message);
    res.status(500).json({ error: 'Failed to list documents', detail: String(err.message || '').slice(0, 180) });
  }
});

// POST /api/vault/documents — upload a document
router.post('/documents', requireAuth, vaultUpload.single('file'), async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);

    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { category, notes } = req.body;
    if (!category || !VAULT_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category. Must be one of: ' + VAULT_CATEGORIES.join(', ') });
    }
    if (!hasPro && !IMPORT_DOC_CATEGORIES.includes(category)) {
      return res.status(403).json({ error: 'Paid plan required', upgrade_required: true });
    }

    const insertSql = `INSERT INTO user_documents (user_id, category, file_name, file_mime_type, file_size_bytes, file_data, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, category, file_name, file_mime_type, file_size_bytes, notes, created_at`;
    const insertParams = [
      req.userId,
      category,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      req.file.buffer,
      notes || null
    ];

    let result;
    try {
      result = await pool.query(insertSql, insertParams);
    } catch (insertErr) {
      console.error('[Vault] upload INSERT failed, self-healing:', insertErr.message);
      await ensureVaultTables();
      result = await pool.query(insertSql, insertParams);
    }

    const doc = result.rows[0];

    // If this is a benefits package upload, trigger a simple text-extraction attempt
    // and return the document ID so the client can show the verification form
    let benefitsHint = null;
    if (category === 'benefits_packages') {
      benefitsHint = { document_id: doc.id, show_verification_form: true };
    }

    // If this is a credit report upload, record completion (mirrors onboarding flow)
    // Also satisfy the Level 4-6 credit gate requirement
    if (category === 'credit_reports') {
      try {
        await pool.query(
          `UPDATE users SET credit_report_uploaded = TRUE, credit_gate_status = 'uploaded' WHERE id = $1`,
          [req.userId]
        );
      } catch (gateErr) {
        console.error('[Vault] credit gate update failed, self-healing:', gateErr.message);
        await ensureVaultTables();
        await pool.query(
          `UPDATE users SET credit_report_uploaded = TRUE, credit_gate_status = 'uploaded' WHERE id = $1`,
          [req.userId]
        );
      }
    }

    res.json({ success: true, document: doc, benefits_hint: benefitsHint });
  } catch (err) {
    console.error('[Vault] upload error:', err.message);
    res.status(500).json({ error: 'Failed to upload document', detail: String(err.message || '').slice(0, 180) });
  }
});

// GET /api/vault/documents/:id/download — serve file inline
router.get('/documents/:id/download', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);

    const result = await pool.query(
      'SELECT * FROM user_documents WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Document not found' });
    if (!hasPro && !IMPORT_DOC_CATEGORIES.includes(result.rows[0].category)) {
      return res.status(403).json({ error: 'Paid plan required', upgrade_required: true });
    }

    const doc = result.rows[0];
    const mime = doc.file_mime_type || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${doc.file_name}"`);
    res.send(doc.file_data);
  } catch (err) {
    console.error('[Vault] download error:', err.message);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

// DELETE /api/vault/documents/:id — delete a document
router.delete('/documents/:id', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);

    const existing = await pool.query(
      'SELECT category FROM user_documents WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Document not found' });
    if (!hasPro && !IMPORT_DOC_CATEGORIES.includes(existing.rows[0].category)) {
      return res.status(403).json({ error: 'Paid plan required', upgrade_required: true });
    }

    const result = await pool.query(
      'DELETE FROM user_documents WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Document not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Vault] delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// ── Benefits Data ───────────────────────────────────────────────────────────

// GET /api/vault/benefits-data — get user's saved benefits package data
router.get('/benefits-data', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) return res.status(403).json({ error: 'Paid plan required', upgrade_required: true });

    const result = await pool.query(
      `SELECT b.*, d.file_name AS source_document_name
       FROM user_benefits_data b
       LEFT JOIN user_documents d ON d.id = b.document_id
       WHERE b.user_id = $1`,
      [req.userId]
    );

    // Also pull latest annual income from FACTS data for pre-filling salary
    const incomeResult = await pool.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_annual_income_cents
       FROM transactions
       WHERE user_id = $1
         AND type = 'income'
         AND transaction_date >= NOW() - INTERVAL '12 months'`,
      [req.userId]
    );

    // Pull current 401k contribution allocation if exists
    const allocationResult = await pool.query(
      `SELECT ua.percentage
       FROM user_allocations ua
       JOIN allocation_categories ac ON ac.id = ua.category_id
       WHERE ua.user_id = $1
         AND LOWER(ac.name) LIKE '%financial freedom%'
       LIMIT 1`,
      [req.userId]
    );

    res.json({
      success: true,
      benefits: result.rows[0] || null,
      facts_data: {
        annual_income_cents: parseInt(incomeResult.rows[0]?.total_annual_income_cents || 0),
        ff_allocation_percent: parseFloat(allocationResult.rows[0]?.percentage || 10)
      },
      has_pro: hasPro
    });
  } catch (err) {
    console.error('[Vault] benefits-data GET error:', err.message);
    res.status(500).json({ error: 'Failed to load benefits data' });
  }
});

// POST /api/vault/benefits-data — save/update benefits package data
router.post('/benefits-data', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) return res.status(403).json({ error: 'Paid plan required', upgrade_required: true });

    const {
      document_id,
      employer_name,
      employee_contribution_percent,
      match_rate_percent,
      match_max_percent,
      vesting_schedule,
      hsa_employer_seed_cents,
      hsa_plan_type,
      hsa_employee_contribution_cents,
      dental_annual_max_cents,
      dental_used_cents,
      vision_annual_max_cents,
      vision_used_cents,
      tuition_max_cents,
      education_spent_cents,
      base_salary_cents
    } = req.body;

    // Upsert — one record per user
    const result = await pool.query(
      `INSERT INTO user_benefits_data (
        user_id, document_id, employer_name,
        employee_contribution_percent, match_rate_percent, match_max_percent, vesting_schedule,
        hsa_employer_seed_cents, hsa_plan_type, hsa_employee_contribution_cents,
        dental_annual_max_cents, dental_used_cents,
        vision_annual_max_cents, vision_used_cents,
        tuition_max_cents, education_spent_cents,
        base_salary_cents, verified_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        document_id = EXCLUDED.document_id,
        employer_name = EXCLUDED.employer_name,
        employee_contribution_percent = EXCLUDED.employee_contribution_percent,
        match_rate_percent = EXCLUDED.match_rate_percent,
        match_max_percent = EXCLUDED.match_max_percent,
        vesting_schedule = EXCLUDED.vesting_schedule,
        hsa_employer_seed_cents = EXCLUDED.hsa_employer_seed_cents,
        hsa_plan_type = EXCLUDED.hsa_plan_type,
        hsa_employee_contribution_cents = EXCLUDED.hsa_employee_contribution_cents,
        dental_annual_max_cents = EXCLUDED.dental_annual_max_cents,
        dental_used_cents = EXCLUDED.dental_used_cents,
        vision_annual_max_cents = EXCLUDED.vision_annual_max_cents,
        vision_used_cents = EXCLUDED.vision_used_cents,
        tuition_max_cents = EXCLUDED.tuition_max_cents,
        education_spent_cents = EXCLUDED.education_spent_cents,
        base_salary_cents = EXCLUDED.base_salary_cents,
        verified_at = NOW(),
        updated_at = NOW()
      RETURNING *`,
      [
        req.userId,
        document_id || null,
        employer_name || null,
        employee_contribution_percent != null ? parseFloat(employee_contribution_percent) : null,
        match_rate_percent != null ? parseFloat(match_rate_percent) : null,
        match_max_percent != null ? parseFloat(match_max_percent) : null,
        vesting_schedule || null,
        hsa_employer_seed_cents != null ? parseInt(hsa_employer_seed_cents) : null,
        hsa_plan_type || 'individual',
        hsa_employee_contribution_cents != null ? parseInt(hsa_employee_contribution_cents) : null,
        dental_annual_max_cents != null ? parseInt(dental_annual_max_cents) : null,
        dental_used_cents != null ? parseInt(dental_used_cents) : 0,
        vision_annual_max_cents != null ? parseInt(vision_annual_max_cents) : null,
        vision_used_cents != null ? parseInt(vision_used_cents) : 0,
        tuition_max_cents != null ? parseInt(tuition_max_cents) : null,
        education_spent_cents != null ? parseInt(education_spent_cents) : 0,
        base_salary_cents != null ? parseInt(base_salary_cents) : null
      ]
    );

    res.json({ success: true, benefits: result.rows[0] });
  } catch (err) {
    console.error('[Vault] benefits-data POST error:', err.message);
    res.status(500).json({ error: 'Failed to save benefits data' });
  }
});

// Vault health (cycle status)
router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    // Pull latest cycle run from DB for accurate data
    const { rows: [latestRun] } = await pool.query(`
      SELECT
        cycle_date,
        deals_checked,
        alerts_generated,
        auto_revokes_triggered,
        locked_open_activations,
        status,
        completed_at,
        started_at
      FROM lens_cycle_runs
      ORDER BY cycle_date DESC
      LIMIT 1
    `).catch(() => ({ rows: [] }));

    res.json({
      status: 'healthy',
      module: 'tdagsis_vault_services',
      lastCycleRun:              latestRun?.completed_at || getSovereignLensLastCycle().lastRun || null,
      lastCycleDealsChecked:     latestRun?.deals_checked ?? getSovereignLensLastCycle().lastDealsChecked,
      lastCycleAlertsGenerated:  latestRun?.alerts_generated ?? getSovereignLensLastCycle().lastAlertsGenerated,
      lastCycleStatus:           latestRun?.status || 'never_run',
      lastCycleDate:             latestRun?.cycle_date || null,
    });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

const BUILT_IN_INSTITUTIONS = [
  // Major Banks
  'Ally Bank', 'American Express', 'Bank of America', 'Capital One', 'Chase',
  'Citizens Bank', 'Citi', 'Discover Bank', 'Fifth Third Bank', 'Goldman Sachs',
  'HSBC', 'Huntington Bank', 'KeyBank', 'Morgan Stanley', 'PNC Bank',
  'Regions Bank', 'TD Bank', 'Truist', 'US Bank', 'Wells Fargo',
  // Credit Unions
  'Boeing Employees Credit Union', 'First Tech Federal Credit Union',
  'Navy Federal Credit Union', 'Pentagon Federal Credit Union',
  'State Employees Credit Union', 'USAA',
  // Brokerages
  'Acorns', 'Charles Schwab', 'E*Trade', 'Edward Jones', 'Fidelity',
  'Interactive Brokers', 'M1 Finance', 'Merrill Lynch', 'Public',
  'Raymond James', 'Robinhood', 'TD Ameritrade', 'Vanguard', 'Webull',
  // Crypto Platforms
  'Binance', 'Binance.US', 'Coinbase', 'Coinbase Pro', 'Crypto.com',
  'Exodus', 'Gate.io', 'Gemini', 'Kraken', 'KuCoin',
  'Ledger', 'MetaMask', 'Phantom', 'Trezor', 'Trust Wallet',
  // DeFi / On-chain
  'Aave', 'Compound', 'Uniswap',
  // Fintech
  'Aspiration', 'Betterment', 'Brigit', 'Cash App', 'Chime',
  'Cleo', 'Current', 'Dave', 'Greenlight', 'MoneyLion',
  'One Finance', 'PayPal', 'Revolut', 'SoFi', 'Stash',
  'Step', 'Venmo', 'Wealthfront', 'Wise',
];

const BUILT_IN_ACCOUNT_TYPES = [
  'Checking',
  'Savings',
  'Credit Card',
  'Investment / Brokerage',
  'Retirement – 401(k)',
  'Retirement – IRA',
  'Retirement – Roth IRA',
  'Retirement – 403(b)',
  'Retirement – 457',
  'Loan – Mortgage',
  'Loan – HELOC (Home Equity Line of Credit)',
  'Loan – Auto',
  'Loan – Student',
  'Loan – Personal',
  'HSA',
  'FSA',
  'Money Market',
  'CD (Certificate of Deposit)',
  'Crypto – Exchange',
  'Crypto – Hot Wallet',
  'Crypto – Cold Wallet',
  'Crypto – DeFi / On-chain',
  'Cash / Physical',
  'Other',
];

// Get built-in + custom account options for the current user
bankAccountsRouter.get('/options', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(
      `SELECT option_type, value FROM custom_account_options
       WHERE user_id = $1 ORDER BY created_at ASC`,
      [userId]
    );
    const customs = result.rows;
    const customInstitutions = customs.filter(r => r.option_type === 'institution').map(r => r.value);
    const customAccountTypes = customs.filter(r => r.option_type === 'account_type').map(r => r.value);
    res.json({
      institutions: BUILT_IN_INSTITUTIONS,
      account_types: BUILT_IN_ACCOUNT_TYPES,
      custom_institutions: customInstitutions,
      custom_account_types: customAccountTypes,
    });
  } catch (err) {
    console.error('GET /api/bank-accounts/options error:', err.message);
    res.status(500).json({ error: 'Failed to fetch options' });
  }
});

// Save a custom institution or account type
bankAccountsRouter.post('/options', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { option_type, value } = req.body;
    if (!['institution', 'account_type'].includes(option_type)) {
      return res.status(400).json({ error: 'Invalid option_type' });
    }
    if (!value || !value.trim()) {
      return res.status(400).json({ error: 'Value is required' });
    }
    await pool.query(
      `INSERT INTO custom_account_options (user_id, option_type, value)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, option_type, value.trim()]
    );
    res.json({ success: true, option_type, value: value.trim() });
  } catch (err) {
    console.error('POST /api/bank-accounts/options error:', err.message);
    res.status(500).json({ error: 'Failed to save option' });
  }
});

// Get all bank accounts for user (with computed running balance from tagged transactions)
bankAccountsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const showArchived = req.query.show_archived === 'true';

    let query = `
      SELECT ba.*,
        COALESCE(
          (SELECT COUNT(*) FROM transactions t WHERE t.bank_account_id = ba.id),
          0
        )::int as transaction_count,
        COALESCE(
          (SELECT SUM(t.amount) FROM transactions t WHERE t.bank_account_id = ba.id AND t.type = 'expense'),
          0
        ) as total_debits,
        COALESCE(
          (SELECT SUM(t.amount) FROM transactions t WHERE t.bank_account_id = ba.id AND t.type = 'income'),
          0
        ) as total_credits
      FROM bank_accounts ba
      WHERE ba.user_id = $1
    `;

    if (!showArchived) {
      query += ` AND ba.is_archived = FALSE`;
    }

    query += ` ORDER BY ba.is_archived ASC, ba.created_at DESC`;

    const result = await pool.query(query, [userId]);
    res.json({ bank_accounts: result.rows });
  } catch (err) {
    console.error('GET /api/bank-accounts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch bank accounts' });
  }
});

// Create new bank account
bankAccountsRouter.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { name, starting_balance, notes, institution_name, account_type } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Account name is required' });
    }

    const balance = parseFloat(starting_balance) || 0;

    const result = await pool.query(`
      INSERT INTO bank_accounts (user_id, name, starting_balance, current_balance, notes, institution_name, account_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [userId, name.trim(), balance, balance, notes || null, institution_name?.trim() || null, account_type?.trim() || null]);

    res.json({ bank_account: result.rows[0] });
  } catch (err) {
    console.error('POST /api/bank-accounts error:', err.message);
    res.status(500).json({ error: 'Failed to create bank account' });
  }
});

// Update bank account (name, notes, institution_name, account_type)
bankAccountsRouter.post('/transfer', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userId = req.userId;
    const { from_account_id, to_account_id, amount, description, transfer_date } = req.body;

    if (!from_account_id || !to_account_id) {
      return res.status(400).json({ error: 'Both from and to accounts are required' });
    }
    if (parseInt(from_account_id) === parseInt(to_account_id)) {
      return res.status(400).json({ error: 'Cannot transfer to the same account' });
    }
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const transferAmount = parseFloat(amount);

    // Verify both accounts belong to user and lock them
    const fromResult = await client.query(
      'SELECT * FROM bank_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [parseInt(from_account_id), userId]
    );
    const toResult = await client.query(
      'SELECT * FROM bank_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [parseInt(to_account_id), userId]
    );

    if (fromResult.rows.length === 0 || toResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'One or both accounts not found' });
    }

    const fromAccount = fromResult.rows[0];
    const toAccount = toResult.rows[0];

    if (fromAccount.is_archived || toAccount.is_archived) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot transfer to/from archived accounts' });
    }

    // Deduct from source
    await client.query(
      'UPDATE bank_accounts SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2',
      [transferAmount, parseInt(from_account_id)]
    );

    // Add to destination
    await client.query(
      'UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2',
      [transferAmount, parseInt(to_account_id)]
    );

    // Record transfer
    const transferResult = await client.query(`
      INSERT INTO account_transfers (user_id, from_account_id, to_account_id, amount, description, transfer_date)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [userId, parseInt(from_account_id), parseInt(to_account_id), transferAmount,
        description || null, transfer_date || new Date().toISOString().split('T')[0]]);

    await client.query('COMMIT');

    res.json({
      transfer: transferResult.rows[0],
      from_account: fromAccount.name,
      to_account: toAccount.name,
      from_new_balance: parseFloat(fromAccount.current_balance) - transferAmount,
      to_new_balance: parseFloat(toAccount.current_balance) + transferAmount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/bank-accounts/transfer error:', err.message);
    res.status(500).json({ error: 'Failed to transfer' });
  } finally {
    client.release();
  }
});

bankAccountsRouter.get('/transfers', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(`
      SELECT at.*,
        fa.name as from_account_name,
        ta.name as to_account_name
      FROM account_transfers at
      JOIN bank_accounts fa ON fa.id = at.from_account_id
      JOIN bank_accounts ta ON ta.id = at.to_account_id
      WHERE at.user_id = $1
      ORDER BY at.transfer_date DESC, at.created_at DESC
      LIMIT 50
    `, [userId]);

    res.json({ transfers: result.rows });
  } catch (err) {
    console.error('GET /api/bank-accounts/transfers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch transfers' });
  }
});

bankAccountsRouter.put('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { name, notes, institution_name, account_type } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Account name is required' });
    }

    const result = await pool.query(`
      UPDATE bank_accounts
      SET name = $1, notes = $2, institution_name = $3, account_type = $4, updated_at = NOW()
      WHERE id = $5 AND user_id = $6
      RETURNING *
    `, [name.trim(), notes || null, institution_name?.trim() || null, account_type?.trim() || null, parseInt(req.params.id), userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bank account not found' });
    }

    res.json({ bank_account: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/bank-accounts error:', err.message);
    res.status(500).json({ error: 'Failed to update bank account' });
  }
});

// Archive/unarchive bank account
bankAccountsRouter.patch('/:id/archive', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(`
      UPDATE bank_accounts
      SET is_archived = NOT is_archived, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `, [parseInt(req.params.id), userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bank account not found' });
    }

    res.json({ bank_account: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/bank-accounts/:id/archive error:', err.message);
    res.status(500).json({ error: 'Failed to toggle archive status' });
  }
});

// Delete bank account (warns if has transactions)
bankAccountsRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const accountId = parseInt(req.params.id);

    // Check for linked transactions
    const txnCheck = await pool.query(
      'SELECT COUNT(*) as count FROM transactions WHERE bank_account_id = $1',
      [accountId]
    );

    if (parseInt(txnCheck.rows[0].count) > 0 && req.query.force !== 'true') {
      return res.status(400).json({
        error: `This account has ${txnCheck.rows[0].count} tagged transaction(s). Archive instead, or add ?force=true to delete. Transactions will be untagged.`,
        transaction_count: parseInt(txnCheck.rows[0].count)
      });
    }

    // Untag transactions first
    await pool.query('UPDATE transactions SET bank_account_id = NULL WHERE bank_account_id = $1', [accountId]);

    const result = await pool.query(
      'DELETE FROM bank_accounts WHERE id = $1 AND user_id = $2 RETURNING *',
      [accountId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bank account not found' });
    }

    res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /api/bank-accounts error:', err.message);
    res.status(500).json({ error: 'Failed to delete bank account' });
  }
});

// Adjust bank account balance (manual correction)
bankAccountsRouter.post('/:id/adjust', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const accountId = parseInt(req.params.id);
    const { new_balance } = req.body;

    if (new_balance === undefined || new_balance === null) {
      return res.status(400).json({ error: 'new_balance is required' });
    }

    const result = await pool.query(`
      UPDATE bank_accounts
      SET current_balance = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3
      RETURNING *
    `, [parseFloat(new_balance), accountId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bank account not found' });
    }

    res.json({ bank_account: result.rows[0] });
  } catch (err) {
    console.error('POST /api/bank-accounts/:id/adjust error:', err.message);
    res.status(500).json({ error: 'Failed to adjust balance' });
  }
});

// Transfer between accounts
// Unified transfer endpoint — supports bank + brokerage accounts
accountsRouter.post('/transfer', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userId = req.userId;
    const { from_account_id, from_source, to_account_id, to_source, amount, description, transfer_date } = req.body;

    if (!from_account_id || !to_account_id) {
      return res.status(400).json({ error: 'Both from and to accounts are required' });
    }
    if (from_source === to_source && parseInt(from_account_id) === parseInt(to_account_id)) {
      return res.status(400).json({ error: 'Cannot transfer to the same account' });
    }
    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const transferAmount = parseFloat(amount);
    const fromSrc = from_source || 'bank';
    const toSrc = to_source || 'bank';
    const fromTable = fromSrc === 'brokerage' ? 'brokerage_accounts' : 'bank_accounts';
    const toTable = toSrc === 'brokerage' ? 'brokerage_accounts' : 'bank_accounts';

    // Verify both accounts belong to user and lock them
    const fromResult = await client.query(
      `SELECT * FROM ${fromTable} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [parseInt(from_account_id), userId]
    );
    const toResult = await client.query(
      `SELECT * FROM ${toTable} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [parseInt(to_account_id), userId]
    );

    if (fromResult.rows.length === 0 || toResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'One or both accounts not found' });
    }

    const fromAccount = fromResult.rows[0];
    const toAccount = toResult.rows[0];

    // Check archived for bank accounts
    if (fromSrc === 'bank' && fromAccount.is_archived) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot transfer from an archived account' });
    }
    if (toSrc === 'bank' && toAccount.is_archived) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot transfer to an archived account' });
    }

    // Deduct from source
    await client.query(
      `UPDATE ${fromTable} SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2`,
      [transferAmount, parseInt(from_account_id)]
    );

    // Add to destination
    await client.query(
      `UPDATE ${toTable} SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2`,
      [transferAmount, parseInt(to_account_id)]
    );

    // Record transfer — store in account_transfers if both are bank accounts (FK constraint)
    // Otherwise just record the transaction without the FK-constrained table
    let transferRecord = null;
    if (fromSrc === 'bank' && toSrc === 'bank') {
      const transferResult = await client.query(`
        INSERT INTO account_transfers (user_id, from_account_id, to_account_id, amount, description, transfer_date)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [userId, parseInt(from_account_id), parseInt(to_account_id), transferAmount,
          description || null, transfer_date || new Date().toISOString().split('T')[0]]);
      transferRecord = transferResult.rows[0];
    }

    // Also create a transaction record for the transfer
    const txnDate = transfer_date || new Date().toISOString().split('T')[0];
    const txnDesc = description || `Transfer: ${fromAccount.name} → ${toAccount.name}`;

    // Only set bank_account_id and transfer_to_account_id if they're bank accounts (FK constraint)
    const fromBankId = fromSrc === 'bank' ? parseInt(from_account_id) : null;
    const toBankId = toSrc === 'bank' ? parseInt(to_account_id) : null;

    await client.query(`
      INSERT INTO transactions (user_id, amount, type, description, transaction_date, bank_account_id, transfer_to_account_id)
      VALUES ($1, $2, 'transfer', $3, $4, $5, $6)
    `, [userId, transferAmount, txnDesc, txnDate, fromBankId, toBankId]);

    await client.query('COMMIT');

    res.json({
      transfer: transferRecord,
      from_account: fromAccount.name,
      to_account: toAccount.name,
      from_source: fromSrc,
      to_source: toSrc,
      from_new_balance: parseFloat(fromAccount.current_balance) - transferAmount,
      to_new_balance: parseFloat(toAccount.current_balance) + transferAmount
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/accounts/transfer error:', err.message);
    res.status(500).json({ error: 'Failed to transfer' });
  } finally {
    client.release();
  }
});

// Get transfer history
// Get transactions for a specific bank account
bankAccountsRouter.get('/:id/transactions', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const accountId = parseInt(req.params.id);

    // Verify ownership
    const baCheck = await pool.query(
      'SELECT id FROM bank_accounts WHERE id = $1 AND user_id = $2',
      [accountId, userId]
    );
    if (baCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Bank account not found' });
    }

    const result = await pool.query(`
      SELECT t.*, c.name as category_name, c.icon as category_icon
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.bank_account_id = $1 AND t.user_id = $2
      ORDER BY t.transaction_date DESC, t.created_at DESC
      LIMIT 100
    `, [accountId, userId]);

    res.json({ transactions: result.rows });
  } catch (err) {
    console.error('GET /api/bank-accounts/:id/transactions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch account transactions' });
  }
});

accountsRouter.get('/all', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;

    // Fetch bank accounts (checking, savings, credit cards, loans, etc.)
    const bankRes = await pool.query(
      `SELECT id, name, institution_name AS institution, account_type, current_balance, is_archived
       FROM bank_accounts
       WHERE user_id = $1 AND is_archived = FALSE
       ORDER BY created_at DESC`,
      [userId]
    );

    // Fetch brokerage/investment accounts
    const brokerageRes = await pool.query(
      `SELECT id, name, institution, account_type, current_balance
       FROM brokerage_accounts
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    const bankAccounts = bankRes.rows.map(a => ({
      id: a.id,
      name: a.name,
      institution: a.institution || null,
      account_type: a.account_type || null,
      current_balance: a.current_balance,
      source: 'bank'
    }));

    const brokerageAccounts = brokerageRes.rows.map(a => ({
      id: a.id,
      name: a.name,
      institution: a.institution || null,
      account_type: a.account_type || null,
      current_balance: a.current_balance,
      source: 'brokerage'
    }));

    res.json({
      accounts: [...bankAccounts, ...brokerageAccounts],
      bank_count: bankAccounts.length,
      brokerage_count: brokerageAccounts.length
    });
  } catch (err) {
    console.error('GET /api/accounts/all error:', err.message);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

module.exports = {
  router,
  bankAccountsRouter,
  accountsRouter,
  bindVaultRuntime
};
