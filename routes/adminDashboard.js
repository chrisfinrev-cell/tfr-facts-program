'use strict';

const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { requireAdmin } = require('./admin');
const { invitesToCsv } = require('../lib/inviteCodes');
const { isFounderAdmin } = require('../config/adminIncomePolicy');
const {
  RELATIONSHIP_TAGS,
  normalizeRelationshipTag,
  isAffiliateExcluded
} = require('../lib/relationshipTags');

function getDb(req) {
  return req.app.get('db') || pool;
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

// Apply admin guard across all dashboard routes
router.use(requireAdmin);

/**
 * 1. Aggregated System Metrics
 * GET /api/admin/dashboard/stats
 */
router.get('/stats', async (req, res) => {
  const db = getDb(req);
  try {
    await ensureFeedbackTable(db);
    const statsQuery = await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE COALESCE(is_beta_tester, FALSE) = TRUE
           OR affiliate_code IS NOT NULL
           OR nda_accepted_at IS NOT NULL) AS total_beta_testers,
        (SELECT COUNT(*)::int FROM users) AS total_users,
        (SELECT COUNT(*)::int FROM beta_invites) AS total_invites,
        (SELECT COUNT(*)::int FROM beta_invites WHERE claimed_by_user_id IS NOT NULL) AS claimed_invites,
        (SELECT COUNT(*)::int FROM users WHERE referred_by_code IS NOT NULL OR referrer_id IS NOT NULL) AS affiliate_conversions,
        (SELECT COUNT(*)::int FROM beta_feedback WHERE COALESCE(status, 'open') = 'open') AS open_feedback
    `);
    const stats = statsQuery.rows[0] || {};
    const totalInvites = Number(stats.total_invites || 0);
    const claimed = Number(stats.claimed_invites || 0);
    return res.json({
      success: true,
      stats: {
        ...stats,
        claim_rate: totalInvites > 0 ? Number(((claimed / totalInvites) * 100).toFixed(1)) : 0
      }
    });
  } catch (error) {
    console.error('[adminDashboard/stats]', error.message);
    return res.status(500).json({ error: 'Failed to load dashboard stats.' });
  }
});

/**
 * 2. Invites & Cohort Listing
 * GET /api/admin/dashboard/invites
 */
router.get('/invites', async (req, res) => {
  const db = getDb(req);
  try {
    const invites = await db.query(`
      SELECT
        bi.id,
        bi.code,
        bi.parent_code,
        bi.sent_to_name,
        bi.sent_to_email,
        bi.recipient_metadata,
        bi.claimed_by_user_id,
        bi.claimed_at,
        bi.uses_count,
        bi.max_uses,
        bi.created_at,
        u.email AS claimed_by_email,
        u.name AS claimed_by_name
      FROM beta_invites bi
      LEFT JOIN users u ON bi.claimed_by_user_id = u.id
      ORDER BY bi.created_at DESC
      LIMIT 1000
    `);
    return res.json({ success: true, invites: invites.rows });
  } catch (error) {
    console.error('[adminDashboard/invites]', error.message);
    return res.status(500).json({ error: 'Failed to load invites.' });
  }
});

/**
 * 3. User & NDA Directory
 * GET /api/admin/dashboard/users
 */
router.get('/users', async (req, res) => {
  const db = getDb(req);
  const q = String((req.query && req.query.q) || '').trim();
  try {
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where = `WHERE LOWER(email) LIKE $1
        OR LOWER(COALESCE(name, '')) LIKE $1
        OR LOWER(COALESCE(affiliate_code, '')) LIKE $1
        OR LOWER(COALESCE(referral_code, '')) LIKE $1`;
    }

    const users = await db.query(
      `
      SELECT
        id,
        email,
        name AS full_name,
        affiliate_code,
        referral_code,
        referred_by_code,
        affiliate_tier,
        is_affiliate_disabled,
        relationship_tag,
        invite_metadata,
        is_admin,
        is_creator,
        is_beta_tester,
        nda_accepted_at,
        nda_version,
        created_at
      FROM users
      ${where}
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1000
      `,
      params
    );
    const enriched = users.rows.map((u) => ({
      ...u,
      affiliate_status: isAffiliateExcluded(u) ? 'EXCLUDED' : 'ACTIVE'
    }));
    return res.json({ success: true, users: enriched, relationshipTags: RELATIONSHIP_TAGS });
  } catch (error) {
    console.error('[adminDashboard/users]', error.message);
    return res.status(500).json({ error: 'Failed to load users.' });
  }
});

/**
 * 4. Future Generation Lineage Tree Lookup
 * GET /api/admin/dashboard/lineage/:code
 */
router.get('/lineage/:code', async (req, res) => {
  const db = getDb(req);
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!code) {
    return res.status(400).json({ error: 'Invite/affiliate code is required.' });
  }

  try {
    const parent = await db.query(
      `
      SELECT id, email, name AS full_name, affiliate_code, referral_code, referred_by_code, affiliate_tier, created_at
      FROM users
      WHERE UPPER(COALESCE(affiliate_code, '')) = $1
         OR UPPER(COALESCE(referral_code, '')) = $1
      LIMIT 1
      `,
      [code]
    );

    const children = await db.query(
      `
      SELECT
        id,
        email,
        name AS full_name,
        affiliate_code,
        referral_code,
        referred_by_code,
        affiliate_tier,
        created_at
      FROM users
      WHERE UPPER(COALESCE(referred_by_code, '')) = $1
         OR UPPER(COALESCE(affiliate_code, '')) IN (
              SELECT UPPER(code) FROM beta_invites WHERE UPPER(COALESCE(parent_code, '')) = $1
            )
      ORDER BY created_at ASC
      `,
      [code]
    );

    return res.json({
      success: true,
      parent_code: code,
      parent: parent.rows[0] || null,
      referrals: children.rows
    });
  } catch (error) {
    console.error('[adminDashboard/lineage]', error.message);
    return res.status(500).json({ error: 'Failed to load lineage.' });
  }
});

/**
 * 5. Beta Feedback Submissions
 * GET /api/admin/dashboard/feedback
 */
router.get('/feedback', async (req, res) => {
  const db = getDb(req);
  try {
    await ensureFeedbackTable(db);
    const feedback = await db.query(`
      SELECT
        bf.id,
        bf.user_id,
        bf.category,
        bf.message,
        bf.page_url,
        bf.user_agent,
        bf.status,
        bf.created_at,
        u.email AS user_email,
        u.name AS user_name
      FROM beta_feedback bf
      LEFT JOIN users u ON bf.user_id = u.id
      ORDER BY bf.created_at DESC
      LIMIT 500
    `);
    return res.json({ success: true, feedback: feedback.rows });
  } catch (error) {
    console.error('[adminDashboard/feedback]', error.message);
    return res.status(500).json({ error: 'Failed to load feedback.' });
  }
});

/**
 * 6. CSV export of invite claim audit trail
 * GET /api/admin/dashboard/invites.csv
 */
router.get('/invites.csv', async (req, res) => {
  const db = getDb(req);
  try {
    const invites = await db.query(`
      SELECT
        code,
        sent_to_name,
        sent_to_email,
        recipient_metadata,
        created_at,
        claimed_at,
        claimed_by_user_id,
        uses_count,
        max_uses
      FROM beta_invites
      ORDER BY created_at DESC
      LIMIT 5000
    `);
    const csv = invitesToCsv(invites.rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="beta-invites.csv"');
    return res.status(200).send(csv);
  } catch (error) {
    console.error('[adminDashboard/invites.csv]', error.message);
    return res.status(500).json({ error: 'Failed to export invites CSV.' });
  }
});

/**
 * 7. Role toggling (is_admin / is_creator)
 * PATCH /api/admin/dashboard/users/:id/roles
 */
router.patch('/users/:id/roles', async (req, res) => {
  const db = getDb(req);
  const targetId = parseInt(req.params.id, 10);
  const body = req.body || {};

  if (!targetId) {
    return res.status(400).json({ error: 'Valid user id is required.' });
  }
  if (typeof body.is_admin !== 'boolean' && typeof body.is_creator !== 'boolean') {
    return res.status(400).json({ error: 'Provide is_admin and/or is_creator boolean fields.' });
  }

  try {
    const targetRes = await db.query(
      'SELECT id, email, is_admin, is_creator FROM users WHERE id = $1',
      [targetId]
    );
    if (!targetRes.rows[0]) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const target = targetRes.rows[0];
    if (isFounderAdmin(target) && (body.is_admin === false || body.is_creator === false)) {
      return res.status(400).json({
        error: 'Founder/admin account roles cannot be revoked from this console.'
      });
    }
    if (targetId === req.session.userId && body.is_admin === false) {
      return res.status(400).json({ error: 'You cannot remove your own admin role.' });
    }

    const nextAdmin = typeof body.is_admin === 'boolean' ? body.is_admin : !!target.is_admin;
    const nextCreator =
      typeof body.is_creator === 'boolean' ? body.is_creator : !!target.is_creator;

    const updated = await db.query(
      `UPDATE users
       SET is_admin = $1, is_creator = $2
       WHERE id = $3
       RETURNING id, email, name AS full_name, is_admin, is_creator`,
      [nextAdmin, nextCreator, targetId]
    );

    return res.json({ success: true, user: updated.rows[0] });
  } catch (error) {
    console.error('[adminDashboard/roles]', error.message);
    return res.status(500).json({ error: 'Failed to update user roles.' });
  }
});

/**
 * 8. Relationship tag (Family / Close Contact / Standard)
 * PATCH /api/admin/dashboard/users/:id/relationship-tag
 */
router.patch('/users/:id/relationship-tag', async (req, res) => {
  const db = getDb(req);
  const targetId = parseInt(req.params.id, 10);
  const formattedTag = normalizeRelationshipTag(
    (req.body && (req.body.relationshipTag || req.body.relationship_tag)) || 'STANDARD'
  );

  if (!targetId) {
    return res.status(400).json({ error: 'Valid user id is required.' });
  }
  if (!RELATIONSHIP_TAGS.includes(formattedTag)) {
    return res.status(400).json({ error: 'Invalid tag option' });
  }

  try {
    let result;
    try {
      result = await db.query(
        `UPDATE users
         SET relationship_tag = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING id, email, name AS full_name, relationship_tag`,
        [formattedTag, targetId]
      );
    } catch (colErr) {
      if (!/updated_at/i.test(colErr.message)) throw colErr;
      result = await db.query(
        `UPDATE users
         SET relationship_tag = $1
         WHERE id = $2
         RETURNING id, email, name AS full_name, relationship_tag`,
        [formattedTag, targetId]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('[adminDashboard/relationship-tag]', err.message);
    return res.status(500).json({ error: 'Failed to update relationship tag.' });
  }
});

/**
 * 9. Affiliate program status (Active vs Excluded)
 * PATCH /api/admin/dashboard/users/:id/affiliate-status
 */
router.patch('/users/:id/affiliate-status', async (req, res) => {
  const db = getDb(req);
  const targetId = parseInt(req.params.id, 10);
  const raw = String(
    (req.body && (req.body.status || req.body.affiliateStatus || req.body.affiliate_tier)) || ''
  )
    .trim()
    .toUpperCase();

  if (!targetId) {
    return res.status(400).json({ error: 'Valid user id is required.' });
  }

  const excluded = raw === 'EXCLUDED' || raw === 'DISABLED' || raw === 'OFF';
  const active = raw === 'ACTIVE' || raw === 'ENABLED' || raw === 'ON' || raw === 'STANDARD';
  if (!excluded && !active) {
    return res.status(400).json({ error: 'status must be ACTIVE or EXCLUDED.' });
  }

  try {
    const existing = await db.query(
      'SELECT id, email, affiliate_tier, referral_code FROM users WHERE id = $1',
      [targetId]
    );
    if (!existing.rows[0]) {
      return res.status(404).json({ error: 'User not found.' });
    }

    let result;
    if (excluded) {
      result = await db.query(
        `UPDATE users
         SET affiliate_tier = 'EXCLUDED',
             is_affiliate_disabled = TRUE,
             affiliate_code = NULL,
             monthly_invites_remaining = 0
         WHERE id = $1
         RETURNING id, email, name AS full_name, affiliate_tier, is_affiliate_disabled,
                   affiliate_code, referral_code`,
        [targetId]
      );
    } else {
      // Restore active affiliate access; generate referral_code if missing
      const code =
        existing.rows[0].referral_code ||
        `FACTS-${require('crypto').randomBytes(3).toString('hex').toUpperCase()}`;
      result = await db.query(
        `UPDATE users
         SET affiliate_tier = CASE
               WHEN UPPER(COALESCE(affiliate_tier, '')) = 'EXCLUDED' THEN 'STANDARD'
               ELSE COALESCE(affiliate_tier, 'STANDARD')
             END,
             is_affiliate_disabled = FALSE,
             referral_code = COALESCE(referral_code, $2),
             monthly_invites_remaining = GREATEST(COALESCE(monthly_invites_remaining, 0), 5)
         WHERE id = $1
         RETURNING id, email, name AS full_name, affiliate_tier, is_affiliate_disabled,
                   affiliate_code, referral_code`,
        [targetId, code]
      );
    }

    const user = result.rows[0];
    return res.json({
      success: true,
      user: {
        ...user,
        affiliate_status: isAffiliateExcluded(user) ? 'EXCLUDED' : 'ACTIVE'
      }
    });
  } catch (err) {
    console.error('[adminDashboard/affiliate-status]', err.message);
    return res.status(500).json({ error: 'Failed to update affiliate status.' });
  }
});

module.exports = router;
