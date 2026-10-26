'use strict';

/**
 * Beta feedback / bug-report API.
 *
 * Mounts:
 *   app.use('/api/feedback', router)  → POST /api/feedback
 *   app.use('/api/beta', router)      → POST /api/beta/feedback (legacy)
 *
 * Persists to beta_feedback with user metadata. Table is ensured on first use.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');

const ALLOWED_CATEGORIES = new Set([
  'bug',
  'feedback',
  'feature',
  'other',
  'question',
  'ui',
  'performance'
]);

function getDb(req) {
  return (req && req.app && req.app.get('db')) || pool;
}

async function ensureFeedbackTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS beta_feedback (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      category VARCHAR(64) NOT NULL DEFAULT 'bug',
      message TEXT NOT NULL,
      page_url TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    ALTER TABLE beta_feedback
    ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'open'
  `);
}

function pickMessage(body) {
  const raw = (body && (body.message || body.description || body.feedback || body.bug || body.text)) || '';
  return String(raw).trim();
}

function pickCategory(body) {
  const raw = String((body && (body.category || body.type || body.kind)) || 'feedback')
    .trim()
    .toLowerCase()
    .slice(0, 64);
  if (!raw) return 'feedback';
  if (ALLOWED_CATEGORIES.has(raw)) return raw;
  // Allow free-form short labels from the client (e.g. "billing")
  return raw.replace(/[^a-z0-9_\- ]/gi, '').slice(0, 64) || 'feedback';
}

function pickPageUrl(body) {
  const raw = (body && (body.pageUrl || body.page_url || body.url || body.path)) || '';
  return String(raw).trim().slice(0, 2000);
}

async function createFeedback(req, res) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  const message = pickMessage(body);
  const category = pickCategory(body);
  const pageUrl = pickPageUrl(body);

  if (!message || message.length < 5) {
    return res.status(400).json({
      error: 'Feedback message is required (min 5 characters).'
    });
  }

  try {
    const db = getDb(req);
    await ensureFeedbackTable(db);

    const userAgent = String(req.headers['user-agent'] || '').slice(0, 1000);
    const result = await db.query(
      `INSERT INTO beta_feedback (user_id, category, message, page_url, user_agent, status)
       VALUES ($1, $2, $3, $4, $5, 'open')
       RETURNING id, category, page_url, status, created_at`,
      [
        req.session.userId,
        category,
        message.slice(0, 8000),
        pageUrl || null,
        userAgent || null
      ]
    );

    const row = result.rows[0];
    console.log(
      `[feedback] user=${req.session.userId} id=${row.id} category=${row.category}` +
      ` page=${row.page_url || '(none)'} email=${req.session.email || ''}`
    );

    return res.status(201).json({
      success: true,
      id: row.id,
      category: row.category,
      status: row.status,
      createdAt: row.created_at
    });
  } catch (err) {
    console.error('[feedback] create failed:', err.message);
    return res.status(500).json({ error: 'Failed to record feedback.' });
  }
}

async function listFeedback(db, opts) {
  const options = opts || {};
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 100, 1), 500);
  const status = options.status ? String(options.status).trim().toLowerCase() : null;

  await ensureFeedbackTable(db);

  const params = [];
  let where = '';
  if (status && status !== 'all') {
    params.push(status);
    where = `WHERE COALESCE(bf.status, 'open') = $${params.length}`;
  }
  params.push(limit);

  const result = await db.query(
    `SELECT
       bf.id,
       bf.user_id,
       bf.category,
       bf.message,
       bf.page_url,
       bf.user_agent,
       bf.status,
       bf.created_at,
       u.email AS user_email,
       u.name AS user_name,
       COALESCE(u.is_beta_tester, FALSE) AS is_beta_tester
     FROM beta_feedback bf
     LEFT JOIN users u ON bf.user_id = u.id
     ${where}
     ORDER BY bf.created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return result.rows;
}

// Canonical: POST /api/feedback
router.post('/', createFeedback);
// Legacy: POST /api/beta/feedback
router.post('/feedback', createFeedback);

module.exports = router;
module.exports.ensureFeedbackTable = ensureFeedbackTable;
module.exports.listFeedback = listFeedback;
module.exports.createFeedback = createFeedback;
