'use strict';

/**
 * Draft beta feedback / bug-report API.
 * Mount in server.js: app.use(require('./routes/betaFeedback'));
 *
 * Creates table on first use if missing. Requires authenticated session.
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');

async function ensureTable(db) {
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
}

// Mounted at /api/beta → POST /api/beta/feedback
router.post('/feedback', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const message = String((req.body && req.body.message) || '').trim();
  const category = String((req.body && req.body.category) || 'bug').trim().slice(0, 64);
  const pageUrl = String((req.body && req.body.pageUrl) || '').trim().slice(0, 2000);

  if (!message || message.length < 5) {
    return res.status(400).json({ error: 'Feedback message is required (min 5 characters).' });
  }

  try {
    const db = req.app.get('db') || pool;
    await ensureTable(db);
    const result = await db.query(
      `INSERT INTO beta_feedback (user_id, category, message, page_url, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [
        req.session.userId,
        category || 'bug',
        message.slice(0, 8000),
        pageUrl || null,
        String(req.headers['user-agent'] || '').slice(0, 1000)
      ]
    );
    return res.status(201).json({ success: true, id: result.rows[0].id, createdAt: result.rows[0].created_at });
  } catch (err) {
    console.error('[betaFeedback]', err.message);
    return res.status(500).json({ error: 'Failed to record feedback.' });
  }
});

module.exports = router;
