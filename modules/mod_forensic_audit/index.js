/**
 * mod_forensic_audit — Initial Forensic Statement Baseline
 *
 * Parses uploaded bank/statement files and maps transactions to the
 * FACTS 6-bucket model (necessity, reserve, velocity, growth, lifestyle, legacy).
 *
 * Routes (mounted at /api/mod_forensic_audit):
 *   GET  /health
 *   POST /upload-statement  — secure memory upload → forensic baseline
 *   POST /baseline          — alias of /upload-statement
 *   GET  /history
 *   GET  /cadence           — ?notify=1 to email when due
 *   POST /cadence/remind    — send Resend milestone reminder if due
 *   POST /expedited-reaudit — remediation clear + escrow release
 *
 * Alias: /api/forensic (same router)
 *
 * © T-Dagsis LLC. All rights reserved.
 */

'use strict';

const express = require('express');
const multer = require('multer');
const { Pool } = require('pg');
const { asyncRoute } = require('../../module-error-boundary');
const {
  FORENSIC_BUCKETS,
  processInitialForensicAudit
} = require('./forensic-engine');
const {
  CADENCE,
  checkAndTriggerMilestoneAudit
} = require('./milestone-cadence');
const { sendAuditReminderEmail } = require('./audit-reminder-email');
const { handleExpeditedReAudit } = require('../../controllers/remediationController');
const { getForensicStatus } = require('./status');

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /sslmode=require|neon\.tech/i.test(process.env.DATABASE_URL || '')
        ? { rejectUnauthorized: false }
        : undefined
    });
  }
  return _pool;
}

async function ensureSchema(pool) {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS mod_forensic_audit`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mod_forensic_audit.audits (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      audit_type VARCHAR(64) NOT NULL DEFAULT 'INITIAL_BASELINE',
      source_filename TEXT,
      total_analyzed INTEGER NOT NULL DEFAULT 0,
      bucket_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
      flags JSONB NOT NULL DEFAULT '[]'::jsonb,
      classifications JSONB NOT NULL DEFAULT '[]'::jsonb,
      status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
      day_mark INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mod_forensic_audit.user_cadence (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      audit_cadence VARCHAR(40) NOT NULL DEFAULT 'INITIAL',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE mod_forensic_audit.audits
      ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'PENDING'
  `);
  await pool.query(`
    ALTER TABLE mod_forensic_audit.audits
      ADD COLUMN IF NOT EXISTS day_mark INTEGER
  `);
}

// --- 1. SECURE MULTER STORAGE & FILTER CONFIGURATION ---
const ALLOWED_MIME_TYPES = [
  'text/csv',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
];

const storage = multer.memoryStorage(); // Keep file in buffer to secure sensitive financial data
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB limit
    files: 1 // Allow 1 statement per request
  },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('INVALID_FILE_TYPE: Only CSV, PDF, and XLSX statements are supported.'));
    }
  }
});

function resolveUserId(req) {
  return (
    (req.session && req.session.userId) ||
    (req.user && (req.user.id || req.user.userId)) ||
    (req.body && req.body.userId) ||
    null
  );
}

function requireAuth(req, res) {
  if (!resolveUserId(req)) {
    res.status(401).json({
      success: false,
      error: 'User context missing or unauthenticated.'
    });
    return false;
  }
  return true;
}

async function handleStatementUpload(req, res) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ success: false, error: 'No statement file uploaded.' });
    }

    const userId = resolveUserId(req);
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User context missing or unauthenticated.'
      });
    }

    console.log(
      `[UPLOADER] Statement received: ${req.file.originalname} (${req.file.size} bytes) for User: ${userId}`
    );

    // --- 3. EXECUTE FORENSIC AUDIT ENGINE ---
    const auditResults = await processInitialForensicAudit({
      userId,
      fileName: req.file.originalname,
      fileBuffer: req.file.buffer,
      mimeType: req.file.mimetype
    });

    return res.status(200).json({
      success: true,
      message: 'Statement successfully uploaded and processed through forensic audit engine.',
      data: auditResults
    });
  } catch (error) {
    console.error('[FORENSIC UPLOAD ERROR]', error && error.message ? error.message : 'unknown');
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ success: false, error: `Upload error: ${error.message}` });
    }
    return res.status(500).json({
      success: false,
      error: error.message || 'An internal server error occurred while analyzing the statement.'
    });
  }
}

function withUpload(req, res, next) {
  upload.single('statement')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    }
    return res.status(400).json({
      success: false,
      error: err.message || 'INVALID_FILE_TYPE: Only CSV, PDF, and XLSX statements are supported.'
    });
  });
}

const router = express.Router();

router.get(
  '/health',
  asyncRoute(async (_req, res) => {
    res.json({
      status: 'ok',
      module: 'mod_forensic_audit',
      buckets: FORENSIC_BUCKETS
    });
  })
);

// --- 2. FORENSIC STATEMENT UPLOAD ENDPOINT ---
/**
 * @route   POST /upload-statement  (also /api/forensic/upload-statement via alias)
 * @desc    Upload financial statement for forensic baseline audit
 * @access  Private (session auth)
 */
router.post('/upload-statement', withUpload, handleStatementUpload);
router.post('/baseline', withUpload, handleStatementUpload);

/**
 * @route   POST /expedited-reaudit
 * @desc    Process corrected statements/ledgers and clear remediation status
 * @access  Private
 */
// Route for submitting corrective statements for re-audit
router.post('/expedited-reaudit', withUpload, handleExpeditedReAudit);

router.get(
  '/status',
  asyncRoute(async (req, res) => {
    const userId = resolveUserId(req) || req.query.userId;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User authentication context required.'
      });
    }
    const pool = getPool();
    await ensureSchema(pool);
    const data = await getForensicStatus(pool, userId);
    res.json({ success: true, data });
  })
);

router.get(
  '/history',
  asyncRoute(async (req, res) => {
    if (!requireAuth(req, res)) return;
    const pool = getPool();
    await ensureSchema(pool);
    const { rows } = await pool.query(
      `SELECT id, audit_type, source_filename, total_analyzed, bucket_totals, flags, status, day_mark, created_at
         FROM mod_forensic_audit.audits
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50`,
      [req.session.userId]
    );
    res.json({ success: true, audits: rows });
  })
);

router.get(
  '/cadence',
  asyncRoute(async (req, res) => {
    if (!requireAuth(req, res)) return;
    const pool = getPool();
    await ensureSchema(pool);
    const userId = req.session.userId;

    const userRes = await pool.query(
      `SELECT id, created_at FROM users WHERE id = $1`,
      [userId]
    );
    if (!userRes.rows[0]) return res.status(404).json({ success: false, error: 'User not found' });

    await pool.query(
      `INSERT INTO mod_forensic_audit.user_cadence (user_id, audit_cadence)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, CADENCE.INITIAL]
    );

    const cadenceRes = await pool.query(
      `SELECT audit_cadence FROM mod_forensic_audit.user_cadence WHERE user_id = $1`,
      [userId]
    );
    const lastRes = await pool.query(
      `SELECT status, day_mark, created_at
         FROM mod_forensic_audit.audits
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    );

    const last = lastRes.rows[0]
      ? {
          status: lastRes.rows[0].status,
          dayMark: lastRes.rows[0].day_mark,
          createdAt: lastRes.rows[0].created_at
        }
      : null;

    const evaluation = checkAndTriggerMilestoneAudit({
      id: userId,
      createdAt: userRes.rows[0].created_at,
      auditCadence: cadenceRes.rows[0].audit_cadence,
      lastForensicAudit: last
    });

    if (evaluation.triggerAudit || evaluation.newCadenceState !== cadenceRes.rows[0].audit_cadence) {
      await pool.query(
        `UPDATE mod_forensic_audit.user_cadence
            SET audit_cadence = $2, updated_at = NOW()
          WHERE user_id = $1`,
        [userId, evaluation.newCadenceState]
      );
    }

    let email = null;
    if (evaluation.triggerAudit && req.query.notify === '1') {
      const emailRes = await pool.query(`SELECT email, name FROM users WHERE id = $1`, [userId]);
      if (emailRes.rows[0] && emailRes.rows[0].email) {
        try {
          email = await sendAuditReminderEmail({
            userEmail: emailRes.rows[0].email,
            userName: emailRes.rows[0].name,
            milestone: evaluation.newCadenceState,
            accountAgeDays: evaluation.accountAgeDays
          });
        } catch (mailErr) {
          email = { error: mailErr.message || 'send failed' };
        }
      }
    }

    res.json({ success: true, ...evaluation, email });
  })
);

router.post(
  '/cadence/remind',
  asyncRoute(async (req, res) => {
    if (!requireAuth(req, res)) return;
    const pool = getPool();
    await ensureSchema(pool);
    const userId = req.session.userId;

    const userRes = await pool.query(
      `SELECT id, email, name, created_at FROM users WHERE id = $1`,
      [userId]
    );
    if (!userRes.rows[0] || !userRes.rows[0].email) {
      return res.status(404).json({ success: false, error: 'User email not found' });
    }

    await pool.query(
      `INSERT INTO mod_forensic_audit.user_cadence (user_id, audit_cadence)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, CADENCE.INITIAL]
    );
    const cadenceRes = await pool.query(
      `SELECT audit_cadence FROM mod_forensic_audit.user_cadence WHERE user_id = $1`,
      [userId]
    );
    const lastRes = await pool.query(
      `SELECT status, day_mark FROM mod_forensic_audit.audits
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    const last = lastRes.rows[0]
      ? { status: lastRes.rows[0].status, dayMark: lastRes.rows[0].day_mark }
      : null;

    const evaluation = checkAndTriggerMilestoneAudit({
      id: userId,
      createdAt: userRes.rows[0].created_at,
      auditCadence: cadenceRes.rows[0].audit_cadence,
      lastForensicAudit: last
    });

    if (!evaluation.triggerAudit) {
      return res.json({
        success: true,
        sent: false,
        reason: 'No audit milestone currently due',
        ...evaluation
      });
    }

    const milestone =
      evaluation.newCadenceState === 'REMEDIATION_REQUIRED'
        ? 'DAY_90'
        : evaluation.newCadenceState;

    const data = await sendAuditReminderEmail({
      userEmail: userRes.rows[0].email,
      userName: userRes.rows[0].name,
      milestone,
      accountAgeDays: evaluation.accountAgeDays
    });

    res.json({ success: true, sent: true, milestone, data, ...evaluation });
  })
);

module.exports = {
  metadata: {
    name: 'Forensic Audit',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true
  },
  routes: router,
  aliasPath: '/api/forensic',
  aliasRouter: router,
  healthCheck: async () => ({
    status: 'ok',
    module: 'mod_forensic_audit',
    buckets: FORENSIC_BUCKETS
  }),
  processInitialForensicAudit,
  checkAndTriggerMilestoneAudit,
  sendAuditReminderEmail,
  FORENSIC_BUCKETS,
  CADENCE
};
