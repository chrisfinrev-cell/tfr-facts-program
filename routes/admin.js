const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();
const { pool } = require('../db/pool');
const {
  createTargetedInvites,
  createMasterAdminCode,
  invitesToCsv,
  parseMeta,
  ensureBetaInviteTables,
  recordInviteEmailResult,
  ADMIN_POOL_SIZE,
  INVITE_CODE_PREFIX,
  INVITE_STATUS,
  generateInviteCodes,
  ensureSharedInvitePool,
  listActiveInviteCodes,
  findActiveInviteCode
} = require('../lib/inviteCodes');
const { sendBetaInviteEmail, signupUrlForCode, appBaseUrl } = require('../lib/betaInviteEmail');
const { userIsAdminAccount, loadAdminFlags } = require('../config/adminAccess');

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
  const flags = await loadAdminFlags(db, req.session.userId);
  if (!flags) return null;
  try {
    const secret = await db.query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.session.userId]
    );
    flags.password_hash = secret.rows[0] ? secret.rows[0].password_hash : null;
  } catch (err) {
    flags.password_hash = null;
  }
  return flags;
}

function isAdminRow(row) {
  return userIsAdminAccount(row);
}

function adminCreatedBy(req, row) {
  if (row && row.email) return String(row.email);
  if (req.session && req.session.userId) return String(req.session.userId);
  return 'admin';
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
// Create multi-use master codes in beta_codes, or targeted beta_invites when recipient fields present.
router.post('/api/admin/generate-code', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const db = getDb(req);

  try {
    await ensureBetaInviteTables(db);
    const adminRow = await loadAdminUser(req);
    const createdBy = adminCreatedBy(req, adminRow);
    const hasRecipient = Boolean(
      body.sentToName || body.name || body.sentToEmail || body.email || body.recipientMetadata
    );

    if (hasRecipient || body.generateCleanCodes === true) {
      const created = await createTargetedInvites(db, {
        count: body.count || 1,
        name: body.sentToName || body.name,
        email: body.sentToEmail || body.email,
        meta: body.recipientMetadata || body.meta || {},
        parentCode: body.parentCode || body.parent_code,
        maxUses: body.maxUses || 1,
        createdByUserId: req.session.userId,
        createdBy
      });
      return res.json({
        success: true,
        invites: created,
        codes: created.map((row) => row.code),
        csv: invitesToCsv(created),
        message: `Created ${created.length} targeted invite code(s): ${created.map((row) => row.code).join(', ')}.`
      });
    }

    const master = await createMasterAdminCode(db, {
      code: body.code || body.codeName,
      maxUses: body.maxUses,
      createdByUserId: req.session.userId,
      createdBy
    });
    return res.json({
      success: true,
      code: master.code,
      maxUses: master.max_uses,
      usesCount: master.uses_count,
      createdBy: master.created_by || createdBy,
      message: master.created
        ? `Master code ${master.code} created with ${master.max_uses} uses.`
        : `Master code ${master.code} already existed. Added ${master.addedUses} uses (now ${master.max_uses}).`
    });
  } catch (err) {
    console.error('Error generating admin code:', err);
    const status = err && err.status ? err.status : 500;
    return res.status(status).json({
      success: false,
      error: err.message || 'Failed to create admin invite code.'
    });
  }
});

async function deliverInviteRows(db, rows) {
  const base = appBaseUrl();
  const deliveries = [];
  for (const invite of rows) {
    const email = invite.sent_to_email ? String(invite.sent_to_email).trim().toLowerCase() : '';
    if (!email) {
      deliveries.push({ id: invite.id, code: invite.code, sent: false, skipped: true });
      continue;
    }
    let result = { sent: false, error: 'Email was not attempted.' };
    try {
      result = await sendBetaInviteEmail({
        to: email,
        name: invite.sent_to_name,
        code: invite.code,
        signupUrl: signupUrlForCode(invite.code, base)
      });
    } catch (err) {
      console.error('Beta invite email dispatch failed:', err);
      result = { sent: false, error: err.message || 'Email dispatch threw an exception.' };
    }
    try {
      await recordInviteEmailResult(db, invite.id, result);
    } catch (err) {
      console.error('Could not record invite email result:', err);
    }
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
  const message = deliverySummary(created.length, deliveries);
  const codes = created.map((row) => row.code).filter(Boolean);
  const codeList = codes.join(', ');
  // Email is best-effort. Codes are already saved; never fail the create over SMTP.
  return res.status(200).json({
    success: true,
    created: true,
    emailSent: deliveries.some((row) => row.sent),
    emailError: failed.length ? failed.map((row) => row.error).filter(Boolean).join('; ') : null,
    invites: created,
    codes,
    csv: invitesToCsv(created),
    deliveries,
    message: failed.length
      ? `${message} Copy ${codeList} and send it yourself.`
      : message
  });
}

// --- 1b. POST /api/admin/generate-invites ---
// Creates targeted codes and emails each one that has a recipient address.
router.post('/api/admin/generate-invites', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const db = getDb(req);
  let created = [];
  try {
    await ensureBetaInviteTables(db);
    const adminRow = await loadAdminUser(req);
    created = await createTargetedInvites(db, {
      count: body.count || 1,
      name: body.sentToName || body.name || body.recipientName,
      email: body.sentToEmail || body.email || body.recipientEmail,
      meta: body.recipientMetadata || body.meta || body.metadata || {},
      parentCode: body.parentCode || body.parent_code,
      maxUses: body.maxUses || 1,
      createdByUserId: req.session.userId,
      createdBy: adminCreatedBy(req, adminRow)
    });
  } catch (err) {
    console.error('Error generating invites:', err);
    const detail = err && (err.message || err.detail || (typeof err === 'string' ? err : ''));
    const code = err && err.code ? ' (' + err.code + ')' : '';
    return res.status(err && err.status ? err.status : 500).json({
      success: false,
      error: (detail || 'Failed to create invite codes.') + code
    });
  }

  let deliveries = [];
  try {
    deliveries = await deliverInviteRows(db, created);
  } catch (err) {
    console.error('Invite email dispatch failed after codes were saved:', err);
    deliveries = created.map((row) => ({
      id: row.id,
      code: row.code,
      email: row.sent_to_email,
      sent: false,
      skipped: false,
      error: err.message || 'Email dispatch failed.'
    }));
  }
  return respondWithDeliveries(res, created, deliveries);
});

function inviteCodeSignupShape(row, base) {
  const used = row.status === INVITE_STATUS.USED;
  return {
    id: row.id,
    code: row.code,
    status: used ? 'signed_up' : (row.status === INVITE_STATUS.REVOKED ? 'revoked' : 'available'),
    inviteStatus: row.status,
    createdBy: row.createdBy,
    usedBy: row.usedBy,
    createdAt: row.createdAt,
    usedAt: row.usedAt,
    claimed_by_email: used ? row.usedBy : null,
    sent_to_email: null,
    sent_to_name: null,
    signup_url: signupUrlForCode(row.code, base)
  };
}

// Shared list of 100 FIN-REV codes. Every administrator sees and copies the same list.
router.get('/api/admin/invite-codes', requireAdmin, async (req, res) => {
  const db = getDb(req);
  try {
    const row = await loadAdminUser(req);
    const result = await ensureSharedInvitePool(db, adminCreatedBy(req, row));
    const codes = Array.isArray(result && result.codes) ? result.codes.filter(Boolean) : [];
    const wanted = String((req.query && req.query.status) || '').toUpperCase();
    const base = appBaseUrl();
    const withLinks = codes.map((code) => ({ ...code, signup_url: signupUrlForCode(code.code, base) }));
    const filtered = wanted ? withLinks.filter((code) => code.status === wanted) : withLinks;
    const count = (status) => withLinks.filter((code) => code.status === status).length;
    const activeCodes = withLinks.filter((code) => code.status === INVITE_STATUS.ACTIVE);
    return res.json({
      success: true,
      size: ADMIN_POOL_SIZE,
      prefix: INVITE_CODE_PREFIX,
      shared: true,
      active: count(INVITE_STATUS.ACTIVE),
      used: count(INVITE_STATUS.USED),
      revoked: count(INVITE_STATUS.REVOKED),
      codes: filtered,
      activeCodes
    });
  } catch (err) {
    console.error('Error loading invite codes:', err);
    return res.status(500).json({
      success: false,
      error: `Could not load invite codes: ${err.message}`,
      codes: [],
      activeCodes: [],
      active: 0,
      used: 0,
      revoked: 0
    });
  }
});

// Generate / top up the shared list of 100 codes. Does not create a private list per admin.
router.post('/api/admin/invite-codes/generate', requireAdmin, async (req, res) => {
  const db = getDb(req);
  const body = req.body || {};
  try {
    const row = await loadAdminUser(req);
    const createdBy = adminCreatedBy(req, row);
    const requested = parseInt(body.count, 10);
    const count = Number.isFinite(requested) && requested > 0
      ? Math.min(requested, ADMIN_POOL_SIZE)
      : ADMIN_POOL_SIZE;

    const existingActive = await listActiveInviteCodes(db);
    if (existingActive.length >= ADMIN_POOL_SIZE) {
      return res.json({
        success: true,
        generated: 0,
        prefix: INVITE_CODE_PREFIX,
        size: ADMIN_POOL_SIZE,
        shared: true,
        codes: existingActive,
        activeCodes: existingActive,
        message: `The shared list already has ${existingActive.length} active codes. Every administrator can copy them.`
      });
    }

    const missing = Math.max(0, count - existingActive.length);
    const created = missing > 0
      ? await generateInviteCodes(db, missing, INVITE_CODE_PREFIX, createdBy)
      : [];
    const { codes } = await ensureSharedInvitePool(db, createdBy);
    const activeCodes = codes.filter((code) => code.status === INVITE_STATUS.ACTIVE);
    return res.json({
      success: true,
      generated: created.length,
      prefix: INVITE_CODE_PREFIX,
      size: ADMIN_POOL_SIZE,
      shared: true,
      invites: created,
      codes: activeCodes,
      activeCodes,
      message: created.length
        ? `Added ${created.length} shared ${INVITE_CODE_PREFIX} codes. Every administrator can copy this list.`
        : `The shared list already has ${activeCodes.length} active codes.`
    });
  } catch (err) {
    console.error('Error generating invite codes:', err);
    return res.status(500).json({ error: `Failed to generate invite codes: ${err.message}` });
  }
});

// --- Admin pool: the shared list of 100 codes every administrator copies ---
router.get('/api/admin/beta-pool', requireAdmin, async (req, res) => {
  const db = getDb(req);
  try {
    const row = await loadAdminUser(req);
    const { codes } = await ensureSharedInvitePool(db, adminCreatedBy(req, row));
    const base = appBaseUrl();
    const mapped = codes.map((code) => inviteCodeSignupShape(code, base));
    const count = (status) => mapped.filter((row) => row.status === status).length;
    return res.json({
      success: true,
      size: ADMIN_POOL_SIZE,
      prefix: INVITE_CODE_PREFIX,
      shared: true,
      available: count('available'),
      assigned: 0,
      signedUp: count('signed_up'),
      active: mapped.filter((row) => row.inviteStatus === INVITE_STATUS.ACTIVE).length,
      used: mapped.filter((row) => row.inviteStatus === INVITE_STATUS.USED).length,
      codes: mapped
    });
  } catch (err) {
    console.error('Error loading admin beta pool:', err);
    return res.status(500).json({ error: `Could not load beta codes: ${err.message}` });
  }
});

// Emails a shared ACTIVE code. Status stays ACTIVE until signup redeems it.
router.post('/api/admin/beta-pool/assign', requireAdmin, async (req, res) => {
  const db = getDb(req);
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Enter the email of the person getting this code.' });
  }
  try {
    const row = await loadAdminUser(req);
    await ensureSharedInvitePool(db, adminCreatedBy(req, row));
    let invite = null;
    if (body.code) {
      invite = await findActiveInviteCode(db, body.code);
    } else if (body.inviteId) {
      const active = await listActiveInviteCodes(db);
      invite = active.find((code) => Number(code.id) === Number(body.inviteId)) || null;
    }
    if (!invite) {
      const active = await listActiveInviteCodes(db);
      invite = active[0] || null;
    }
    if (!invite) {
      return res.status(409).json({ error: `All ${ADMIN_POOL_SIZE} shared beta codes have already been used.` });
    }
    const result = await sendBetaInviteEmail({
      to: email,
      name: body.name,
      code: invite.code,
      signupUrl: signupUrlForCode(invite.code, appBaseUrl())
    });
    return res.json({
      success: true,
      code: invite.code,
      emailSent: !!result.sent,
      message: result.sent
        ? `Sent ${invite.code} to ${email}. The code stays on the shared list until they sign up.`
        : `Could not email ${invite.code}: ${result.error} Copy the code and share it yourself.`
    });
  } catch (err) {
    console.error('Error assigning admin beta code:', err);
    return res.status(500).json({ error: `Could not assign a beta code: ${err.message}` });
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
    try {
      await ensureBetaInviteTables(db);
    } catch (prepErr) {
      console.warn('beta invite tables could not be prepared:', prepErr.message);
    }

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
         WHERE COALESCE(recipient_metadata->>'pool', '') NOT IN ('admin', 'member')
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
