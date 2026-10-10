const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const { pool } = require('../db/pool');
const { createTargetedInvites, invitesToCsv, parseMeta } = require('../lib/inviteCodes');
const { sendBetaInviteEmail, signupUrlForCode, appBaseUrl } = require('../lib/betaInviteEmail');
const { userIsAdminAccount } = require('../config/adminAccess');

const ADMIN_UNLOCK_MS = 12 * 60 * 60 * 1000;

function getDb(req) {
  return req.app.get('db') || pool;
}

function adminToolsUnlocked(req) {
  const until = req.session && req.session.adminToolsUntil;
  return typeof until === 'number' && until > Date.now();
}

async function loadAdminUser(req) {
  const db = getDb(req);
  const userRes = await db.query(
    'SELECT is_admin, email, password_hash FROM users WHERE id = $1',
    [req.session.userId]
  );
  return userRes.rows[0] || null;
}

function isAdminRow(row) {
  return userIsAdminAccount(row);
}

// --- MIDDLEWARE: REQUIRE ADMIN ---
async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  try {
    const row = await loadAdminUser(req);
    if (!isAdminRow(row)) {
      return res.status(403).json({ error: 'Forbidden: Admin access required.' });
    }
    if (!adminToolsUnlocked(req)) {
      return res.status(403).json({
        error: 'Enter your password on this admin page to open admin tools.',
        code: 'admin_locked'
      });
    }
    next();
  } catch (err) {
    console.error('Admin verification error:', err);
    return res.status(500).json({ error: 'Server error checking admin credentials.' });
  }
}

// Password gate for the admin suite. Uses this account's FACTS password.
router.post('/api/admin/unlock', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  const password = String((req.body && req.body.password) || '');
  if (!password) {
    return res.status(400).json({ error: 'Enter your password.' });
  }

  const lockedUntil = req.session.adminUnlockLockedUntil;
  if (typeof lockedUntil === 'number' && lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Too many tries. Wait a few minutes and try again.' });
  }

  try {
    const row = await loadAdminUser(req);
    if (!isAdminRow(row)) {
      return res.status(403).json({ error: 'Forbidden: Admin access required.' });
    }
    if (!row.password_hash) {
      return res.status(400).json({ error: 'No password is set on this account.' });
    }
    const match = await bcrypt.compare(password, row.password_hash);
    if (!match) {
      const fails = (req.session.adminUnlockFails || 0) + 1;
      req.session.adminUnlockFails = fails;
      if (fails >= 8) {
        req.session.adminUnlockLockedUntil = Date.now() + 15 * 60 * 1000;
        req.session.adminUnlockFails = 0;
      }
      return res.status(401).json({ error: 'That password does not match this account.' });
    }
    req.session.adminUnlockFails = 0;
    req.session.adminUnlockLockedUntil = 0;
    req.session.adminToolsUntil = Date.now() + ADMIN_UNLOCK_MS;
    req.session.save(function (err) {
      if (err) {
        console.error('Admin unlock session error:', err);
        return res.status(500).json({ error: 'Could not open admin tools.' });
      }
      return res.json({ ok: true });
    });
  } catch (err) {
    console.error('Admin unlock error:', err);
    return res.status(500).json({ error: 'Could not check that password.' });
  }
});

// --- 1. POST /api/admin/generate-code ---
// Create multi-use master codes in beta_codes (legacy), OR targeted beta_invites when recipient fields present.
router.post('/api/admin/generate-code', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const db = getDb(req);

  const hasRecipient =
    Boolean(body.sentToName || body.name || body.sentToEmail || body.email || body.meta || body.recipientMetadata);

  // Targeted single/multi invites mapped to recipient identity
  if (hasRecipient || body.generateCleanCodes === true || Number(body.count) > 0) {
    try {
      const created = await createTargetedInvites(db, {
        count: body.count || 1,
        name: body.sentToName || body.name,
        email: body.sentToEmail || body.email,
        meta: body.recipientMetadata || body.meta || {},
        parentCode: body.parentCode || body.parent_code,
        maxUses: body.maxUses || 1,
        createdByUserId: req.session.userId
      });
      return res.json({
        success: true,
        invites: created,
        csv: invitesToCsv(created),
        message: `Created ${created.length} targeted invite code(s).`
      });
    } catch (err) {
      console.error('Error generating targeted invites:', err);
      return res.status(500).json({ error: 'Failed to create targeted invite codes.' });
    }
  }

  const { code, maxUses } = body;
  if (!code || !maxUses) {
    return res.status(400).json({
      error: 'Provide code + maxUses for a master code, or recipient name/email/meta for targeted invites.'
    });
  }

  try {
    const formattedCode = code.trim().toUpperCase();
    await db.query(
      `INSERT INTO beta_codes (code, max_uses) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET max_uses = beta_codes.max_uses + EXCLUDED.max_uses`,
      [formattedCode, parseInt(maxUses, 10)]
    );

    return res.json({ success: true, message: `Master code ${formattedCode} created with ${maxUses} uses.` });
  } catch (err) {
    console.error('Error generating admin code:', err);
    return res.status(500).json({ error: 'Failed to create admin invite code.' });
  }
});

async function ensureInviteEmailColumns(db) {
  await db.query('ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS last_emailed_at TIMESTAMPTZ');
  await db.query('ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS last_email_error TEXT');
}

async function recordInviteEmailResult(db, inviteId, result) {
  if (!inviteId) return;
  try {
    await ensureInviteEmailColumns(db);
    await db.query(
      `UPDATE beta_invites
       SET last_emailed_at = CASE WHEN $2::boolean THEN NOW() ELSE last_emailed_at END,
           last_email_error = $3
       WHERE id = $1`,
      [inviteId, !!result.sent, result.sent ? null : (result.error || 'Send failed')]
    );
  } catch (err) {
    console.warn('Could not record beta invite email status:', err.message);
  }
}

async function deliverInviteRows(db, rows) {
  const base = appBaseUrl();
  const deliveries = [];
  for (const invite of rows) {
    const email = invite.sent_to_email ? String(invite.sent_to_email).trim().toLowerCase() : '';
    if (!email) {
      deliveries.push({ id: invite.id, code: invite.code, sent: false, skipped: true });
      continue;
    }
    const result = await sendBetaInviteEmail({
      to: email,
      name: invite.sent_to_name,
      code: invite.code,
      signupUrl: signupUrlForCode(invite.code, base)
    });
    await recordInviteEmailResult(db, invite.id, result);
    deliveries.push({
      id: invite.id,
      code: invite.code,
      email,
      sent: !!result.sent,
      skipped: false,
      error: result.sent ? null : (result.error || 'Send failed')
    });
  }
  return deliveries;
}

function deliverySummary(createdCount, deliveries) {
  const sent = deliveries.filter((row) => row.sent);
  const failed = deliveries.filter((row) => !row.sent && !row.skipped);
  let message = `Created ${createdCount} invite code(s).`;
  if (sent.length) {
    message += ` Emailed ${sent.map((row) => `${row.code} to ${row.email}`).join('; ')}.`;
  }
  if (failed.length) {
    message += ` Email failed for ${failed.map((row) => `${row.code}: ${row.error}`).join('; ')}.`;
  }
  if (!sent.length && !failed.length) {
    message += ' Add a recipient email to send the code.';
  }
  return message;
}

function respondWithDeliveries(res, created, deliveries) {
  const failed = deliveries.filter((row) => !row.sent && !row.skipped);
  const emailFailed = failed.length > 0 && !deliveries.some((row) => row.sent);
  const message = deliverySummary(created.length, deliveries);
  const codes = created.map((row) => row.code).filter(Boolean).join(', ');
  return res.status(emailFailed ? 502 : 200).json({
    success: !emailFailed,
    invites: created,
    csv: invitesToCsv(created),
    deliveries,
    emailSent: deliveries.some((row) => row.sent),
    message,
    error: emailFailed ? `${message}${codes ? ` Code: ${codes}` : ''}` : undefined
  });
}

// --- 1b. POST /api/admin/generate-invites ---
// Creates targeted codes and emails each one that has a recipient address.
router.post('/api/admin/generate-invites', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const db = getDb(req);
  try {
    const created = await createTargetedInvites(db, {
      count: body.count || 1,
      name: body.sentToName || body.name,
      email: body.sentToEmail || body.email,
      meta: body.recipientMetadata || body.meta || {},
      parentCode: body.parentCode || body.parent_code,
      maxUses: body.maxUses || 1,
      createdByUserId: req.session.userId
    });
    const deliveries = await deliverInviteRows(db, created);
    return respondWithDeliveries(res, created, deliveries);
  } catch (err) {
    console.error('Error generating invites:', err);
    return res.status(500).json({ error: 'Failed to create invite codes.' });
  }
});

// Resend a targeted invite that is already in beta_invites.
router.post('/api/admin/beta-invites/:id/send', requireAdmin, async (req, res) => {
  const db = getDb(req);
  const inviteId = parseInt(req.params.id, 10);
  if (!inviteId) return res.status(400).json({ error: 'Invite id is required.' });

  const emailOverride = String((req.body && (req.body.email || req.body.sentToEmail)) || '').trim().toLowerCase();
  if (emailOverride && !emailOverride.includes('@')) {
    return res.status(400).json({ error: 'Enter a valid recipient email.' });
  }

  try {
    if (emailOverride) {
      await db.query('UPDATE beta_invites SET sent_to_email = $1 WHERE id = $2', [emailOverride, inviteId]);
    }
    const found = await db.query('SELECT * FROM beta_invites WHERE id = $1', [inviteId]);
    if (!found.rows[0]) return res.status(404).json({ error: 'Invite not found.' });
    if (!found.rows[0].sent_to_email) {
      return res.status(400).json({ error: 'This invite has no recipient email.' });
    }

    const deliveries = await deliverInviteRows(db, found.rows);
    const delivery = deliveries[0];
    if (!delivery || !delivery.sent) {
      return res.status(502).json({
        success: false,
        code: found.rows[0].code,
        error: (delivery && delivery.error) || 'Could not email that beta code.'
      });
    }
    return res.json({
      success: true,
      code: found.rows[0].code,
      email: delivery.email,
      message: `Emailed ${found.rows[0].code} to ${delivery.email}.`
    });
  } catch (err) {
    console.error('Error sending beta invite:', err);
    return res.status(500).json({ error: 'Failed to send that beta code.' });
  }
});

// Email an existing master beta code to a recipient.
router.post('/api/admin/beta-codes/send', requireAdmin, async (req, res) => {
  const db = getDb(req);
  const body = req.body || {};
  const code = String(body.code || '').trim().toUpperCase();
  const email = String(body.email || body.sentToEmail || '').trim().toLowerCase();
  const name = body.name || body.sentToName || '';

  if (!code) return res.status(400).json({ error: 'Code is required.' });
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Enter a valid recipient email.' });
  }

  try {
    const found = await db.query(
      'SELECT id, code, max_uses, uses_count FROM beta_codes WHERE UPPER(code) = $1',
      [code]
    );
    if (!found.rows[0]) return res.status(404).json({ error: 'That master code was not found.' });
    if (found.rows[0].uses_count >= found.rows[0].max_uses) {
      return res.status(400).json({ error: 'That master code has no uses left.' });
    }

    const result = await sendBetaInviteEmail({
      to: email,
      name,
      code: found.rows[0].code,
      signupUrl: signupUrlForCode(found.rows[0].code, appBaseUrl())
    });
    if (!result.sent) {
      return res.status(502).json({
        success: false,
        code: found.rows[0].code,
        error: result.error || 'Could not email that beta code.'
      });
    }
    return res.json({
      success: true,
      code: found.rows[0].code,
      email,
      message: `Emailed ${found.rows[0].code} to ${email}.`
    });
  } catch (err) {
    console.error('Error sending master beta code:', err);
    return res.status(500).json({ error: 'Failed to send that beta code.' });
  }
});

// --- 2. GET /api/admin/tracking ---
router.get('/api/admin/tracking', requireAdmin, async (req, res) => {
  const db = getDb(req);

  try {
    let masterCodes = { rows: [] };
    try {
      masterCodes = await db.query(
        `SELECT id, code, max_uses, uses_count, created_at
         FROM beta_codes
         ORDER BY created_at DESC`
      );
    } catch (codeErr) {
      console.warn('beta_codes tracking unavailable:', codeErr.message);
    }

    let targetedInvites = { rows: [] };
    try {
      targetedInvites = await db.query(
        `SELECT id, code, parent_code, sent_to_name, sent_to_email, recipient_metadata,
                claimed_by_user_id, claimed_at, max_uses, uses_count, created_at,
                last_emailed_at, last_email_error
         FROM beta_invites
         ORDER BY created_at DESC
         LIMIT 500`
      );
    } catch (inviteErr) {
      try {
        targetedInvites = await db.query(
          `SELECT id, code, parent_code, sent_to_name, sent_to_email, recipient_metadata,
                  claimed_by_user_id, claimed_at, max_uses, uses_count, created_at
           FROM beta_invites
           ORDER BY created_at DESC
           LIMIT 500`
        );
      } catch (fallbackErr) {
        console.warn('beta_invites tracking unavailable:', fallbackErr.message);
      }
    }

    let userLineage = { rows: [] };
    try {
      userLineage = await db.query(
        `SELECT
            u.id AS user_id,
            u.email,
            u.referral_code,
            u.affiliate_code,
            u.referred_by_code,
            u.affiliate_tier,
            u.monthly_invites_remaining,
            u.lifetime_invites_issued,
            u.nda_accepted_at,
            u.created_at,
            u.is_admin,
            u.income_programs_blocked,
            inviter.email AS invited_by_email,
            (SELECT COUNT(*) FROM users WHERE referrer_id = u.id) AS total_recruits
         FROM users u
         LEFT JOIN users inviter ON u.referrer_id = inviter.id
         ORDER BY u.created_at DESC`
      );
    } catch (lineageErr) {
      console.warn('user lineage tracking unavailable:', lineageErr.message);
    }

    return res.json({
      success: true,
      masterCodes: masterCodes.rows,
      targetedInvites: targetedInvites.rows,
      userLineage: userLineage.rows
    });
  } catch (err) {
    console.error('Error fetching admin tracking data:', err);
    return res.status(500).json({ error: 'Failed to retrieve tracking data.' });
  }
});

// --- 3. POST /api/admin/income-eligibility ---
router.post('/api/admin/income-eligibility', requireAdmin, async (req, res) => {
  const { userId, blocked } = req.body || {};
  const db = getDb(req);
  const targetId = parseInt(userId, 10);

  if (!targetId || typeof blocked !== 'boolean') {
    return res.status(400).json({ error: 'userId and blocked (boolean) are required.' });
  }

  try {
    const { isFounderAdmin } = require('../config/adminIncomePolicy');
    const target = await db.query(
      'SELECT id, email, is_admin, is_creator FROM users WHERE id = $1',
      [targetId]
    );
    if (target.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (isFounderAdmin(target.rows[0])) {
      return res.status(400).json({ error: 'The admin account cannot be made eligible for income programs.' });
    }

    const result = await db.query(
      `UPDATE users
       SET income_programs_blocked = $1
       WHERE id = $2
       RETURNING id, email, income_programs_blocked`,
      [blocked, targetId]
    );

    return res.json({
      success: true,
      user: result.rows[0],
      message: blocked
        ? `${result.rows[0].email} is now ineligible for income-generating programs.`
        : `${result.rows[0].email} is now eligible for income-generating programs.`
    });
  } catch (err) {
    console.error('Error updating income eligibility:', err);
    return res.status(500).json({ error: 'Failed to update income eligibility.' });
  }
});

module.exports = { router, requireAdmin, parseMeta };
