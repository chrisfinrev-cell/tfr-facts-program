'use strict';

// Admin panel and /api/admin routes.
// Mount:
//   app.use('/admin', pageRouter)          -> GET /admin
//   app.use('/api/admin', router)          -> /api/admin/*
//   app.use('/api/vault/admin', vaultRouter)

const fs = require('fs');
const path = require('path');
const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');
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
const {
  userIsAdminAccount,
  loadAdminFlags,
  userCanOpenAdmin,
  isAllowlistedAdminEmail,
  isFounderAdminEmail
} = require('../config/adminAccess');
const { applyPrivateCache } = require('../lib/privateCache');
const { SAFE_MODE } = require('../lib/safeMode');
const { collectAggregateMetrics, emptyAggregate } = require('../modules/admin/aggregate-metrics');
const { runAffiliateJobs, checkAndUpdateDepthGates: runDepthGateCheck } = require('../jobs/affiliate-jobs');
const { runTrialExpiryJob } = require('../jobs/trial-expiry-manager');
const { runInactivityJob } = require('../jobs/inactivity-manager');
const { runPriceChangeNotifierJob } = require('../jobs/price-change-notifier');
const { runPromoGraceJob } = require('../jobs/promo-grace-manager');
const {
  runDay1Reminders,
  runDay5Jobs,
  runHeartbeatComplianceCheck,
  runDay60and90Warnings
} = require('../jobs/heartbeat-compliance');

let runSovereignLensNightlyCycle = async function () {
  throw new Error('Sovereign Lens nightly job is not available');
};
try {
  runSovereignLensNightlyCycle = require('../jobs/sovereign-lens-nightly').runSovereignLensNightlyCycle;
} catch (err) {
  console.warn('[admin] sovereign-lens-nightly not loaded:', err.message);
}

const router = express.Router();
const pageRouter = express.Router();
const vaultRouter = express.Router();

const ADMIN_UNLOCK_MS = 12 * 60 * 60 * 1000;
const CREATOR_EMAIL = String(process.env.CREATOR_EMAIL || 'owner@example.com').toLowerCase();
const OWNER_EMAILS = String(process.env.OWNER_EMAILS || process.env.FUTURE_GEN_EMAILS || 'ecci2760@gmail.com,ecci2760f@gmail.com,dianes3cps@gmail.com')
  .split(',').map(function (e) { return e.trim().toLowerCase(); }).filter(Boolean);

const runtime = {};
function bindAdminRuntime(helpers) {
  Object.assign(runtime, helpers || {});
}

function getDb(req) {
  return (req && req.app && req.app.get('db')) || pool;
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

async function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  try {
    const row = await loadAdminUser(req);
    if (!isAdminRow(row)) {
      return res.status(403).json({ error: 'Forbidden: Admin access required.' });
    }
    if (!adminToolsUnlocked(req) && req.session) {
      req.session.adminToolsUntil = Date.now() + ADMIN_UNLOCK_MS;
    }
    if (!req.userId) req.userId = req.session.userId;
    next();
  } catch (err) {
    console.error('Admin verification error:', err);
    return res.status(500).json({ error: 'Server error checking admin credentials.' });
  }
}

async function isCreator(userOrId) {
  if (typeof runtime.isCreator === 'function') return runtime.isCreator(userOrId);
  const id = (userOrId && typeof userOrId === 'object') ? userOrId.id : userOrId;
  if (userOrId && typeof userOrId === 'object') {
    if (userOrId.is_creator) return true;
    if (isAllowlistedAdminEmail(userOrId.email) || isFounderAdminEmail(userOrId.email)) return true;
  }
  return userCanOpenAdmin(pool, id);
}

async function hasProAccess(userOrId) {
  if (typeof runtime.hasProAccess === 'function') return runtime.hasProAccess(userOrId);
  return false;
}

async function processOrphanUpgrade(userId) {
  if (typeof runtime.processOrphanUpgrade !== 'function') {
    throw new Error('Orphan placement is not bound yet');
  }
  return runtime.processOrphanUpgrade(userId);
}

async function processCommission(subscriptionId, isRenewal) {
  if (typeof runtime.processCommission !== 'function') {
    throw new Error('Commission processor is not bound yet');
  }
  return runtime.processCommission(subscriptionId, isRenewal);
}

function generatePromoCode() {
  if (typeof runtime.generatePromoCode === 'function') return runtime.generatePromoCode();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'PRO-';
  for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

function generateReferralCode(email) {
  if (typeof runtime.generateReferralCode === 'function') return runtime.generateReferralCode(email);
  const username = String(email || 'user').split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return username.substring(0, 8).toUpperCase() + random;
}

let launchWaitlistNameReady = null;
function ensureLaunchWaitlistNameColumn() {
  if (typeof runtime.ensureLaunchWaitlistNameColumn === 'function') {
    return runtime.ensureLaunchWaitlistNameColumn();
  }
  if (!launchWaitlistNameReady) {
    launchWaitlistNameReady = pool.query(
      'ALTER TABLE launch_waitlist ADD COLUMN IF NOT EXISTS name VARCHAR(200)'
    ).catch(function (err) {
      launchWaitlistNameReady = null;
      throw err;
    });
  }
  return launchWaitlistNameReady;
}

function requestIsAdmin(req) {
  if (typeof runtime.requestIsAdmin === 'function') return runtime.requestIsAdmin(req);
  const bodyEmail = req && req.body && req.body.adminEmail;
  const sessionEmail = req && req.session && (req.session.email || (req.session.user && req.session.user.email));
  return isAllowlistedAdminEmail(bodyEmail) || isAllowlistedAdminEmail(sessionEmail) || isFounderAdminEmail(sessionEmail);
}

async function requireCreator(req, res) {
  const userId = req.userId || (req.session && req.session.userId);
  const ok = await isCreator(userId);
  if (!ok) {
    res.status(403).json({ error: 'Admin access required', users: [], success: false });
    return false;
  }
  return true;
}

async function requireAdminOrCreator(req, res) {
  try {
    const userId = req.userId || (req.session && req.session.userId);
    if (await userCanOpenAdmin(getDb(req), userId)) return true;
  } catch (err) {
    console.warn('admin check failed:', err.message);
  }
  return requireCreator(req, res);
}

async function requireAdminAllowlist(req, res) {
  if (!req.session || !req.session.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  const allowed = await userCanOpenAdmin(getDb(req), req.session.userId);
  if (!allowed) {
    res.status(403).json({ error: 'Admin access required' });
    return false;
  }
  return true;
}

function escapeAdminHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function adminStayPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeAdminHtml(title)}</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0a0f1a; color:#f1f5f9; font-family:Segoe UI,sans-serif; }
  .card { max-width:460px; margin:24px; background:#111827; border:1px solid #334155; border-radius:14px; padding:28px; }
  h1 { font-size:1.25rem; margin:0 0 12px; }
  p { color:#cbd5e1; line-height:1.5; margin:0 0 16px; }
  a { color:#34d399; }
</style></head><body><div class="card">${bodyHtml}</div></body></html>`;
}

const resourceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const name = file.originalname.toLowerCase();
    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
                     '.xlsx', '.xls', '.csv', '.docx', '.doc', '.pptx', '.ppt', '.txt'];
    if (allowed.some(ext => name.endsWith(ext))) cb(null, true);
    else cb(new Error('Unsupported file type'));
  }
});

function getScheduler(name) {
  return runtime[name] || null;
}

const scheduler = {
  runNow: function () {
    if (runtime.scheduler && runtime.scheduler.runNow) return runtime.scheduler.runNow();
    return runInactivityJob(pool);
  }
};
const priceScheduler = {
  runNow: function () {
    if (runtime.priceScheduler && runtime.priceScheduler.runNow) return runtime.priceScheduler.runNow();
    return runPriceChangeNotifierJob(pool);
  }
};
const promoGraceScheduler = {
  runNow: function () {
    if (runtime.promoGraceScheduler && runtime.promoGraceScheduler.runNow) return runtime.promoGraceScheduler.runNow();
    return runPromoGraceJob(pool);
  }
};

function runNow() {
  if (runtime.affiliateJobs && runtime.affiliateJobs.runNow) return runtime.affiliateJobs.runNow();
  return runAffiliateJobs(pool);
}

function runDay1() {
  if (runtime.heartbeat && runtime.heartbeat.runDay1) return runtime.heartbeat.runDay1();
  return runDay1Reminders(pool);
}
function runComplianceCheck() {
  if (runtime.heartbeat && runtime.heartbeat.runComplianceCheck) return runtime.heartbeat.runComplianceCheck();
  return runHeartbeatComplianceCheck(pool);
}
function runDay5() {
  if (runtime.heartbeat && runtime.heartbeat.runDay5) return runtime.heartbeat.runDay5();
  return runDay5Jobs(pool);
}
function runCliffWarnings() {
  if (runtime.heartbeat && runtime.heartbeat.runCliffWarnings) return runtime.heartbeat.runCliffWarnings();
  return runDay60and90Warnings(pool);
}



// was /admin
pageRouter.get('/', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect(302, '/login.html?next=/admin');
  }

  let email = req.session.email || '';
  let allowed = isAllowlistedAdminEmail(email);
  try {
    if (!allowed) {
      allowed = await Promise.race([
        userCanOpenAdmin(pool, req.session.userId),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('admin lookup timed out')); }, 4000);
        })
      ]);
    }
    if (!email && pool) {
      const found = await Promise.race([
        pool.query('SELECT email FROM users WHERE id = $1', [req.session.userId]),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('admin email lookup timed out')); }, 4000);
        })
      ]);
      email = (found.rows[0] && found.rows[0].email) || '';
      if (!allowed) allowed = isAllowlistedAdminEmail(email);
    }
  } catch (err) {
    console.error('Admin page lookup failed:', err.message);
    if (!allowed) {
      return res.status(500).type('html').send(adminStayPage(
        'Admin page',
        '<h1>Admin page could not open</h1><p>This page could not check the signed-in account. Refresh and stay here. You are not being sent back to login.</p>'
      ));
    }
  }

  if (!allowed) {
    const who = email
      ? `You are signed in as <strong>${escapeAdminHtml(email)}</strong>.`
      : 'You are signed in.';
    return res.status(403).type('html').send(adminStayPage(
      'Admin access',
      `<h1>This account cannot open admin</h1><p>${who} Admin tools are only available on an admin account. This message stays on this page.</p><p><a href="/app">Back to the app</a></p>`
    ));
  }

  const htmlPath = path.join(__dirname, '..', 'public', 'admin.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  req.session.adminToolsUntil = Date.now() + (12 * 60 * 60 * 1000);
  const adminSession = JSON.stringify({ isAdmin: true, email: email || '' }).replace(/</g, '\\u003c');
  html = html.replace('</head>', `<script>window.__ADMIN_LOCKED=false;window.__ADMIN_SESSION=${adminSession};window.__SAFE_MODE=${SAFE_MODE ? 'true' : 'false'};</script></head>`);
  applyPrivateCache(res);
  if (!html.includes('facts-logout.js')) {
    html = html.replace(/<\/body>/i, '\n<script src="/js/facts-logout.js"></script>\n</body>');
  }
  res.type('html').send(html);
});


// Password gate for the admin suite. Uses this account's FACTS password.
router.post('/unlock', async (req, res) => {
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
router.post('/generate-code', requireAdmin, async (req, res) => {
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
router.post('/generate-invites', requireAdmin, async (req, res) => {
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
router.get('/invite-codes', requireAdmin, async (req, res) => {
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
router.post('/invite-codes/generate', requireAdmin, async (req, res) => {
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
router.get('/beta-pool', requireAdmin, async (req, res) => {
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
router.post('/beta-pool/assign', requireAdmin, async (req, res) => {
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
router.post('/beta-invites/:id/send', requireAdmin, async (req, res) => {
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
router.post('/beta-codes/send', requireAdmin, async (req, res) => {
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
router.get('/tracking', requireAdmin, async (req, res) => {
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
router.post('/income-eligibility', requireAdmin, async (req, res) => {
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

// was /api/admin/boot
router.get('/boot', requireAuth, async (req, res) => {
  try {
    const allowed = await userCanOpenAdmin(pool, req.userId);
    if (!allowed) {
      return res.status(403).json({ success: false, message: 'Unauthorized' });
    }
    let email = (req.session && req.session.email) || '';
    if (!email && pool) {
      try {
        const found = await pool.query('SELECT email FROM users WHERE id = $1', [req.userId]);
        email = (found.rows[0] && found.rows[0].email) || '';
      } catch (emailErr) {
        console.error('Admin boot email lookup failed:', emailErr.message);
      }
    }
    return res.status(200).json({
      success: true,
      safeMode: SAFE_MODE,
      user: { email: email, role: 'admin' },
      activeModules: SAFE_MODE ? ['auth', 'core-dashboard'] : ['auth', 'core-dashboard', 'admin'],
      message: SAFE_MODE ? 'Safe Mode active. Sub-modules isolated.' : 'Full admin boot.'
    });
  } catch (error) {
    console.error('Admin boot failed:', error);
    return res.status(500).json({ success: false, error: 'Boot failed' });
  }
});


// was /api/admin/trigger-orphan-placement
router.post('/trigger-orphan-placement', async (req, res) => {
  try {
    const { adminEmail } = req.body;
    if (!requestIsAdmin(req)) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const readyOrphans = await pool.query(
      `SELECT user_id FROM orphan_pool WHERE status = 'ready_to_place' ORDER BY upgraded_at ASC`
    );

    let processed = 0;
    for (const orphan of readyOrphans.rows) {
      await processOrphanUpgrade(orphan.user_id);
      processed++;
    }

    res.json({ message: `Processed ${processed} orphan placements` });
  } catch (err) {
    console.error('POST /api/admin/trigger-orphan-placement error:', err.message);
    res.status(500).json({ error: 'Failed to trigger orphan placement' });
  }
});

// was /api/admin/trigger-depth-gates
router.post('/trigger-depth-gates', async (req, res) => {
  try {
    const { adminEmail } = req.body;
    if (!requestIsAdmin(req)) {
      return res.status(403).json({ error: 'Admin only' });
    }
    console.log('[API] Manual 4x5 depth gate check triggered by admin');
    res.json({ success: true, message: 'Depth gate check started in background' });
    runDepthGateCheck(pool).catch(err => {
      console.error('[DepthGate] Manual trigger error:', err.message);
    });
  } catch (err) {
    console.error('POST /api/admin/trigger-depth-gates error:', err.message);
    res.status(500).json({ error: 'Failed to trigger depth gate check' });
  }
});

// was /api/admin/affiliates
router.get('/affiliates', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;
    const result = await pool.query(`
      SELECT
        a.id, a.user_id, a.email, a.referral_code, a.status,
        a.pending_balance_cents, a.approved_balance_cents, a.lifetime_earnings_cents,
        a.grace_period_started_at, a.grace_period_ends_at,
        a.stripe_connect_account_id, a.stripe_connect_onboarding_completed, a.w9_completed,
        a.good_standing_started_at, a.good_standing_achieved_at,
        a.paused_at, a.created_at,
        u.name, u.plan, u.paid_until, u.last_login, u.is_creator,
        (SELECT COUNT(*) FROM referrals r WHERE r.affiliate_id = a.id) AS total_referrals,
        (SELECT COUNT(*) FROM referrals r WHERE r.affiliate_id = a.id AND r.status = 'converted') AS converted_referrals,
        (SELECT COUNT(*) FROM commissions c WHERE c.affiliate_id = a.id AND c.status = 'pending') AS pending_commissions,
        (SELECT COUNT(*) FROM commissions c WHERE c.affiliate_id = a.id AND c.status = 'approved') AS approved_commissions
      FROM affiliates a
      JOIN users u ON u.id = a.user_id
      ORDER BY a.lifetime_earnings_cents DESC, a.created_at DESC
    `);

    // Stats summary
    const stats = {
      total_affiliates: result.rows.length,
      active: result.rows.filter(r => r.status === 'active').length,
      paused: result.rows.filter(r => r.status === 'paused').length,
      at_risk: result.rows.filter(r => r.status === 'at_risk').length,
      revoked: result.rows.filter(r => r.status === 'revoked').length,
      total_pending_cents: result.rows.reduce((s, r) => s + (r.pending_balance_cents || 0), 0),
      total_approved_cents: result.rows.reduce((s, r) => s + (r.approved_balance_cents || 0), 0),
      total_lifetime_cents: result.rows.reduce((s, r) => s + (r.lifetime_earnings_cents || 0), 0),
      stripe_connect_ready: result.rows.filter(r => r.stripe_connect_onboarding_completed).length
    };

    res.json({ affiliates: result.rows, stats });
  } catch (err) {
    console.error('GET /api/admin/affiliates error:', err.message);
    res.status(500).json({ error: 'Failed to load affiliates' });
  }
});

// was /api/admin/affiliates/:id/status
router.post('/affiliates/:id/status', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;
    const { id } = req.params;
    const { action } = req.body; // 'pause' | 'reactivate' | 'revoke'

    const statusMap = { pause: 'paused', reactivate: 'active', revoke: 'revoked' };
    if (!statusMap[action]) return res.status(400).json({ error: 'Invalid action' });

    const extra = action === 'pause' ? ', paused_at = NOW()' : (action === 'reactivate' ? ', paused_at = NULL' : '');
    await pool.query(
      `UPDATE affiliates SET status = $1${extra}, updated_at = NOW() WHERE id = $2`,
      [statusMap[action], id]
    );

    res.json({ success: true, new_status: statusMap[action] });
  } catch (err) {
    console.error('POST /api/admin/affiliates/:id/status error:', err.message);
    res.status(500).json({ error: 'Failed to update affiliate status' });
  }
});

// was /api/admin/affiliates/:id/adjust-balance
router.post('/affiliates/:id/adjust-balance', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;
    const { id } = req.params;
    const { field, amount_cents, reason } = req.body;
    const allowedFields = ['pending_balance_cents', 'approved_balance_cents', 'lifetime_earnings_cents'];
    if (!allowedFields.includes(field)) return res.status(400).json({ error: 'Invalid field' });
    if (typeof amount_cents !== 'number') return res.status(400).json({ error: 'amount_cents must be a number' });

    const result = await pool.query(
      `UPDATE affiliates SET ${field} = GREATEST(0, ${field} + $1), updated_at = NOW() WHERE id = $2 RETURNING *`,
      [amount_cents, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Affiliate not found' });

    console.log(`[Admin] Balance adjustment: affiliate ${id}, field=${field}, delta=${amount_cents}, reason=${reason}`);
    res.json({ success: true, affiliate: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/affiliates/:id/adjust-balance error:', err.message);
    res.status(500).json({ error: 'Failed to adjust balance' });
  }
});

// was /api/admin/legacy-placement
router.post('/legacy-placement', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;

    const { recruit_user_id, enroller_user_id, placement_parent_id } = req.body;

    if (!recruit_user_id || !enroller_user_id || !placement_parent_id) {
      return res.status(400).json({
        error: 'Missing required fields: recruit_user_id, enroller_user_id, placement_parent_id'
      });
    }

    // Validate recruit exists and is not already an affiliate
    const recruitUser = await pool.query('SELECT id, email FROM users WHERE id = $1', [recruit_user_id]);
    if (recruitUser.rows.length === 0) {
      return res.status(404).json({ error: 'Recruit user not found' });
    }
    const existingAffiliate = await pool.query('SELECT id FROM affiliates WHERE user_id = $1', [recruit_user_id]);
    if (existingAffiliate.rows.length > 0) {
      return res.status(409).json({ error: 'Recruit is already a Future Generations member' });
    }

    // Validate enroller is an active affiliate
    const enrollerAff = await pool.query(
      `SELECT a.id FROM affiliates a WHERE a.user_id = $1 AND a.status = 'active'`,
      [enroller_user_id]
    );
    if (enrollerAff.rows.length === 0) {
      return res.status(400).json({ error: 'Enroller is not an active affiliate' });
    }

    // Validate placement parent exists as an affiliate
    const placementParent = await pool.query(
      `SELECT a.id, a.affiliate_level FROM affiliates a WHERE a.id = $1 AND a.status != 'revoked'`,
      [placement_parent_id]
    );
    if (placementParent.rows.length === 0) {
      return res.status(400).json({ error: 'Placement parent affiliate not found or is revoked' });
    }

    // Determine level for the recruit (one deeper than placement parent, capped at 5)
    const recruitLevel = Math.min((placementParent.rows[0].affiliate_level || 1) + 1, 5);

    // Generate referral code for recruit
    const recruitEmail = recruitUser.rows[0].email;
    let referralCode;
    let codeAttempts = 0;
    while (codeAttempts < 10) {
      const username = recruitEmail.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
      const random = Math.random().toString(36).substring(2, 6).toUpperCase();
      referralCode = `${username.substring(0, 8).toUpperCase()}${random}`;
      const codeCheck = await pool.query('SELECT id FROM affiliates WHERE referral_code = $1', [referralCode]);
      if (codeCheck.rows.length === 0) break;
      codeAttempts++;
    }

    // Check if recruit already has Pro (to start good standing clock)
    const proCheck = await hasProAccess(recruit_user_id);

    // Insert the legacy affiliate record
    const result = await pool.query(
      `INSERT INTO affiliates
         (user_id, email, referral_code, status,
          good_standing_started_at,
          parent_affiliate_id, affiliate_level, placement_method,
          enrollment_type, enroller_id, enrolled_at, is_legacy_placement)
       VALUES ($1, $2, $3, 'active', $4, $5, $6, 'legacy_drop', 'legacy', $7, NOW(), TRUE)
       RETURNING *`,
      [
        recruit_user_id,
        recruitEmail.toLowerCase(),
        referralCode,
        proCheck ? new Date() : null,
        placement_parent_id,
        recruitLevel,
        enrollerAff.rows[0].id
      ]
    );

    // Set referred_by_user_id to placement parent's user (for tree continuity on renewals)
    await pool.query(
      `UPDATE users SET referred_by_user_id = (SELECT user_id FROM affiliates WHERE id = $1)
       WHERE id = $2 AND referred_by_user_id IS NULL`,
      [placement_parent_id, recruit_user_id]
    );

    console.log(
      `[Admin] Legacy Placement created: recruit user ${recruit_user_id} placed under affiliate ${placement_parent_id} ` +
      `by enroller affiliate ${enrollerAff.rows[0].id}. Level: ${recruitLevel}`
    );

    res.json({
      success: true,
      message: 'Legacy Placement created successfully',
      affiliate: result.rows[0],
      commission_structure: {
        month_1: {
          enroller: '20%',
          placement_parent: '5%',
          level_3: '3%',
          level_4: '2%',
          level_5: '1%',
          total: '31%'
        },
        month_2_plus: 'Standard 16-8-4-2-1 based on tree position'
      }
    });
  } catch (err) {
    console.error('POST /api/admin/legacy-placement error:', err.message);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Recruit is already in the affiliate system' });
    }
    res.status(500).json({ error: 'Failed to create Legacy Placement' });
  }
});

// was /api/admin/affiliate-seed-status
router.get('/affiliate-seed-status', requireAuth, async (req, res) => {
  let client;
  try {
    if (!(await requireAdminOrCreator(req, res))) return;
    if (!pool) return res.status(500).json({ success: false, error: 'Database unavailable' });
    client = await pool.connect();
    await client.query("SET statement_timeout = '5000'");

    const firstLine = await client.query("SELECT COUNT(*) FROM affiliates WHERE affiliate_level = 1");
    const firstLineCount = parseInt(firstLine.rows[0].count, 10);
    const seedComplete = firstLineCount >= 100;

    // Level breakdown
    const levelBreakdown = await client.query(`
      SELECT affiliate_level, placement_method, COUNT(*) as count
      FROM affiliates
      GROUP BY affiliate_level, placement_method
      ORDER BY affiliate_level ASC, placement_method ASC
    `);

    // Total org size
    const totalAffiliates = await client.query('SELECT COUNT(*) FROM affiliates');

    res.json({
      success: true,
      seed_phase: {
        active: !seedComplete,
        first_line_count: firstLineCount,
        first_line_capacity: 100,
        first_line_remaining: Math.max(0, 100 - firstLineCount),
        percent_filled: Math.min(100, Math.round((firstLineCount / 100) * 100))
      },
      placement_mode: seedComplete ? 'bfs_auto_fill' : 'seed_phase',
      total_affiliates: parseInt(totalAffiliates.rows[0].count, 10),
      level_breakdown: levelBreakdown.rows.map(r => ({
        level: r.affiliate_level,
        placement_method: r.placement_method,
        count: parseInt(r.count, 10)
      }))
    });
  } catch (err) {
    console.error('GET /api/admin/affiliate-seed-status error:', err.message);
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Failed to load seed status' });
  } finally {
    if (client) {
      try { await client.query('RESET statement_timeout'); } catch (resetErr) { /* connection may already be dead */ }
      client.release();
    }
  }
});

// was /api/admin/founding-members
router.get('/founding-members', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;
    const { limit = 50, before_date } = req.query;

    // Founding members = users who subscribed to Pro early
    // If no cutoff provided, return all Pro users sorted by first subscription date
    const cutoff = before_date ? new Date(before_date) : new Date('2099-01-01');

    const result = await pool.query(`
      SELECT
        u.id, u.name, u.email, u.plan, u.paid_until, u.created_at, u.last_login,
        u.is_creator,
        s.created_at AS first_subscription_date,
        s.amount_cents AS subscription_amount,
        a.id AS affiliate_id, a.referral_code, a.status AS affiliate_status,
        a.lifetime_earnings_cents, a.pending_balance_cents, a.approved_balance_cents,
        (SELECT COUNT(*) FROM referrals r WHERE r.affiliate_id = a.id AND r.status = 'converted') AS converted_referrals
      FROM users u
      JOIN (
        SELECT user_id, MIN(created_at) AS created_at, amount_cents
        FROM subscriptions
        WHERE status = 'completed'
        GROUP BY user_id, amount_cents
      ) s ON s.user_id = u.id
      LEFT JOIN affiliates a ON a.user_id = u.id
      WHERE s.created_at < $1
      ORDER BY s.created_at ASC
      LIMIT $2
    `, [cutoff, parseInt(limit)]);

    res.json({
      founding_members: result.rows,
      count: result.rows.length,
      cutoff_date: cutoff
    });
  } catch (err) {
    console.error('GET /api/admin/founding-members error:', err.message);
    res.status(500).json({ error: 'Failed to load founding members' });
  }
});

// was /api/admin/founding-members/:userId/tag
router.post('/founding-members/:userId/tag', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;
    const { userId } = req.params;
    const { is_founding_member } = req.body;

    const result = await pool.query(
      `UPDATE users SET is_founding_member = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name, email, is_founding_member`,
      [!!is_founding_member, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/founding-members/:userId/tag error:', err.message);
    res.status(500).json({ error: 'Failed to update founding member status' });
  }
});

// was /api/admin/promo-codes/generate
router.post('/promo-codes/generate', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) {
      return res.status(403).json({ error: 'Only the creator can generate promo codes' });
    }

    // Generate unique code
    let code;
    let attempts = 0;
    while (attempts < 20) {
      code = generatePromoCode();
      const existing = await pool.query('SELECT id FROM promo_codes WHERE code = $1', [code]);
      if (existing.rows.length === 0) break;
      attempts++;
    }

    if (attempts >= 20) {
      return res.status(500).json({ error: 'Failed to generate unique code' });
    }

    const result = await pool.query(
      `INSERT INTO promo_codes (code, created_by, status)
       VALUES ($1, $2, 'active') RETURNING *`,
      [code, req.userId]
    );

    res.json({
      success: true,
      promo_code: result.rows[0]
    });
  } catch (err) {
    console.error('POST /api/admin/promo-codes/generate error:', err.message);
    res.status(500).json({ error: 'Failed to generate promo code' });
  }
});

// was /api/admin/promo-codes/list
router.get('/promo-codes/list', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) {
      return res.status(403).json({ error: 'Only the creator can view promo codes' });
    }

    const result = await pool.query(`
      SELECT
        pc.id,
        pc.code,
        pc.status,
        pc.created_at,
        pc.redeemed_at,
        u.email as redeemed_by_email,
        u.name as redeemed_by_name
      FROM promo_codes pc
      LEFT JOIN users u ON pc.redeemed_by = u.id
      ORDER BY pc.created_at DESC
    `);

    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active') as active_count,
        COUNT(*) FILTER (WHERE status = 'redeemed') as redeemed_count
      FROM promo_codes
    `);

    res.json({
      codes: result.rows,
      stats: stats.rows[0]
    });
  } catch (err) {
    console.error('GET /api/admin/promo-codes/list error:', err.message);
    res.status(500).json({ error: 'Failed to list promo codes' });
  }
});

// was /api/admin/trial-stats
router.get('/trial-stats', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) {
      return res.status(403).json({ error: 'Creator access required' });
    }

    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE trial_used = true)                                               AS total_trials_started,
        COUNT(*) FILTER (WHERE trial_used = true AND trial_expires_at > NOW())                  AS active_trials,
        COUNT(*) FILTER (WHERE trial_used = true AND trial_expires_at <= NOW())                 AS expired_trials,
        COUNT(*) FILTER (
          WHERE trial_used = true
            AND trial_expires_at <= NOW()
            AND plan = 'paid'
            AND paid_until IS NOT NULL
            AND paid_until > NOW()
        )                                                                                        AS converted_to_paid,
        COUNT(*) FILTER (WHERE trial_used = true AND trial_plan_type = 'individual')            AS individual_trials,
        COUNT(*) FILTER (WHERE trial_used = true AND trial_plan_type = 'family')             AS household_trials,
        ROUND(
          100.0 * COUNT(*) FILTER (
            WHERE trial_used = true
              AND trial_expires_at <= NOW()
              AND plan = 'paid'
              AND paid_until IS NOT NULL
              AND paid_until > NOW()
          ) / NULLIF(COUNT(*) FILTER (WHERE trial_used = true AND trial_expires_at <= NOW()), 0),
          1
        )                                                                                        AS conversion_rate_pct
      FROM users
    `);

    // Trial duration stats (how many days into trial when they converted)
    const conversionDaysResult = await pool.query(`
      SELECT
        ROUND(AVG(
          EXTRACT(EPOCH FROM (
            s.started_at - u.trial_started_at
          )) / 86400
        ), 1) AS avg_days_to_convert
      FROM users u
      JOIN subscriptions s ON s.user_id = u.id AND s.status = 'completed'
      WHERE u.trial_used = true
        AND u.trial_started_at IS NOT NULL
        AND s.started_at >= u.trial_started_at
        AND s.started_at <= u.trial_expires_at
      LIMIT 1
    `);

    // Active trials list with expiry info
    const activeTrialsResult = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.trial_started_at,
        u.trial_expires_at,
        u.trial_plan_type,
        CEIL(EXTRACT(EPOCH FROM (u.trial_expires_at - NOW())) / 86400) AS days_remaining
      FROM users u
      WHERE u.trial_used = true
        AND u.trial_expires_at > NOW()
        AND u.is_creator = false
        AND NOT (u.plan = 'paid' AND u.paid_until IS NOT NULL AND u.paid_until > NOW())
      ORDER BY u.trial_expires_at ASC
      LIMIT 50
    `);

    const stats = result.rows[0];
    const conversionStats = conversionDaysResult.rows[0];

    res.json({
      summary: {
        total_trials_started: parseInt(stats.total_trials_started) || 0,
        active_trials: parseInt(stats.active_trials) || 0,
        expired_trials: parseInt(stats.expired_trials) || 0,
        converted_to_paid: parseInt(stats.converted_to_paid) || 0,
        individual_trials: parseInt(stats.individual_trials) || 0,
        household_trials: parseInt(stats.household_trials) || 0,
        conversion_rate_pct: parseFloat(stats.conversion_rate_pct) || 0,
        avg_days_to_convert: parseFloat(conversionStats.avg_days_to_convert) || null
      },
      active_trials: activeTrialsResult.rows
    });
  } catch (err) {
    console.error('GET /api/admin/trial-stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch trial stats' });
  }
});

// was /api/admin/trigger-trial-expiry
router.post('/trigger-trial-expiry', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Creator access required' });
    console.log('[TrialExpiry] Manual trigger by admin');
    runTrialExpiryJob(pool).catch(err => console.error('[TrialExpiry] Manual job error:', err.message));
    res.json({ success: true, message: 'Trial expiry job triggered' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});





// was /api/admin/trigger-inactivity-job
router.post('/trigger-inactivity-job', async (req, res) => {
  try {
    // Verify creator email (uses centralized CREATOR_EMAIL constant)
    const { adminEmail } = req.body;

    if (!requestIsAdmin(req)) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    if (!scheduler) {
      return res.status(500).json({ error: 'Scheduler not initialized' });
    }

    console.log('[API] Manual inactivity job triggered by admin');
    res.json({ success: true, message: 'Inactivity job started in background' });

    // Run asynchronously without blocking response
    scheduler.runNow().catch(err => {
      console.error('[API] Inactivity job error:', err);
    });
  } catch (err) {
    console.error('POST /api/admin/trigger-inactivity-job error:', err.message);
    res.status(500).json({ error: 'Failed to trigger job' });
  }
});

// was /api/admin/trigger-price-notifier
router.post('/trigger-price-notifier', async (req, res) => {
  try {
    const { adminEmail } = req.body;
    if (!requestIsAdmin(req)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!priceScheduler) {
      return res.status(500).json({ error: 'Price notifier scheduler not initialized' });
    }
    console.log('[API] Manual price notifier job triggered by admin');
    res.json({ success: true, message: 'Price change notifier started in background' });
    priceScheduler.runNow().catch(err => {
      console.error('[API] Price notifier job error:', err);
    });
  } catch (err) {
    console.error('POST /api/admin/trigger-price-notifier error:', err.message);
    res.status(500).json({ error: 'Failed to trigger price notifier' });
  }
});

// was /api/admin/trigger-promo-grace-job
router.post('/trigger-promo-grace-job', async (req, res) => {
  try {
    const { adminEmail } = req.body;
    if (!requestIsAdmin(req)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!promoGraceScheduler) {
      return res.status(500).json({ error: 'Promo grace scheduler not initialized' });
    }
    console.log('[API] Manual promo grace job triggered by admin');
    res.json({ success: true, message: 'Promo grace job started in background' });
    promoGraceScheduler.runNow().catch(err => {
      console.error('[API] Promo grace job error:', err);
    });
  } catch (err) {
    console.error('POST /api/admin/trigger-promo-grace-job error:', err.message);
    res.status(500).json({ error: 'Failed to trigger promo grace job' });
  }
});

// was /api/admin/trigger-affiliate-jobs
router.post('/trigger-affiliate-jobs', async (req, res) => {
  try {
    const { adminEmail } = req.body;
    if (!requestIsAdmin(req)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!affiliateJobsScheduler) {
      return res.status(500).json({ error: 'Affiliate jobs scheduler not initialized' });
    }
    console.log('[API] Manual affiliate jobs triggered by admin');
    res.json({ success: true, message: 'Affiliate jobs started in background' });
    affiliateJobsScheduler.runNow().catch(err => {
      console.error('[API] Affiliate jobs error:', err);
    });
  } catch (err) {
    console.error('POST /api/admin/trigger-affiliate-jobs error:', err.message);
    res.status(500).json({ error: 'Failed to trigger affiliate jobs' });
  }
});

// was /api/admin/trigger-heartbeat-compliance
router.post('/trigger-heartbeat-compliance', async (req, res) => {
  try {
    const { adminEmail } = req.body;
    if (!requestIsAdmin(req)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!heartbeatComplianceScheduler) {
      return res.status(500).json({ error: 'Heartbeat compliance scheduler not initialized' });
    }
    console.log('[API] Manual heartbeat compliance check triggered by admin');
    res.json({ success: true, message: 'Heartbeat compliance check started in background' });
    heartbeatComplianceScheduler.runComplianceCheck().catch(err => {
      console.error('[API] Heartbeat compliance check error:', err);
    });
  } catch (err) {
    console.error('POST /api/admin/trigger-heartbeat-compliance error:', err.message);
    res.status(500).json({ error: 'Failed to trigger heartbeat compliance' });
  }
});

// was /api/admin/trigger-heartbeat-day1
router.post('/trigger-heartbeat-day1', async (req, res) => {
  try {
    const { adminEmail } = req.body;
    if (!requestIsAdmin(req)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!heartbeatComplianceScheduler) {
      return res.status(500).json({ error: 'Scheduler not initialized' });
    }
    console.log('[API] Manual heartbeat Day 1 reminders triggered by admin');
    res.json({ success: true, message: 'Day 1 heartbeat reminders started in background' });
    heartbeatComplianceScheduler.runDay1().catch(err => {
      console.error('[API] Day 1 reminders error:', err);
    });
  } catch (err) {
    console.error('POST /api/admin/trigger-heartbeat-day1 error:', err.message);
    res.status(500).json({ error: 'Failed to trigger Day 1 reminders' });
  }
});

// was /api/admin/trigger-heartbeat-cliff-warnings
router.post('/trigger-heartbeat-cliff-warnings', async (req, res) => {
  try {
    const { adminEmail } = req.body;
    if (!requestIsAdmin(req)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!heartbeatComplianceScheduler) {
      return res.status(500).json({ error: 'Scheduler not initialized' });
    }
    console.log('[API] Manual heartbeat cliff warnings triggered by admin');
    res.json({ success: true, message: 'Day 60/90 cliff warning job started in background' });
    heartbeatComplianceScheduler.runCliffWarnings().catch(err => {
      console.error('[API] Cliff warnings error:', err);
    });
  } catch (err) {
    console.error('POST /api/admin/trigger-heartbeat-cliff-warnings error:', err.message);
    res.status(500).json({ error: 'Failed to trigger cliff warnings' });
  }
});

// was /api/admin/trigger-heartbeat-day5
router.post('/trigger-heartbeat-day5', async (req, res) => {
  try {
    const { adminEmail } = req.body;
    if (!requestIsAdmin(req)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    if (!heartbeatComplianceScheduler) {
      return res.status(500).json({ error: 'Heartbeat compliance scheduler not initialized' });
    }
    console.log('[API] Manual Day 5 squad health + family alerts triggered by admin');
    res.json({ success: true, message: 'Day 5 squad health report started in background' });
    heartbeatComplianceScheduler.runDay5().catch(err => {
      console.error('[API] Day 5 job error:', err);
    });
  } catch (err) {
    console.error('POST /api/admin/trigger-heartbeat-day5 error:', err.message);
    res.status(500).json({ error: 'Failed to trigger Day 5 job' });
  }
});

// was /api/admin/affiliate-tree
router.get('/affiliate-tree', requireAuth, async (req, res) => {
  let client;
  try {
    if (!(await requireAdminOrCreator(req, res))) return;
    if (!pool) return res.status(500).json({ success: false, users: [], error: 'Database unavailable' });
    client = await pool.connect();
    await client.query("SET statement_timeout = '5000'");

    // Get all users with affiliate info (including new tree placement fields)
    const usersResult = await client.query(`
      SELECT u.id, u.name, u.email, u.referred_by_user_id, u.plan, u.paid_until,
             u.is_creator, u.promo_code_used, u.created_at,
             a.id as affiliate_id, a.referral_code, a.status as affiliate_status,
             a.pending_balance_cents, a.approved_balance_cents, a.lifetime_earnings_cents,
             a.affiliate_level, a.parent_affiliate_id, a.placement_method,
             (u.email LIKE '%@test-affiliate.facts%') as is_test_user
      FROM users u
      LEFT JOIN affiliates a ON a.user_id = u.id
      ORDER BY u.created_at ASC
    `);

    // Get referral counts per user (how many direct referrals)
    const referralCounts = await client.query(`
      SELECT referred_by_user_id, COUNT(*) as referral_count
      FROM users
      WHERE referred_by_user_id IS NOT NULL
      GROUP BY referred_by_user_id
    `);

    const countMap = {};
    referralCounts.rows.forEach(r => {
      countMap[r.referred_by_user_id] = parseInt(r.referral_count);
    });

    // Build user list with referral counts
    const users = (usersResult.rows || []).map(u => ({
      id: u.id,
      name: u.name || (u.email ? String(u.email).split('@')[0] : 'User'),
      email: u.email || '',
      referred_by_user_id: u.referred_by_user_id,
      plan: u.plan,
      is_creator: u.is_creator,
      is_test_user: u.is_test_user,
      created_at: u.created_at,
      affiliate_id: u.affiliate_id,
      referral_code: u.referral_code,
      affiliate_status: u.affiliate_status,
      pending_balance_cents: u.pending_balance_cents || 0,
      approved_balance_cents: u.approved_balance_cents || 0,
      lifetime_earnings_cents: u.lifetime_earnings_cents || 0,
      direct_referrals: countMap[u.id] || 0,
      // Tree placement fields
      affiliate_level: u.affiliate_level || null,
      parent_affiliate_id: u.parent_affiliate_id || null,
      placement_method: u.placement_method || null
    }));

    res.json({ success: true, users });
  } catch (err) {
    console.error('GET /api/admin/affiliate-tree error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, users: [], error: 'Failed to load affiliate tree' });
    }
  } finally {
    if (client) {
      try { await client.query('RESET statement_timeout'); } catch (resetErr) { /* connection may already be dead */ }
      client.release();
    }
  }
});

// was /api/admin/affiliate-tree/place
router.post('/affiliate-tree/place', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;

    const { user_id, parent_user_id } = req.body;
    if (!user_id || !parent_user_id) {
      return res.status(400).json({ error: 'user_id and parent_user_id required' });
    }
    if (user_id === parent_user_id) {
      return res.status(400).json({ error: 'Cannot place user under themselves' });
    }

    // Circular reference check: walk up from parent to make sure we don't hit user_id
    let currentId = parent_user_id;
    const visited = new Set();
    while (currentId) {
      if (currentId === user_id) {
        return res.status(400).json({ error: 'Circular reference detected — parent is already a descendant of this user' });
      }
      if (visited.has(currentId)) break; // safety net
      visited.add(currentId);
      const parentResult = await pool.query('SELECT referred_by_user_id FROM users WHERE id = $1', [currentId]);
      if (parentResult.rows.length === 0) break;
      currentId = parentResult.rows[0].referred_by_user_id;
    }

    // Check if user currently has referrals underneath (subtree will move with them)
    const subtreeCheck = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE referred_by_user_id = $1', [user_id]
    );
    const subtreeCount = parseInt(subtreeCheck.rows[0].count);

    // Perform placement: update commission tree pointer
    await pool.query(
      'UPDATE users SET referred_by_user_id = $1, updated_at = NOW() WHERE id = $2',
      [parent_user_id, user_id]
    );

    // Step 1: Ensure the parent is an affiliate (auto-create if not)
    const parentUserData = await pool.query('SELECT email FROM users WHERE id = $1', [parent_user_id]);
    const parentAffExist = await pool.query('SELECT id FROM affiliates WHERE user_id = $1', [parent_user_id]);
    if (parentAffExist.rows.length === 0 && parentUserData.rows.length > 0) {
      const code = generateReferralCode(parentUserData.rows[0].email);
      await pool.query(
        `INSERT INTO affiliates (user_id, email, referral_code, status, affiliate_level, placement_method)
         VALUES ($1, $2, $3, 'active', 1, 'seed')
         ON CONFLICT DO NOTHING`,
        [parent_user_id, parentUserData.rows[0].email.toLowerCase(), code]
      );
    }

    // Step 2: Query affiliate records (after auto-create so they definitely exist)
    const parentAffData = await pool.query(
      'SELECT id, affiliate_level, referral_code FROM affiliates WHERE user_id = $1', [parent_user_id]
    );
    const userAffData = await pool.query('SELECT id FROM affiliates WHERE user_id = $1', [user_id]);

    // Step 3: Update affiliates.parent_affiliate_id + affiliate_level
    if (parentAffData.rows.length > 0 && userAffData.rows.length > 0) {
      const newLevel = Math.min((parentAffData.rows[0].affiliate_level || 1) + 1, 5);
      await pool.query(
        `UPDATE affiliates SET parent_affiliate_id = $1, affiliate_level = $2,
                               placement_method = 'code', updated_at = NOW()
         WHERE id = $3`,
        [parentAffData.rows[0].id, newLevel, userAffData.rows[0].id]
      );
    }

    // Step 4: Create a referral record if one doesn't exist
    const childUserData = await pool.query('SELECT email FROM users WHERE id = $1', [user_id]);
    const existingReferral = await pool.query(
      `SELECT r.id FROM referrals r
       JOIN affiliates a ON a.id = r.affiliate_id
       WHERE a.user_id = $1 AND r.referred_email = LOWER($2)`,
      [parent_user_id, childUserData.rows[0]?.email || '']
    );
    if (existingReferral.rows.length === 0 && parentAffData.rows.length > 0 && childUserData.rows.length > 0) {
      await pool.query(
        `INSERT INTO referrals (affiliate_id, referred_email, referral_code, status)
         VALUES ($1, $2, $3, 'converted')
         ON CONFLICT DO NOTHING`,
        [parentAffData.rows[0].id, childUserData.rows[0].email.toLowerCase(), parentAffData.rows[0].referral_code]
      );
    }

    res.json({
      success: true,
      message: `User placed under parent. ${subtreeCount > 0 ? `${subtreeCount} descendant(s) moved with them.` : ''}`,
      subtree_moved: subtreeCount
    });
  } catch (err) {
    console.error('POST /api/admin/affiliate-tree/place error:', err.message);
    res.status(500).json({ error: 'Failed to place user in tree' });
  }
});

// was /api/admin/affiliate-tree/create-test-user
router.post('/affiliate-tree/create-test-user', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;

    const { name, email } = req.body;
    if (!name || !email) {
      return res.status(400).json({ error: 'name and email required' });
    }

    // Check if email already exists
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    // Create test user with a hashed password
    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash('TestUser123!', 10);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, plan, created_at, updated_at)
       VALUES ($1, $2, $3, 'free', NOW(), NOW()) RETURNING id, name, email, plan, created_at`,
      [name, email.toLowerCase(), hashedPassword]
    );

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/affiliate-tree/create-test-user error:', err.message);
    res.status(500).json({ error: 'Failed to create test user' });
  }
});

// was /api/admin/affiliate-tree/simulate-payment
router.post('/affiliate-tree/simulate-payment', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;

    const { user_id, amount_cents, is_renewal } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const paymentAmount = amount_cents || 1499; // Default $14.99 (Individual Pro)

    // Get user
    const userResult = await pool.query('SELECT id, email, referred_by_user_id FROM users WHERE id = $1', [user_id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = userResult.rows[0];

    if (!user.referred_by_user_id) {
      return res.status(400).json({ error: 'User has no referrer — place them in the tree first' });
    }

    // Make user Pro (simulate subscription)
    await pool.query(
      `UPDATE users SET plan = 'paid', paid_until = NOW() + INTERVAL '30 days', updated_at = NOW() WHERE id = $1`,
      [user_id]
    );

    // Create a simulated subscription record
    const subResult = await pool.query(
      `INSERT INTO subscriptions (user_id, email, stripe_session_id, plan, amount_cents, status, started_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'monthly', $4, 'completed', NOW(), NOW(), NOW()) RETURNING id`,
      [user_id, user.email, `sim_ses_${user_id}_${Date.now()}`, paymentAmount]
    );
    const subscriptionId = subResult.rows[0].id;

    // Ensure referral record exists for commission processing
    const parentAff = await pool.query('SELECT id, referral_code FROM affiliates WHERE user_id = $1', [user.referred_by_user_id]);
    if (parentAff.rows.length > 0) {
      const existRef = await pool.query(
        'SELECT id FROM referrals WHERE affiliate_id = $1 AND referred_email = LOWER($2)',
        [parentAff.rows[0].id, user.email]
      );
      if (existRef.rows.length === 0) {
        await pool.query(
          `INSERT INTO referrals (affiliate_id, referred_email, subscription_id, referral_code, status, converted_at)
           VALUES ($1, $2, $3, $4, 'converted', NOW())`,
          [parentAff.rows[0].id, user.email.toLowerCase(), subscriptionId, parentAff.rows[0].referral_code]
        );
      } else {
        // Update existing referral with subscription id if missing
        await pool.query(
          `UPDATE referrals SET subscription_id = $1, status = 'converted', converted_at = COALESCE(converted_at, NOW()), updated_at = NOW()
           WHERE id = $2 AND (subscription_id IS NULL)`,
          [subscriptionId, existRef.rows[0].id]
        );
      }
    }

    // Process commissions through the tree
    await processCommission(subscriptionId, !!is_renewal);

    // Get commission breakdown for this payment
    const commissions = await pool.query(`
      SELECT c.level, c.type, c.amount_cents, c.percentage, c.status,
             a.email as affiliate_email, u.name as affiliate_name
      FROM commissions c
      JOIN affiliates a ON a.id = c.affiliate_id
      JOIN users u ON u.id = a.user_id
      WHERE c.subscription_id = $1
      ORDER BY c.level ASC
    `, [subscriptionId]);

    res.json({
      success: true,
      message: `Simulated ${is_renewal ? 'renewal' : 'initial'} payment of $${(paymentAmount / 100).toFixed(2)} for ${user.email}`,
      subscription_id: subscriptionId,
      commission_chain: commissions.rows.map(c => ({
        level: c.level,
        affiliate: c.affiliate_name || c.affiliate_email,
        email: c.affiliate_email,
        type: c.type,
        amount: `$${(c.amount_cents / 100).toFixed(2)}`,
        percentage: `${c.percentage}%`,
        status: c.status
      }))
    });
  } catch (err) {
    console.error('POST /api/admin/affiliate-tree/simulate-payment error:', err.message);
    res.status(500).json({ error: 'Failed to simulate payment' });
  }
});

// was /api/admin/affiliate-tree/commissions
router.get('/affiliate-tree/commissions', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;

    const { user_id } = req.query;

    let whereClause = '';
    let params = [];

    if (user_id) {
      whereClause = 'WHERE c.source_user_id = $1 OR a.user_id = $1';
      params = [parseInt(user_id)];
    }

    const commissions = await pool.query(`
      SELECT c.id, c.level, c.type, c.amount_cents, c.percentage, c.status, c.earned_at,
             a.email as affiliate_email, a.user_id as affiliate_user_id,
             u.name as affiliate_name,
             su.email as source_email, su.name as source_name
      FROM commissions c
      JOIN affiliates a ON a.id = c.affiliate_id
      JOIN users u ON u.id = a.user_id
      LEFT JOIN users su ON su.id = c.source_user_id
      ${whereClause}
      ORDER BY c.earned_at DESC
      LIMIT 200
    `, params);

    // Summary stats
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total_commissions,
        SUM(amount_cents) FILTER (WHERE status = 'pending') as total_pending_cents,
        SUM(amount_cents) FILTER (WHERE status = 'approved') as total_approved_cents,
        SUM(amount_cents) FILTER (WHERE status = 'paid') as total_paid_cents,
        SUM(amount_cents) as total_all_cents
      FROM commissions
    `);

    res.json({
      success: true,
      commissions: commissions.rows,
      stats: stats.rows[0]
    });
  } catch (err) {
    console.error('GET /api/admin/affiliate-tree/commissions error:', err.message);
    res.status(500).json({ error: 'Failed to load commissions' });
  }
});

// was /api/admin/affiliate-tree/reset-test-data
router.delete('/affiliate-tree/reset-test-data', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Find test users (email pattern: *@test-affiliate.facts)
      const testUsers = await client.query(
        `SELECT id, email FROM users WHERE email LIKE '%@test-affiliate.facts'`
      );

      if (testUsers.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.json({ success: true, message: 'No test data to clean up', removed: 0 });
      }

      const testUserIds = testUsers.rows.map(u => u.id);
      const testEmails = testUsers.rows.map(u => u.email.toLowerCase());

      // Remove commissions tied to test users (as source or affiliate)
      await client.query(
        `DELETE FROM commissions WHERE source_user_id = ANY($1)
         OR affiliate_id IN (SELECT id FROM affiliates WHERE user_id = ANY($1))`,
        [testUserIds]
      );

      // Remove referrals
      await client.query(
        `DELETE FROM referrals WHERE affiliate_id IN (SELECT id FROM affiliates WHERE user_id = ANY($1))
         OR referred_email = ANY($2)`,
        [testUserIds, testEmails]
      );

      // Remove payouts
      await client.query(
        `DELETE FROM payouts WHERE affiliate_id IN (SELECT id FROM affiliates WHERE user_id = ANY($1))`,
        [testUserIds]
      );

      // Remove affiliates
      await client.query(
        `DELETE FROM affiliates WHERE user_id = ANY($1)`,
        [testUserIds]
      );

      // Remove simulated subscriptions
      await client.query(
        `DELETE FROM subscriptions WHERE stripe_customer_id LIKE 'sim_cus_%' AND email = ANY($1)`,
        [testEmails]
      );

      // Clear referred_by pointers TO test users
      await client.query(
        `UPDATE users SET referred_by_user_id = NULL WHERE referred_by_user_id = ANY($1)`,
        [testUserIds]
      );

      // Remove test users
      await client.query(
        `DELETE FROM users WHERE id = ANY($1)`,
        [testUserIds]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: `Removed ${testUsers.rows.length} test user(s) and all associated data`,
        removed: testUsers.rows.length,
        emails: testEmails
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('DELETE /api/admin/affiliate-tree/reset-test-data error:', err.message);
    res.status(500).json({ error: 'Failed to reset test data' });
  }
});

// was /api/admin/affiliate-tree/detach
router.post('/affiliate-tree/detach', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;

    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    await pool.query(
      'UPDATE users SET referred_by_user_id = NULL, updated_at = NOW() WHERE id = $1',
      [user_id]
    );

    res.json({ success: true, message: 'User detached from tree' });
  } catch (err) {
    console.error('POST /api/admin/affiliate-tree/detach error:', err.message);
    res.status(500).json({ error: 'Failed to detach user' });
  }
});

// was /api/admin/education/content
router.get('/education/content', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Creator access required' });

    const result = await pool.query(`
      SELECT id, category, title, description, content_type, body, embed_url, external_url, sort_order, is_published, created_at, updated_at
      FROM education_content
      ORDER BY category ASC, sort_order ASC, id ASC
    `);
    res.json({ success: true, items: result.rows });
  } catch (err) {
    console.error('GET /api/admin/education/content error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load content' });
  }
});

// was /api/admin/education/content
router.post('/education/content', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Creator access required' });

    const { category, title, description, content_type, body, embed_url, external_url, sort_order, is_published } = req.body;

    if (!category || !title || !content_type) {
      return res.status(400).json({ error: 'category, title, and content_type are required' });
    }
    if (!['article', 'video', 'link'].includes(content_type)) {
      return res.status(400).json({ error: 'content_type must be article, video, or link' });
    }

    const result = await pool.query(
      `INSERT INTO education_content (category, title, description, content_type, body, embed_url, external_url, sort_order, is_published)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        category.trim(),
        title.trim(),
        description ? description.trim() : null,
        content_type,
        body ? body.trim() : null,
        embed_url ? embed_url.trim() : null,
        external_url ? external_url.trim() : null,
        sort_order !== undefined ? parseInt(sort_order) : 0,
        is_published !== false
      ]
    );
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/education/content error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to create content' });
  }
});

// was /api/admin/education/content/:id
router.put('/education/content/:id', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Creator access required' });

    const { id } = req.params;
    const { category, title, description, content_type, body, embed_url, external_url, sort_order, is_published } = req.body;

    if (!category || !title || !content_type) {
      return res.status(400).json({ error: 'category, title, and content_type are required' });
    }
    if (!['article', 'video', 'link'].includes(content_type)) {
      return res.status(400).json({ error: 'content_type must be article, video, or link' });
    }

    const result = await pool.query(
      `UPDATE education_content
       SET category=$1, title=$2, description=$3, content_type=$4, body=$5, embed_url=$6, external_url=$7, sort_order=$8, is_published=$9, updated_at=NOW()
       WHERE id=$10
       RETURNING *`,
      [
        category.trim(),
        title.trim(),
        description ? description.trim() : null,
        content_type,
        body ? body.trim() : null,
        embed_url ? embed_url.trim() : null,
        external_url ? external_url.trim() : null,
        sort_order !== undefined ? parseInt(sort_order) : 0,
        is_published !== false,
        parseInt(id)
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Content item not found' });
    }
    res.json({ success: true, item: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/admin/education/content/:id error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update content' });
  }
});

// was /api/admin/education/content/:id
router.delete('/education/content/:id', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Creator access required' });

    const { id } = req.params;
    await pool.query('DELETE FROM education_content WHERE id = $1', [parseInt(id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/education/content/:id error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to delete content' });
  }
});

// was /api/admin/shop/links
router.get('/shop/links', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Creator access required' });
    const result = await pool.query(`
      SELECT id, category_key, category_name, icon, description, url, button_text, is_active, sort_order, updated_at
      FROM shop_links
      ORDER BY sort_order ASC, id ASC
    `);
    res.json({ success: true, links: result.rows });
  } catch (err) {
    console.error('GET /api/admin/shop/links error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load shop links' });
  }
});

// was /api/admin/shop/links/:id
router.put('/shop/links/:id', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Creator access required' });

    const { id } = req.params;
    const { category_name, icon, description, url, button_text, is_active, sort_order } = req.body;

    const result = await pool.query(
      `UPDATE shop_links
       SET category_name = COALESCE($1, category_name),
           icon = COALESCE($2, icon),
           description = COALESCE($3, description),
           url = COALESCE($4, url),
           button_text = COALESCE($5, button_text),
           is_active = COALESCE($6, is_active),
           sort_order = COALESCE($7, sort_order),
           updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        category_name ? category_name.trim() : null,
        icon ? icon.trim() : null,
        description !== undefined ? description.trim() : null,
        url ? url.trim() : null,
        button_text ? button_text.trim() : null,
        is_active !== undefined ? is_active : null,
        sort_order !== undefined ? parseInt(sort_order) : null,
        parseInt(id)
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shop link not found' });
    }
    res.json({ success: true, link: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/admin/shop/links/:id error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update shop link' });
  }
});

// was /api/admin/shop/links
router.post('/shop/links', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Creator access required' });

    const { category_key, category_name, icon, description, url, button_text, sort_order } = req.body;
    if (!category_key || !category_name) {
      return res.status(400).json({ error: 'category_key and category_name are required' });
    }

    const result = await pool.query(
      `INSERT INTO shop_links (category_key, category_name, icon, description, url, button_text, is_active, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)
       RETURNING *`,
      [
        category_key.trim(),
        category_name.trim(),
        (icon || '🔗').trim(),
        (description || '').trim(),
        (url || '#').trim(),
        (button_text || 'Compare & Save').trim(),
        sort_order !== undefined ? parseInt(sort_order) : 99
      ]
    );
    res.json({ success: true, link: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A category with this key already exists' });
    }
    console.error('POST /api/admin/shop/links error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to create shop link' });
  }
});

// was /api/admin/shop/links/:id
router.delete('/shop/links/:id', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Creator access required' });
    await pool.query('DELETE FROM shop_links WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/shop/links/:id error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to delete shop link' });
  }
});

// was /api/admin/nda-status
router.get('/nda-status', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;

    const result = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.name,
        u.created_at as signup_date,
        u.referral_code,
        u.promo_code_used,
        u.is_creator,
        u.referred_by_user_id,
        na.accepted_at as nda_accepted_at,
        na.nda_version,
        CASE WHEN na.id IS NOT NULL THEN true ELSE false END as nda_accepted,
        (SELECT COUNT(*) FROM users r WHERE r.referred_by_user_id = u.id) as referral_count
      FROM users u
      LEFT JOIN nda_acceptances na ON na.user_id = u.id AND na.nda_version = $1
      ORDER BY u.created_at DESC
    `, [NDA_VERSION]);

    const stats = {
      total_users: result.rows.length,
      nda_accepted: result.rows.filter(u => u.nda_accepted).length,
      nda_pending: result.rows.filter(u => !u.nda_accepted && !u.is_creator).length,
      creator_exempt: result.rows.filter(u => u.is_creator).length,
      total_referrals: result.rows.reduce((sum, u) => sum + parseInt(u.referral_count), 0)
    };

    res.json({ success: true, stats, users: result.rows });
  } catch (err) {
    console.error('GET /api/admin/nda-status error:', err.message);
    res.status(500).json({ error: 'Failed to get NDA status' });
  }
});

// was /api/admin/users/search
router.get('/users/search', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) {
      return res.json({ success: true, users: [] });
    }
    const pattern = `%${q.toLowerCase()}%`;
    const result = await pool.query(`
      SELECT
        u.id,
        u.email,
        u.name,
        u.created_at,
        u.subscription_status,
        u.plan,
        u.is_creator,
        u.referred_by_user_id,
        (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id) AS transaction_count,
        (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'completed') AS active_subscriptions,
        a.id AS affiliate_id,
        a.status AS affiliate_status,
        a.parent_affiliate_id
      FROM users u
      LEFT JOIN affiliates a ON a.user_id = u.id
      WHERE LOWER(u.email) LIKE $1 OR LOWER(COALESCE(u.name, '')) LIKE $1
      ORDER BY u.created_at DESC
      LIMIT 20
    `, [pattern]);
    res.json({ success: true, users: result.rows });
  } catch (err) {
    console.error('GET /api/admin/users/search error:', err.message);
    res.status(500).json({ success: false, error: 'Search failed' });
  }
});

// was /api/admin/users/:id/details
router.get('/users/:id/details', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });

    const [userRes, txRes, subRes, affiliateRes, childrenRes, affiliateChildrenRes, debtRes, portfolioRes] = await Promise.all([
      pool.query('SELECT id, email, name, created_at, subscription_status, plan, is_creator, referred_by_user_id, stripe_subscription_id, p2p_lending_visible, mastermind_access, summit_invite FROM users WHERE id = $1', [userId]),
      pool.query('SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1', [userId]),
      pool.query('SELECT id, plan, status, stripe_customer_id, started_at, expires_at FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 3', [userId]),
      pool.query('SELECT id, status, affiliate_level, parent_affiliate_id, pending_balance_cents, approved_balance_cents, lifetime_earnings_cents, priority_orphan FROM affiliates WHERE user_id = $1', [userId]),
      pool.query('SELECT COUNT(*) AS count FROM users WHERE referred_by_user_id = $1', [userId]),
      pool.query(`
        SELECT COUNT(*) AS count FROM affiliates a
        INNER JOIN affiliates p ON p.id = a.parent_affiliate_id
        WHERE p.user_id = $1
      `, [userId]),
      pool.query('SELECT COUNT(*) AS count FROM debts WHERE user_id = $1', [userId]),
      pool.query('SELECT COUNT(*) AS count FROM portfolio_accounts WHERE user_id = $1', [userId])
    ]);

    if (!userRes.rows.length) return res.status(404).json({ success: false, error: 'User not found' });

    const user = userRes.rows[0];
    // Fetch the parent user info if they have a referrer
    let referrer = null;
    if (user.referred_by_user_id) {
      const refRes = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [user.referred_by_user_id]);
      if (refRes.rows.length) referrer = refRes.rows[0];
    }

    res.json({
      success: true,
      user,
      referrer,
      transaction_count: parseInt(txRes.rows[0].count, 10),
      subscriptions: subRes.rows,
      affiliate: affiliateRes.rows[0] || null,
      direct_referral_children: parseInt(childrenRes.rows[0].count, 10),
      affiliate_tree_children: parseInt(affiliateChildrenRes.rows[0].count, 10),
      debt_count: parseInt(debtRes.rows[0].count, 10),
      portfolio_count: parseInt(portfolioRes.rows[0].count, 10)
    });
  } catch (err) {
    console.error('GET /api/admin/users/:id/details error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load user details' });
  }
});

// was /api/admin/users/:id
router.delete('/users/:id', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;
    const adminId = req.userId;
    const targetUserId = parseInt(req.params.id, 10);
    if (isNaN(targetUserId)) return res.status(400).json({ success: false, error: 'Invalid user ID' });

    // Load admin info for audit log
    const adminRes = await pool.query('SELECT id, email, is_creator FROM users WHERE id = $1', [adminId]);
    if (!adminRes.rows.length) return res.status(401).json({ success: false, error: 'Admin not found' });
    const admin = adminRes.rows[0];

    // Load target user
    const userRes = await pool.query(
      'SELECT id, email, name, created_at, subscription_status, is_creator, referred_by_user_id FROM users WHERE id = $1',
      [targetUserId]
    );
    if (!userRes.rows.length) return res.status(404).json({ success: false, error: 'User not found' });
    const target = userRes.rows[0];

    // Protect admin from self-deletion
    if (target.id === adminId) {
      return res.status(403).json({ success: false, error: 'Cannot delete your own admin account' });
    }

    // Protect creator account from deletion
    const creatorEmail = (process.env.CREATOR_EMAIL || '').toLowerCase().trim();
    if (target.is_creator || (creatorEmail && target.email.toLowerCase() === creatorEmail)) {
      return res.status(403).json({ success: false, error: 'Cannot delete the creator account' });
    }

    // Count transactions for audit log
    const txCountRes = await pool.query('SELECT COUNT(*) AS count FROM transactions WHERE user_id = $1', [targetUserId]);
    const txCount = parseInt(txCountRes.rows[0].count, 10);

    // ── Affiliate tree re-linking ──────────────────────────────────────────────
    // When we delete user X who sits in the tree:
    //   - X's parent = X.referred_by_user_id (upline)
    //   - X's children = users WHERE referred_by_user_id = X.id
    // Re-link: set children's referred_by_user_id to X's parent (grandparent)
    const parentUserId = target.referred_by_user_id; // may be null (root node)

    const childUsersRes = await pool.query(
      'SELECT id FROM users WHERE referred_by_user_id = $1',
      [targetUserId]
    );
    const childCount = childUsersRes.rows.length;

    // Re-link child users to grandparent
    if (childCount > 0) {
      await pool.query(
        'UPDATE users SET referred_by_user_id = $1 WHERE referred_by_user_id = $2',
        [parentUserId || null, targetUserId]
      );
    }

    // Also re-link affiliate tree nodes
    // Find this user's affiliate record
    const affiliateRes = await pool.query('SELECT id, parent_affiliate_id FROM affiliates WHERE user_id = $1', [targetUserId]);
    let affiliateChildrenCount = 0;
    if (affiliateRes.rows.length) {
      const aff = affiliateRes.rows[0];
      const parentAffiliateId = aff.parent_affiliate_id; // grandparent in affiliate tree

      // Re-link affiliate children to grandparent
      const affChildRes = await pool.query(
        'UPDATE affiliates SET parent_affiliate_id = $1 WHERE parent_affiliate_id = $2',
        [parentAffiliateId || null, aff.id]
      );
      affiliateChildrenCount = affChildRes.rowCount || 0;
    }

    const treeRelinked = (childCount + affiliateChildrenCount) > 0;
    const totalChildrenRelinked = childCount + affiliateChildrenCount;

    // ── Delete user (cascades all related data via FK constraints) ─────────────
    await pool.query('DELETE FROM users WHERE id = $1', [targetUserId]);

    // ── Write audit log ────────────────────────────────────────────────────────
    try {
      await pool.query(`
        INSERT INTO admin_deletion_log
          (deleted_user_id, deleted_email, deleted_name, admin_id, admin_email,
           user_created_at, transaction_count, subscription_status,
           affiliate_tree_relinked, children_relinked_count, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [
        target.id,
        target.email,
        target.name || null,
        adminId,
        admin.email,
        target.created_at,
        txCount,
        target.subscription_status || null,
        treeRelinked,
        totalChildrenRelinked,
        req.body.notes || null
      ]);
    } catch (logErr) {
      // Audit log failure is non-fatal — user is already deleted
      console.error('[Admin Delete] Audit log insert failed:', logErr.message);
    }

    console.log(`[Admin Delete] ${admin.email} deleted user ${target.email} (id=${target.id}), relinked ${totalChildrenRelinked} children`);

    res.json({
      success: true,
      message: `Account for ${target.email} permanently deleted`,
      relinked_children: totalChildrenRelinked,
      tree_relinked: treeRelinked
    });
  } catch (err) {
    console.error('DELETE /api/admin/users/:id error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to delete account: ' + err.message });
  }
});

// was /api/admin/deletion-log
router.get('/deletion-log', requireAuth, async (req, res) => {
  try {
    if (!(await requireCreator(req, res))) return;
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const result = await pool.query(`
      SELECT
        id,
        deleted_user_id,
        deleted_email,
        deleted_name,
        deleted_at,
        admin_email,
        user_created_at,
        transaction_count,
        subscription_status,
        affiliate_tree_relinked,
        children_relinked_count,
        notes
      FROM admin_deletion_log
      ORDER BY deleted_at DESC
      LIMIT $1
    `, [limit]);
    res.json({ success: true, log: result.rows });
  } catch (err) {
    console.error('GET /api/admin/deletion-log error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to load deletion log' });
  }
});

// was /api/admin/succession/plans
router.get('/succession/plans', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  try {
    const result = await pool.query(
      `SELECT a.id AS affiliate_id, a.referral_code, a.status AS affiliate_status,
              u.id AS user_id, u.email, u.name,
              a.successor_name, a.successor_email, a.successor_relationship,
              a.succession_authorized_date,
              su.email AS successor_user_email
         FROM affiliates a
         JOIN users u ON u.id = a.user_id
         LEFT JOIN users su ON su.id = a.successor_id
        WHERE a.successor_email IS NOT NULL
        ORDER BY a.succession_authorized_date DESC`
    );

    res.json({ success: true, plans: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('[Succession] GET /api/admin/succession/plans error:', err.message);
    res.status(500).json({ error: 'Failed to load succession plans' });
  }
});

// was /api/admin/succession/transfers
router.get('/succession/transfers', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  try {
    const { status } = req.query;
    const conditions = status ? `WHERE st.status = $1` : '';
    const params = status ? [status] : [];

    const result = await pool.query(
      `SELECT st.*,
              u_orig.email AS original_holder_email, u_orig.name AS original_holder_name,
              u_succ.email AS successor_user_email, u_succ.name AS successor_user_name,
              u_admin.email AS admin_email,
              a.referral_code
         FROM succession_transfers st
         JOIN affiliates a ON a.id = st.affiliate_id
         JOIN users u_orig ON u_orig.id = a.user_id
         LEFT JOIN users u_succ ON u_succ.id = st.successor_id
         LEFT JOIN users u_admin ON u_admin.id = st.admin_id
         ${conditions}
        ORDER BY st.created_at DESC`,
      params
    );

    res.json({ success: true, transfers: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('[Succession] GET /api/admin/succession/transfers error:', err.message);
    res.status(500).json({ error: 'Failed to load transfers' });
  }
});

// was /api/admin/succession/transfers/:id/execute
router.post('/succession/transfers/:id/execute', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  const client = await pool.connect();
  try {
    const adminUserId = req.userId;
    const transferId = parseInt(req.params.id);
    const { notes } = req.body;

    await client.query('BEGIN');

    // Load transfer
    const transferResult = await client.query(
      `SELECT st.*, a.user_id AS original_user_id, a.id AS affiliate_id
         FROM succession_transfers st
         JOIN affiliates a ON a.id = st.affiliate_id
        WHERE st.id = $1 FOR UPDATE`,
      [transferId]
    );

    if (!transferResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transfer not found' });
    }

    const transfer = transferResult.rows[0];

    if (transfer.status !== 'pending_admin_approval') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Cannot execute transfer with status: ${transfer.status}` });
    }

    if (!transfer.successor_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Successor must have an account before transfer can execute. Ask them to sign up first.' });
    }

    // Verify successor account exists
    const successorResult = await client.query(
      `SELECT id, email, plan FROM users WHERE id = $1`, [transfer.successor_id]
    );
    if (!successorResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Successor user account not found' });
    }

    const originalUserId = transfer.original_user_id;
    const newUserId = transfer.successor_id;
    const affiliateId = transfer.affiliate_id;

    // CRITICAL: Swap the user_id on the affiliate record (node_id stays same — all legs intact)
    await client.query(
      `UPDATE affiliates SET user_id = $1, updated_at = NOW() WHERE id = $2`,
      [newUserId, affiliateId]
    );

    // Original holder becomes Retail subscriber (downgrade to free, remove affiliate status)
    await client.query(
      `UPDATE users SET plan = 'free', subscription_status = 'cancelled',
          stripe_subscription_id = NULL, paid_until = NULL, updated_at = NOW()
       WHERE id = $1`,
      [originalUserId]
    );

    // Set probation deadlines for successor (30/60/90 days)
    const now = new Date();
    const proDeadline = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const certDeadline = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const deactivationDeadline = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    // Update transfer to executed
    await client.query(
      `UPDATE succession_transfers SET
        status = 'executed',
        admin_id = $1,
        admin_notes = $2,
        admin_actioned_at = NOW(),
        transfer_executed_date = NOW(),
        old_affiliate_user_id = $3,
        new_affiliate_user_id = $4,
        probation_started_at = NOW(),
        probation_pro_deadline = $5,
        probation_cert_deadline = $6,
        probation_deactivation_deadline = $7,
        probation_status = 'pending',
        updated_at = NOW()
       WHERE id = $8`,
      [adminUserId, notes || null, originalUserId, newUserId, proDeadline, certDeadline, deactivationDeadline, transferId]
    );

    // Update affiliate succession fields to reflect new holder
    await client.query(
      `UPDATE affiliates SET
        successor_name = NULL, successor_email = NULL, successor_relationship = NULL,
        succession_authorized_date = NULL, succession_signature_data = NULL, successor_id = NULL,
        updated_at = NOW()
       WHERE id = $1`,
      [affiliateId]
    );

    await client.query('COMMIT');

    console.log(`[Succession] Transfer #${transferId} executed by admin ${adminUserId}. Node ${affiliateId}: ${originalUserId} → ${newUserId}`);

    res.json({
      success: true,
      message: 'Transfer executed successfully. The successor now owns this affiliate position.',
      probation: {
        pro_deadline: proDeadline.toISOString(),
        cert_deadline: certDeadline.toISOString(),
        deactivation_deadline: deactivationDeadline.toISOString()
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Succession] POST /api/admin/succession/transfers/:id/execute error:', err.message);
    res.status(500).json({ error: 'Failed to execute transfer' });
  } finally {
    client.release();
  }
});

// was /api/admin/succession/transfers/:id/reject
router.post('/succession/transfers/:id/reject', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  try {
    const adminUserId = req.userId;
    const transferId = parseInt(req.params.id);
    const { notes } = req.body;

    const result = await pool.query(
      `UPDATE succession_transfers SET
        status = 'rejected',
        admin_id = $1,
        admin_notes = $2,
        admin_actioned_at = NOW(),
        updated_at = NOW()
       WHERE id = $3 AND status IN ('pending_successor_signature','pending_admin_approval')
       RETURNING id`,
      [adminUserId, notes || null, transferId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Transfer not found or already processed' });
    }

    res.json({ success: true, message: 'Transfer rejected.' });
  } catch (err) {
    console.error('[Succession] POST /api/admin/succession/transfers/:id/reject error:', err.message);
    res.status(500).json({ error: 'Failed to reject transfer' });
  }
});

// was /api/admin/succession/death-override
router.post('/succession/death-override', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  const client = await pool.connect();
  try {
    const adminUserId = req.userId;
    const { affiliate_id, successor_email, successor_name, successor_relationship, notes } = req.body;

    if (!affiliate_id || !successor_email || !successor_name) {
      return res.status(400).json({ error: 'affiliate_id, successor_email, and successor_name are required' });
    }

    await client.query('BEGIN');

    // Load affiliate
    const affResult = await client.query(
      `SELECT a.id, a.user_id, u.email AS holder_email, u.name AS holder_name
         FROM affiliates a
         JOIN users u ON u.id = a.user_id
        WHERE a.id = $1 FOR UPDATE`,
      [affiliate_id]
    );

    if (!affResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Affiliate not found' });
    }

    const aff = affResult.rows[0];

    // Find or require successor user account
    const successorResult = await client.query(
      `SELECT id, plan FROM users WHERE LOWER(email) = LOWER($1)`, [successor_email]
    );

    if (!successorResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: `No account found for ${successor_email}. Successor must create an account first.` });
    }

    const successorUserId = successorResult.rows[0].id;
    const originalUserId = aff.user_id;

    // Swap user_id on the affiliate node (all legs remain intact)
    await client.query(
      `UPDATE affiliates SET user_id = $1, updated_at = NOW() WHERE id = $2`,
      [successorUserId, affiliate_id]
    );

    // Downgrade original holder to Retail (free)
    await client.query(
      `UPDATE users SET plan = 'free', subscription_status = 'cancelled',
          stripe_subscription_id = NULL, paid_until = NULL, updated_at = NOW()
       WHERE id = $1`,
      [originalUserId]
    );

    // Create the succession transfer record for audit
    const now = new Date();
    const proDeadline = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const certDeadline = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const deactivationDeadline = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO succession_transfers (
        affiliate_id, transfer_type, status,
        successor_id, successor_email, successor_name, successor_relationship,
        transferor_signed_at, successor_signed_at,
        admin_id, admin_notes, admin_actioned_at,
        transfer_executed_date,
        old_affiliate_user_id, new_affiliate_user_id,
        probation_started_at, probation_pro_deadline, probation_cert_deadline,
        probation_deactivation_deadline, probation_status,
        created_at, updated_at
       ) VALUES (
        $1, 'death', 'executed',
        $2, $3, $4, $5,
        NOW(), NOW(),
        $6, $7, NOW(),
        NOW(),
        $8, $2,
        NOW(), $9, $10,
        $11, 'pending',
        NOW(), NOW()
       )`,
      [
        affiliate_id,
        successorUserId, successor_email, successor_name, successor_relationship || 'other',
        adminUserId, notes || 'Corporate override — death/incapacitation',
        originalUserId,
        proDeadline, certDeadline, deactivationDeadline
      ]
    );

    // Clear succession plan from affiliate record
    await client.query(
      `UPDATE affiliates SET
        successor_name = NULL, successor_email = NULL, successor_relationship = NULL,
        succession_authorized_date = NULL, succession_signature_data = NULL, successor_id = NULL,
        updated_at = NOW()
       WHERE id = $1`,
      [affiliate_id]
    );

    await client.query('COMMIT');

    console.log(`[Succession] Death override on affiliate ${affiliate_id} by admin ${adminUserId}. ${originalUserId} → ${successorUserId}`);

    res.json({
      success: true,
      message: `Death/incapacitation transfer executed. ${successor_name} (${successor_email}) now holds the affiliate position.`,
      probation: {
        pro_deadline: proDeadline.toISOString(),
        cert_deadline: certDeadline.toISOString(),
        deactivation_deadline: deactivationDeadline.toISOString()
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Succession] POST /api/admin/succession/death-override error:', err.message);
    res.status(500).json({ error: 'Failed to execute death override' });
  } finally {
    client.release();
  }
});

// was /api/admin/succession/probation
router.get('/succession/probation', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  try {
    const result = await pool.query(
      `SELECT st.*,
              u_succ.email AS successor_email_addr, u_succ.name AS successor_user_name,
              u_succ.plan AS successor_plan,
              u_succ.is_facts_certified AS successor_facts_certified,
              a.referral_code
         FROM succession_transfers st
         JOIN affiliates a ON a.id = st.affiliate_id
         LEFT JOIN users u_succ ON u_succ.id = st.new_affiliate_user_id
        WHERE st.status = 'executed'
          AND st.probation_status NOT IN ('compliant', 'deactivated')
        ORDER BY st.probation_deactivation_deadline ASC`
    );

    res.json({ success: true, probation_cases: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('[Succession] GET /api/admin/succession/probation error:', err.message);
    res.status(500).json({ error: 'Failed to load probation cases' });
  }
});

// was /api/admin/resources
router.post('/resources', requireAuth, resourceUpload.single('file'), async (req, res) => {
  try {
    const creator = await isCreator(req.userId);
    if (!creator) return res.status(403).json({ error: 'Creator access required' });

    const { title, description, category, resource_type, file_url, thumbnail_emoji, is_pro_only, sort_order } = req.body;

    if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!category || !category.trim()) return res.status(400).json({ error: 'Category is required' });

    let fileData = null;
    let fileName = null;
    let fileMime = null;
    let fileSize = 0;

    if (req.file) {
      fileData = req.file.buffer;
      fileName = req.file.originalname;
      fileMime = req.file.mimetype;
      fileSize = req.file.size;
    }

    const result = await pool.query(`
      INSERT INTO resource_center_items
        (title, description, category, resource_type, file_url, file_data, file_name,
         file_size_bytes, file_mime_type, thumbnail_emoji, is_pro_only, sort_order, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING id, title, description, category, resource_type, file_url, file_name,
                file_size_bytes, thumbnail_emoji, is_pro_only, is_active, sort_order, created_at
    `, [
      title.trim(),
      description || null,
      category.trim(),
      resource_type || 'pdf',
      file_url || null,
      fileData,
      fileName,
      fileSize,
      fileMime,
      thumbnail_emoji || '📄',
      is_pro_only === 'true' || is_pro_only === true,
      parseInt(sort_order) || 0,
      req.userId
    ]);

    res.json({ success: true, resource: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/resources error:', err.message);
    res.status(500).json({ error: 'Failed to create resource' });
  }
});

// was /api/admin/resources/:id
router.put('/resources/:id', requireAuth, resourceUpload.single('file'), async (req, res) => {
  try {
    const creator = await isCreator(req.userId);
    if (!creator) return res.status(403).json({ error: 'Creator access required' });

    const { title, description, category, resource_type, file_url, thumbnail_emoji, is_pro_only, is_active, sort_order } = req.body;

    const existing = await pool.query('SELECT * FROM resource_center_items WHERE id = $1', [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Resource not found' });

    let fileData = existing.rows[0].file_data;
    let fileName = existing.rows[0].file_name;
    let fileMime = existing.rows[0].file_mime_type;
    let fileSize = existing.rows[0].file_size_bytes;

    if (req.file) {
      fileData = req.file.buffer;
      fileName = req.file.originalname;
      fileMime = req.file.mimetype;
      fileSize = req.file.size;
    }

    const result = await pool.query(`
      UPDATE resource_center_items SET
        title = COALESCE($1, title),
        description = $2,
        category = COALESCE($3, category),
        resource_type = COALESCE($4, resource_type),
        file_url = $5,
        file_data = $6,
        file_name = $7,
        file_size_bytes = $8,
        file_mime_type = $9,
        thumbnail_emoji = COALESCE($10, thumbnail_emoji),
        is_pro_only = $11,
        is_active = $12,
        sort_order = COALESCE($13, sort_order),
        updated_at = NOW()
      WHERE id = $14
      RETURNING id, title, description, category, resource_type, file_url, file_name,
                file_size_bytes, thumbnail_emoji, is_pro_only, is_active, sort_order, updated_at
    `, [
      title ? title.trim() : null,
      description !== undefined ? description : existing.rows[0].description,
      category ? category.trim() : null,
      resource_type || null,
      file_url !== undefined ? (file_url || null) : existing.rows[0].file_url,
      fileData,
      fileName,
      fileSize,
      fileMime,
      thumbnail_emoji || null,
      is_pro_only !== undefined ? (is_pro_only === 'true' || is_pro_only === true) : existing.rows[0].is_pro_only,
      is_active !== undefined ? (is_active === 'true' || is_active === true) : existing.rows[0].is_active,
      sort_order !== undefined ? parseInt(sort_order) : null,
      req.params.id
    ]);

    res.json({ success: true, resource: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/admin/resources/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update resource' });
  }
});

// was /api/admin/resources/:id
router.delete('/resources/:id', requireAuth, async (req, res) => {
  try {
    const creator = await isCreator(req.userId);
    if (!creator) return res.status(403).json({ error: 'Creator access required' });

    const result = await pool.query(
      'DELETE FROM resource_center_items WHERE id = $1 RETURNING id, title',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Resource not found' });

    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /api/admin/resources/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete resource' });
  }
});

// was /api/admin/resources
router.get('/resources', requireAuth, async (req, res) => {
  try {
    const creator = await isCreator(req.userId);
    if (!creator) return res.status(403).json({ error: 'Creator access required' });

    const result = await pool.query(`
      SELECT r.id, r.title, r.description, r.category, r.resource_type, r.file_url,
             r.file_name, r.file_size_bytes, r.thumbnail_emoji, r.is_pro_only,
             r.is_active, r.sort_order, r.download_count, r.created_at,
             CASE WHEN r.file_data IS NOT NULL THEN true ELSE false END as has_file_upload
      FROM resource_center_items r
      ORDER BY r.sort_order ASC, r.created_at DESC
    `);

    res.json({ success: true, resources: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('GET /api/admin/resources error:', err.message);
    res.status(500).json({ error: 'Failed to load resources' });
  }
});

// was /api/admin/feed/posts
router.get('/feed/posts', requireAuth, async (req, res) => {
  try {
    const creator = await isCreator(req.userId);
    if (!creator) return res.status(403).json({ error: 'Creator access required' });

    const result = await pool.query(`
      SELECT id, type, title, content, source_url, author, pinned, is_active,
             scheduled_at, category, like_count, comment_count, bookmark_count, created_at
      FROM feed_posts
      ORDER BY pinned DESC, created_at DESC
    `);
    res.json({ success: true, posts: result.rows });
  } catch (err) {
    console.error('GET /api/admin/feed/posts error:', err.message);
    res.status(500).json({ error: 'Failed to load posts' });
  }
});

// was /api/admin/feed/posts
router.post('/feed/posts', requireAuth, async (req, res) => {
  try {
    const creator = await isCreator(req.userId);
    if (!creator) return res.status(403).json({ error: 'Creator access required' });

    const { type, title, content, source_url, author, pinned, scheduled_at, category, is_active } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });
    if (!['quote','news','story','tip','digest'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

    const result = await pool.query(`
      INSERT INTO feed_posts (type, title, content, source_url, author, pinned, scheduled_at, category, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [type, title || null, content.trim(), source_url || null, author || null,
        pinned === true || pinned === 'true', scheduled_at || null, category || null,
        is_active !== false && is_active !== 'false']);

    res.json({ success: true, post: result.rows[0] });
  } catch (err) {
    console.error('POST /api/admin/feed/posts error:', err.message);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

// was /api/admin/feed/posts/:id
router.put('/feed/posts/:id', requireAuth, async (req, res) => {
  try {
    const creator = await isCreator(req.userId);
    if (!creator) return res.status(403).json({ error: 'Creator access required' });

    const { type, title, content, source_url, author, pinned, scheduled_at, category, is_active } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });

    const result = await pool.query(`
      UPDATE feed_posts
      SET type=$1, title=$2, content=$3, source_url=$4, author=$5, pinned=$6,
          scheduled_at=$7, category=$8, is_active=$9, updated_at=NOW()
      WHERE id=$10
      RETURNING *
    `, [type, title || null, content.trim(), source_url || null, author || null,
        pinned === true || pinned === 'true', scheduled_at || null, category || null,
        is_active !== false && is_active !== 'false', req.params.id]);

    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json({ success: true, post: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/admin/feed/posts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

// was /api/admin/feed/posts/:id/toggle
router.patch('/feed/posts/:id/toggle', requireAuth, async (req, res) => {
  try {
    const creator = await isCreator(req.userId);
    if (!creator) return res.status(403).json({ error: 'Creator access required' });

    const result = await pool.query(
      'UPDATE feed_posts SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 RETURNING id, is_active',
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json({ success: true, is_active: result.rows[0].is_active });
  } catch (err) {
    console.error('PATCH /api/admin/feed/posts/:id/toggle error:', err.message);
    res.status(500).json({ error: 'Failed to toggle post' });
  }
});

// was /api/admin/feed/posts/:id
router.delete('/feed/posts/:id', requireAuth, async (req, res) => {
  try {
    const creator = await isCreator(req.userId);
    if (!creator) return res.status(403).json({ error: 'Creator access required' });

    const result = await pool.query('DELETE FROM feed_posts WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Post not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/admin/feed/posts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

// was /api/admin/sovereign/flags/:userId
router.post('/sovereign/flags/:userId', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  const targetId = parseInt(req.params.userId);
  const { p2p_lending_visible, mastermind_access, summit_invite, priority_orphan } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update user sovereign flags
    await client.query(
      `UPDATE users SET
         p2p_lending_visible = COALESCE($2, p2p_lending_visible),
         mastermind_access   = COALESCE($3, mastermind_access),
         summit_invite       = COALESCE($4, summit_invite)
       WHERE id = $1`,
      [targetId,
       p2p_lending_visible != null ? !!p2p_lending_visible : null,
       mastermind_access   != null ? !!mastermind_access   : null,
       summit_invite       != null ? !!summit_invite       : null]
    );

    // Optionally update affiliate priority_orphan flag
    if (priority_orphan != null) {
      await client.query(
        `UPDATE affiliates SET priority_orphan = $2 WHERE user_id = $1`,
        [targetId, !!priority_orphan]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Sovereign flags updated' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Sovereign] POST /api/admin/sovereign/flags error:', err.message);
    res.status(500).json({ error: 'Failed to update sovereign flags' });
  } finally {
    client.release();
  }
});

// was /api/admin/succession/activate-heir/:designationId
router.post('/succession/activate-heir/:designationId', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  const designationId = parseInt(req.params.designationId);
  const { notes } = req.body;
  const adminId = req.userId;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load designation
    const dResult = await client.query(
      `SELECT hd.*, u.email AS owner_email, u.name AS owner_name,
              hu.email AS heir_email, hu.name AS heir_name,
              hu.plan AS heir_plan, hu.pricing_tier AS heir_pricing_tier
         FROM heir_designation hd
         JOIN users u  ON u.id  = hd.user_id
         JOIN users hu ON hu.id = hd.heir_user_id
        WHERE hd.id = $1 FOR UPDATE`,
      [designationId]
    );

    if (!dResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Designation not found' });
    }

    const d = dResult.rows[0];
    if (d.activation_status === 'activated') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Succession already activated' });
    }
    if (d.activation_status === 'revoked') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Designation has been revoked and cannot be activated' });
    }

    // Check heir subscription
    const heirHasPro = d.heir_plan === 'paid' ||
      ['tfr_pro','individual_pro','business_core','business_bundle','tfr_elite','sovereign_executive'].includes(d.heir_pricing_tier);

    if (!heirHasPro) {
      // Log it but don't hard-block — admin can override
      console.warn(`[Succession] Heir ${d.heir_email} does not have active Pro. Admin activating anyway with note.`);
    }

    // Activate the designation
    await client.query(
      `UPDATE heir_designation
         SET activation_status = 'activated',
             activated_at = NOW(),
             activated_by = $2,
             heir_subscription_active = $3,
             heir_subscription_last_checked = NOW(),
             updated_at = NOW()
       WHERE id = $1`,
      [designationId, adminId, heirHasPro]
    );

    // Transfer affiliate node ownership (if applicable)
    // Look up the original holder's affiliate record
    const affResult = await client.query(
      `SELECT id, user_id, affiliate_level, referral_code, status
         FROM affiliates WHERE user_id = $1 AND status = 'active'`,
      [d.user_id]
    );

    let affiliateTransferred = false;
    if (affResult.rows.length) {
      const aff = affResult.rows[0];
      // Transfer the affiliate node to the heir
      await client.query(
        `UPDATE affiliates SET user_id = $2, updated_at = NOW() WHERE id = $1`,
        [aff.id, d.heir_user_id]
      );
      affiliateTransferred = true;
    }

    // Transfer sovereign flags to heir
    await client.query(
      `UPDATE users AS heir
         SET pricing_tier = orig.pricing_tier,
             p2p_lending_visible = orig.p2p_lending_visible,
             mastermind_access   = orig.mastermind_access,
             summit_invite       = orig.summit_invite
         FROM users orig
        WHERE orig.id = $1 AND heir.id = $2`,
      [d.user_id, d.heir_user_id]
    );

    // Log the activation
    await client.query(
      `INSERT INTO succession_activation_log
         (designation_id, original_user_id, heir_user_id, action, admin_id, notes, metadata)
       VALUES ($1, $2, $3, 'succession_activated', $4, $5, $6)`,
      [designationId, d.user_id, d.heir_user_id, adminId,
       notes || `Succession activated by admin. Heir: ${d.heir_email}`,
       JSON.stringify({
         original_email: d.owner_email,
         heir_email: d.heir_email,
         affiliate_transferred: affiliateTransferred,
         heir_had_pro: heirHasPro
       })]
    );

    // Pause commission if heir has no Pro
    if (!heirHasPro) {
      await client.query(
        `UPDATE heir_designation SET commission_paused = TRUE, commission_paused_at = NOW() WHERE id = $1`,
        [designationId]
      );
      await client.query(
        `INSERT INTO succession_activation_log
           (designation_id, original_user_id, heir_user_id, action, admin_id, notes)
         VALUES ($1, $2, $3, 'commission_paused', $4, 'Heir lacks active Pro subscription at activation time')`,
        [designationId, d.user_id, d.heir_user_id, adminId]
      );
    }

    await client.query('COMMIT');

    res.json({
      success: true,
      message: `Succession activated. ${affiliateTransferred ? 'Affiliate node transferred.' : 'No active affiliate node found.'} ${heirHasPro ? 'Commission engine active.' : '⚠️ Commission engine PAUSED — heir must activate Pro subscription.'}`,
      designation_id: designationId,
      affiliate_transferred: affiliateTransferred,
      commission_paused: !heirHasPro
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Succession] POST activate-heir error:', err.message);
    res.status(500).json({ error: 'Failed to activate succession' });
  } finally {
    client.release();
  }
});

// was /api/admin/succession/heir-designations
router.get('/succession/heir-designations', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  try {
    const { status } = req.query;
    const cond = status ? `WHERE hd.activation_status = $1` : '';
    const params = status ? [status] : [];

    const result = await pool.query(
      `SELECT hd.*,
              u.email  AS owner_email,  u.name  AS owner_name,
              hu.email AS heir_email,   hu.name AS heir_name,
              hu.plan  AS heir_plan, hu.pricing_tier AS heir_pricing_tier,
              au.email AS activated_by_email
         FROM heir_designation hd
         JOIN users u  ON u.id  = hd.user_id
         JOIN users hu ON hu.id = hd.heir_user_id
         LEFT JOIN users au ON au.id = hd.activated_by
         ${cond}
        ORDER BY hd.created_at DESC`,
      params
    );

    res.json({ success: true, designations: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('[Succession] GET admin heir-designations error:', err.message);
    res.status(500).json({ error: 'Failed to load designations' });
  }
});

// was /api/admin/waitlist
router.get('/waitlist', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    if (!decoded.is_creator) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const { feature_name } = req.query;
    let sql = `
      SELECT fw.feature_name, fw.email, fw.user_id, fw.created_at,
             u.name as user_name
      FROM feature_waitlist fw
      LEFT JOIN users u ON fw.user_id = u.id
    `;
    const params = [];
    if (feature_name) {
      sql += ' WHERE fw.feature_name = $1';
      params.push(feature_name);
    }
    sql += ' ORDER BY fw.created_at DESC';

    const result = await pool.query(sql, params);
    res.json({ success: true, entries: result.rows });
  } catch (err) {
    console.error('[Admin Waitlist] error:', err.message);
    res.status(500).json({ success: false, message: 'Could not fetch waitlist.' });
  }
});

// was /api/admin/launch-waitlist
router.get('/launch-waitlist', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  try {
    await ensureLaunchWaitlistNameColumn();
    const result = await pool.query(
      `SELECT id, email, name, ref_code, sovereign_score, monthly_income, liquid_reserves,
              fixed_expenses, total_debt, source, created_at
       FROM launch_waitlist
       ORDER BY created_at DESC`
    );
    res.json({ success: true, entries: result.rows, total: result.rowCount });
  } catch (err) {
    console.error('[Admin] GET /api/admin/launch-waitlist error:', err.message);
    res.status(500).json({ error: 'Failed to load launch waitlist' });
  }
});

// was /api/admin/phase-zero
router.get('/phase-zero', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.created_at,
              u.declaration_accepted_at, u.phase_zero_completed_at,
              u.ai_guided_setup, u.audit_status, u.audit_day_count,
              u.audit_attempts, u.audit_lockout_until,
              u.is_creator,
              (SELECT COUNT(*) FROM phase_zero_daily_entries pze WHERE pze.user_id = u.id) AS entries_logged
       FROM users u
       WHERE u.is_creator = false
         AND u.email NOT IN (${OWNER_EMAILS.map((_, i) => '$' + (i + 1)).join(',')})
       ORDER BY u.created_at DESC
       LIMIT 200`,
      OWNER_EMAILS
    );
    const summary = {
      total_users: result.rowCount,
      completed: result.rows.filter(r => r.phase_zero_completed_at).length,
      in_audit: result.rows.filter(r => r.audit_status === 'in_progress').length,
      locked_out: result.rows.filter(r => r.audit_status === 'locked_out').length,
      not_started: result.rows.filter(r => !r.declaration_accepted_at).length,
    };
    res.json({ success: true, summary, users: result.rows });
  } catch (err) {
    console.error('[Admin] GET /api/admin/phase-zero error:', err.message);
    res.status(500).json({ error: 'Failed to load Phase Zero overview' });
  }
});

// was /api/admin/phase-zero/reset
router.post('/phase-zero/reset', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    await pool.query(
      `UPDATE users SET
         audit_status = 'in_progress',
         audit_day_count = 0,
         audit_start_date = NOW(),
         audit_last_activity_date = NULL,
         audit_attempts = COALESCE(audit_attempts, 0),
         audit_lockout_until = NULL
       WHERE id = $1`,
      [userId]
    );
    res.json({ success: true, message: 'Phase Zero audit reset' });
  } catch (err) {
    console.error('[Admin] POST /api/admin/phase-zero/reset error:', err.message);
    res.status(500).json({ error: 'Failed to reset Phase Zero' });
  }
});

// was /api/admin/phase-zero/complete
router.post('/phase-zero/complete', requireAuth, async (req, res) => {
  if (!(await requireCreator(req, res))) return;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    await pool.query(
      `UPDATE users SET
         phase_zero_completed_at = COALESCE(phase_zero_completed_at, NOW()),
         declaration_accepted_at = COALESCE(declaration_accepted_at, NOW()),
         audit_status = 'completed',
         audit_completed_at = COALESCE(audit_completed_at, NOW())
       WHERE id = $1`,
      [userId]
    );
    res.json({ success: true, message: 'Phase Zero marked as complete' });
  } catch (err) {
    console.error('[Admin] POST /api/admin/phase-zero/complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete Phase Zero' });
  }
});

// was /api/admin/aggregate-metrics
router.get('/aggregate-metrics', requireAuth, async (req, res) => {
  try {
    if (!(await requireAdminAllowlist(req, res))) return;
  } catch (err) {
    console.error('[AdminDashboard] admin check error:', err.message);
    if (!res.headersSent) res.status(403).json({ success: false, error: 'Admin access required' });
    return;
  }

  let client;
  try {
    client = await pool.connect();
    try { await client.query("SET statement_timeout = '8000'"); } catch (timeoutErr) { /* keep going */ }
    const payload = await collectAggregateMetrics(client);
    res.json(payload);
  } catch (err) {
    console.error('[AdminDashboard] aggregate-metrics error:', err.message);
    if (!res.headersSent) res.json(emptyAggregate(['aggregate']));
  } finally {
    if (client) {
      try { await client.query('RESET statement_timeout'); } catch (resetErr) { /* connection may already be closed */ }
      client.release();
    }
  }
});

// was /api/admin/support-tickets
router.get('/support-tickets', requireAuth, async (req, res) => {
  try {
    if (!(await requireAdminAllowlist(req, res))) return;

    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        subject TEXT,
        description TEXT,
        screenshot_url TEXT,
        page_url TEXT,
        status VARCHAR(32) DEFAULT 'open',
        admin_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `);

    const { status, limit = 50, offset = 0 } = req.query;
    let query = `
      SELECT
        st.id, st.subject, st.description, st.screenshot_url, st.page_url,
        st.status, st.admin_notes, st.created_at, st.resolved_at,
        u.email AS user_email, u.name AS user_name
      FROM support_tickets st
      LEFT JOIN users u ON u.id = st.user_id
    `;
    const params = [];
    if (status && ['open', 'resolved'].includes(status)) {
      query += ` WHERE st.status = $1`;
      params.push(status);
    }
    query += ` ORDER BY st.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit) || 50, parseInt(offset) || 0);

    const [tickets, countRes] = await Promise.all([
      pool.query(query, params),
      pool.query(`SELECT COUNT(*) FROM support_tickets${status && ['open', 'resolved'].includes(status) ? ` WHERE status = '${status}'` : ''}`)
    ]);

    res.json({
      success: true,
      tickets: tickets.rows,
      total: parseInt(countRes.rows[0].count)
    });
  } catch (err) {
    console.error('[SupportTickets] admin list error:', err.message);
    res.status(500).json({ error: 'Failed to load support tickets' });
  }
});

// was /api/admin/support-tickets/:id
router.patch('/support-tickets/:id', requireAuth, async (req, res) => {
  try {
    if (!(await requireAdminAllowlist(req, res))) return;

    const ticketId = parseInt(req.params.id);
    const { status, admin_notes } = req.body;
    if (!status || !['open', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'Status must be open or resolved' });
    }

    const result = await pool.query(
      `UPDATE support_tickets
       SET status = $1, admin_notes = $2, resolved_at = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING id, status, admin_notes, resolved_at`,
      [status, admin_notes || null, status === 'resolved' ? new Date() : null, ticketId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Ticket not found' });

    res.json({ success: true, ticket: result.rows[0] });
  } catch (err) {
    console.error('[SupportTickets] update error:', err.message);
    res.status(500).json({ error: 'Failed to update ticket' });
  }
});

// was /api/vault/admin/trigger-nightly-cycle
vaultRouter.post('/trigger-nightly-cycle', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Admin access required' });

    console.log('[SovereignLens] Manual cycle trigger by admin:', req.userId);

    // Fire-and-forget in background — returns immediately
    runSovereignLensNightlyCycle(pool)
      .then(summary => {
        sovereignLensLastCycle = {
          lastRun:             new Date().toISOString(),
          lastDealsChecked:    summary.dealsChecked,
          lastAlertsGenerated: summary.alertsGenerated,
        };
        console.log('[SovereignLens] Manual cycle complete:', summary);
      })
      .catch(err => {
        console.error('[SovereignLens] Manual cycle error:', err.message);
      });

    res.json({
      success: true,
      message: 'Sovereign Lens nightly cycle triggered. Check /api/vault/health for results.',
      triggeredAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('POST /api/vault/admin/trigger-nightly-cycle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// was /api/vault/admin/cycle-history
vaultRouter.get('/cycle-history', requireAuth, async (req, res) => {
  try {
    const creatorCheck = await isCreator(req.userId);
    if (!creatorCheck) return res.status(403).json({ error: 'Admin access required' });

    const { rows: runs } = await pool.query(`
      SELECT
        id,
        cycle_date,
        deals_checked,
        alerts_generated,
        auto_revokes_triggered,
        locked_open_activations,
        locked_open_deactivations,
        status,
        error_message,
        started_at,
        completed_at,
        EXTRACT(EPOCH FROM (completed_at - started_at))::int AS duration_secs
      FROM lens_cycle_runs
      WHERE cycle_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY cycle_date DESC
    `);

    // Also get total active deals count
    const { rows: [dealStats] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')    AS active_deals,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_deals,
        COUNT(*)                                      AS total_deals
      FROM lending_deals
    `).catch(() => ({ rows: [{ active_deals: 0, completed_deals: 0, total_deals: 0 }] }));

    // Unread alert count
    const { rows: [alertStats] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE NOT acknowledged)              AS unacknowledged_alerts,
        COUNT(*) FILTER (WHERE severity = 'critical' AND NOT acknowledged) AS critical_unack,
        COUNT(*)                                               AS total_alerts
      FROM asset_shield_alerts
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `).catch(() => ({ rows: [{ unacknowledged_alerts: 0, critical_unack: 0, total_alerts: 0 }] }));

    res.json({
      success: true,
      dealStats,
      alertStats,
      cycleRuns: runs,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/vault/admin/cycle-history error:', err.message);
    res.status(500).json({ error: err.message });
  }
});



module.exports = {
  router,
  pageRouter,
  vaultRouter,
  requireAdmin,
  parseMeta,
  bindAdminRuntime
};
