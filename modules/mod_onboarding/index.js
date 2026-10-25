/**
 * Onboarding Funnel Module
 *
 * Referral-to-Phase-Zero pipeline: 4-step calculator → forensic scan → vault signup → Phase Zero dashboard.
 * Schema: mod_onboarding
 *
 * Public routes (no auth required):
 *   GET  /api/mod_onboarding/ab/variant       — A/B test variant assignment (hook headline, core CTA)
 *   GET  /api/mod_onboarding/config           — analytics kill switch + A/B variants per session
 *   POST /api/mod_onboarding/calculator-submit   — Save step 1 inputs, returns sessionId + bleed
 *   POST /api/mod_onboarding/forensic-answer     — Record forensic question answer (Q0–Q4)
 *   POST /api/mod_onboarding/vault/create       — Create user + vault record (bcrypt, session set)
 *   POST /api/mod_onboarding/vault/upload       — PDF credit report upload → file storage, marks pdf_uploaded=true
 *   POST /api/mod_onboarding/vault/salary-submit — Save salary, activates Phase Zero
 *   GET  /api/mod_onboarding/dashboard/:userId  — Get Phase Zero dashboard data (buckets, bleed, salary)
 *   POST /api/mod_onboarding/exit-capture/save  — Save exit email, trigger recovery email sequence
 *   POST /api/mod_onboarding/track             — Analytics event (beacon endpoint, 12-event taxonomy)
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');

const { pool } = require('../../db/pool');
const { asyncRoute } = require('../../module-error-boundary');
const multer = require('multer');
const { sendEmail, emailConfigured } = require('../../lib/mailer');
const { uploadFile } = require('../../lib/fileStorage');

const APP_URL = process.env.APP_URL || 'https://app.factsmoney.com';
const creditUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: (req, file, cb) => { cb(null, true); } });

const ANALYTICS_ENABLED = process.env.ANALYTICS_ENABLED !== 'false';
const COMPOUND_RETURN_RATE = 0.08;
const DEFAULT_PROJECTION_YEARS = 30;
const MIN_PROJECTION_YEARS = 5;
const MAX_PROJECTION_YEARS = 40;

function clampProjectionYears(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_PROJECTION_YEARS;
  return Math.min(MAX_PROJECTION_YEARS, Math.max(MIN_PROJECTION_YEARS, n));
}

function computeMonthlyBleed(nm, mort, blendedRatePct) {
  const rate = (parseFloat(blendedRatePct) || 0) / 100;
  return Math.round(((parseFloat(nm) || 0) * rate / 12 + (parseFloat(mort) || 0) * rate / 12) * 100) / 100;
}

function computeCompoundedLifetimeBleed(monthlyBleed, projectionYears) {
  const monthly = parseFloat(monthlyBleed) || 0;
  const years = clampProjectionYears(projectionYears);
  if (monthly <= 0) return 0;
  const fv = monthly * 12 * ((Math.pow(1 + COMPOUND_RETURN_RATE, years) - 1) / COMPOUND_RETURN_RATE);
  return Math.round(fv * 100) / 100;
}

// A/B: deterministic split by session hash
function getABVariants(sessionId) {
  const raw = sessionId ? String(sessionId) : String(Date.now());
  const hash = crypto.createHash('md5').update(raw).digest('hex');
  const bucket = parseInt(hash.slice(0, 8), 16) % 100;
  return { hookHeadline: bucket < 50 ? 'A' : 'B', coreCTA: bucket < 50 ? 'A' : 'B' };
}

const router = express.Router();

router.get('/ab/variant', asyncRoute(async (req, res) => {
  const sid = req.query.sessionId || String(Date.now());
  res.json(getABVariants(sid));
}));

router.post('/track', asyncRoute(async (req, res) => {
  if (!ANALYTICS_ENABLED) return res.json({ ok: true });
  const event   = req.query.event   || req.body?.event;
  const rawData = req.query.data   || req.body?.data || '{}';
  let data = {};
  try { data = JSON.parse(decodeURIComponent(rawData)); } catch (_) {}
  if (!event) return res.status(400).json({ error: 'Missing event name' });
  const sid = data.sessionId || null;
  let userId = null;
  if (sid) {
    const q = await pool.query(
      `SELECT user_id FROM mod_onboarding.vault_users WHERE session_id = $1 LIMIT 1`, [sid]
    );
    if (q.rows[0]) userId = q.rows[0].user_id;
  }
  try {
    await pool.query(
      `INSERT INTO mod_onboarding.onboarding_events (session_id, user_id, event_name, metadata)
       VALUES ($1,$2,$3,$4)`, [sid, userId, event, JSON.stringify(data)]
    );
  } catch (err) { console.error('[mod_onboarding] track:', err.message); }
  res.json({ ok: true });
}));

router.post('/calculator-submit', asyncRoute(async (req, res) => {
  const {
    income,
    nonMortgageDebt,
    mortgageDebt,
    blendedRate,
    projectionYears,
    monthlyBleed,
    lifetimeBleed,
  } = req.body;

  const nm = parseFloat(nonMortgageDebt) || 0;
  const mort = parseFloat(mortgageDebt) || 0;
  const years = clampProjectionYears(projectionYears);
  const monthly = monthlyBleed != null
    ? Math.round(parseFloat(monthlyBleed) * 100) / 100
    : computeMonthlyBleed(nm, mort, blendedRate);
  const lifetime = lifetimeBleed != null
    ? Math.round(parseFloat(lifetimeBleed) * 100) / 100
    : computeCompoundedLifetimeBleed(monthly, years);

  const result = await pool.query(
    `INSERT INTO mod_onboarding.funnel_sessions
       (income, nm_debt, mort_debt, blended_rate, monthly_bleed, lifetime_bleed, projection_years, referrer)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [income, nm, mort, blendedRate, monthly, lifetime, years, req.headers.referer || null]
  );
  res.json({
    sessionId: result.rows[0].id,
    monthlyBleed: monthly,
    lifetimeBleed: lifetime,
    projectionYears: years,
  });
}));

router.post('/forensic-answer', asyncRoute(async (req, res) => {
  const { sessionId, questionId, answer } = req.body;
  if (!sessionId || questionId === undefined) return res.status(400).json({ error: 'sessionId and questionId required' });
  await pool.query(
    `INSERT INTO mod_onboarding.forensic_answers (session_id,question_id,answer) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`, [sessionId, questionId, answer]
  );
  await pool.query(
    `UPDATE mod_onboarding.funnel_sessions SET completed_step=2,updated_at=now() WHERE id=$1`, [sessionId]
  );
  res.json({ ok: true });
}));

router.post('/vault/create', asyncRoute(async (req, res) => {
  const { name, email, password, sessionId } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required.' });
  const normalized = email.toLowerCase().trim();
  const existing = await pool.query(`SELECT id FROM users WHERE email=$1 LIMIT 1`, [normalized]);
  if (existing.rows.length > 0) return res.status(409).json({ error: 'An account with this email already exists. Try logging in.' });
  const bcrypt = require('bcrypt');
  const hashed = await bcrypt.hash(password, 12);
  const userR = await pool.query(
    `INSERT INTO users (name,email,password_hash,created_at) VALUES ($1,$2,$3,now()) RETURNING id,email`,
    [name.trim(), normalized, hashed]
  );
  const userId = userR.rows[0].id;
  try {
    const { handleNewRegistration } = require('../mod_affiliate');
    let refCode = (req.body && (req.body.ref_code || req.body.referral_code)) || null;
    if (!refCode && sessionId) {
      const sess = await pool.query(
        `SELECT referrer FROM mod_onboarding.funnel_sessions WHERE id = $1`,
        [sessionId]
      );
      refCode = (sess.rows[0] && sess.rows[0].referrer) || null;
    }
    await handleNewRegistration({ newUserId: userId, refCode });
  } catch (err) {
    console.warn('[mod_onboarding] orphan/allocation seed:', err.message);
  }
  if (sessionId) {
    await pool.query(
      `INSERT INTO mod_onboarding.vault_users (user_id,session_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [userId, sessionId]
    );
    await pool.query(`UPDATE mod_onboarding.funnel_sessions SET completed_step=3,updated_at=now() WHERE id=$1`, [sessionId]);
  }
  req.session.userId = userId;
  await new Promise(cb => req.session.save(cb));
  res.json({ userId, email: userR.rows[0].email });
}));

router.post('/vault/upload', creditUpload.single('credit_report'), asyncRoute(async (req, res) => {
  // multer.single() places the file in req.file (not req.files)
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const file = req.file;
  const valid = file.mimetype === 'application/pdf';
  if (!valid) return res.status(400).json({ error: 'Only PDF files are accepted.', fileTypeValidated: false });

  // Upload to file storage (null when storage is not configured or the upload fails)
  const r2Url = await uploadFile(file.buffer, `credit-report-${Date.now()}.pdf`, 'application/pdf', { folder: 'credit-reports' });

  // Mark pdf_uploaded = true on vault record (regardless of upload outcome)
  if (req.body.sessionId) {
    await pool.query(
      `UPDATE mod_onboarding.vault_users SET pdf_uploaded=true WHERE session_id=$1`,
      [req.body.sessionId]
    ).catch(() => {});
  }

  res.json({ ok: true, fileTypeValidated: true, fileSize: file.size, fileName: file.originalname, r2Url });
}));

router.post('/vault/salary-submit', asyncRoute(async (req, res) => {
  const userId = req.userId || req.session?.userId;
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  const salaryVal = parseFloat(req.body.salary) || 0;
  await pool.query(
    `UPDATE mod_onboarding.vault_users SET salary=$1,phase_zero_complete=true WHERE user_id=$2`,
    [salaryVal, userId]
  );
  if (req.body.sessionId) {
    await pool.query(
      `UPDATE mod_onboarding.funnel_sessions SET completed_step=4,updated_at=now() WHERE id=$1`,
      [req.body.sessionId]
    );
  }
  res.json({ ok: true, salary: salaryVal });
}));

// ─── Exit Capture ─────────────────────────────────────────────────────────────
router.post('/exit-capture/save', asyncRoute(async (req, res) => {
  const { email, lifetimeBleed, sessionId } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const emailHash = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, 64);
  const bleedSnapshot = parseFloat(lifetimeBleed) || 0;

  // Save capture
  let savedSessionId = sessionId;
  try {
    const ins = await pool.query(
      `INSERT INTO mod_onboarding.exit_captures (session_id, email_hash, lifetime_bleed_at_capture)
       VALUES ($1, $2, $3) RETURNING id`,
      [sessionId || null, emailHash, bleedSnapshot]
    );
    // If session exists, move funnel to step 1.5 (paused at exit)
    if (sessionId) {
      await pool.query(`UPDATE mod_onboarding.funnel_sessions SET completed_step=1, updated_at=now() WHERE id=$1`, [sessionId]);
    }
  } catch (err) {
    // Duplicate email hash — already captured
    if (err.code !== '23505') console.error('[mod_onboarding] exit_capture:', err.message);
  }

  // Send Email 1: "Your Bleed Calculation is Ready" — immediate
  sendRecoveryEmail1(email, bleedSnapshot, sessionId).catch(err => console.error('[mod_onboarding] email1:', err.message));

  // Schedule Emails 2 and 3
  scheduleFollowUpEmails(email, bleedSnapshot).catch(err => console.error('[mod_onboarding] email2/3:', err.message));

  res.json({ ok: true, emailHash });
}));

// ─── Analytics Kill Switch ────────────────────────────────────────────────
router.get('/config', asyncRoute(async (req, res) => {
  res.json({
    analyticsEnabled: ANALYTICS_ENABLED,
    abVariants: getABVariants(req.query.sessionId || String(Date.now())),
  });
}));

router.get('/dashboard/:userId', asyncRoute(async (req, res) => {
  const userId = parseInt(req.params.userId) || 0;
  const vault = await pool.query(`SELECT * FROM mod_onboarding.vault_users WHERE user_id=$1 LIMIT 1`, [userId]);
  if (!vault.rows.length) return res.status(404).json({ error: 'Vault not found' });

  // Fetch bleed from the user's own session (not any arbitrary session)
  const sessionId = vault.rows[0].session_id;
  const session = sessionId
    ? await pool.query(
        `SELECT monthly_bleed,lifetime_bleed FROM mod_onboarding.funnel_sessions WHERE id=$1 LIMIT 1`, [sessionId]
      )
    : { rows: [] };

  let answers = {};
  if (vault.rows[0].session_id) {
    const ans = await pool.query(
      `SELECT question_id,answer FROM mod_onboarding.forensic_answers WHERE session_id=$1 ORDER BY question_id`,
      [vault.rows[0].session_id]
    );
    ans.rows.forEach(r => { answers[r.question_id] = r.answer; });
  }

  const BUCKET_MAP = { 0:['necessities','lifestyle'], 1:['reserve'], 2:['velocity','growth'], 3:['lifestyle'], 4:['legacy'] };
  const bucketStates = { necessities:'unanswered', velocity:'unanswered', reserve:'unanswered', lifestyle:'unanswered', growth:'unanswered', legacy:'unanswered' };
  Object.entries(BUCKET_MAP).forEach(([qId, buckets]) => {
    const answered = answers[qId] !== undefined;
    if (answered && answers[qId] === true)  buckets.forEach(b => { bucketStates[b] = 'structured'; });
    if (answered && answers[qId] === false) buckets.forEach(b => { bucketStates[b] = 'breached'; });
  });

  res.json({
    salary: vault.rows[0].salary,
    pdfUploaded: vault.rows[0].pdf_uploaded,
    monthlyBleed:  session.rows[0]?.monthly_bleed  || 0,
    lifetimeBleed: session.rows[0]?.lifetime_bleed || 0,
    buckets: bucketStates,
  });
}));

// ─── Email helpers ─────────────────────────────────────────────────────────────
async function sendRecoveryEmail1(email, lifetimeBleed, sessionId) {
  if (!emailConfigured()) return;
  const bleedStr = lifetimeBleed > 0 ? `$${Math.round(lifetimeBleed).toLocaleString()}` : 'calculated';
  const resumeUrl = sessionId ? `${APP_URL}/facts-funnel?session=${sessionId}` : null;
  const text = `Your Bleed Calculation is Ready\n\nYour estimated lifetime interest leak: ${bleedStr}\n\n` + (resumeUrl ? `Pick up where you left off: ${resumeUrl}\n\n` : '') + `Don't let those numbers fade. Complete your Forensic Scan and lock in your baseline.\n\n— FACTS`;
  const result = await sendEmail({
    to: email,
    subject: 'Your Bleed Calculation is Ready — FACTS',
    text,
  });
  if (!result.sent) console.error('[mod_onboarding] sendRecoveryEmail1:', result.error);
}

// Schedule follow-up emails 2 and 3 via database rows (sent by cron-delayed-emails.js)
async function scheduleFollowUpEmails(email, lifetimeBleed) {
  if (!emailConfigured()) return;
  // Schedule Email 2 for +24h, Email 3 for +72h via delay-send table
  try {
    await pool.query(
      `INSERT INTO mod_onboarding.delayed_emails (recipient, subject, body_plain, send_at)
       VALUES ($1, $2, $3, now() + INTERVAL '24 hours')`,
      [email,
       "The $" + Math.round(lifetimeBleed).toLocaleString() + " You Didn't Know You Were Losing \u2014 FACTS",
       `The $${Math.round(lifetimeBleed).toLocaleString()} You Didn't Know You Were Losing\n\n` +
       `Most people have no idea they're hemorrhaging wealth through back door interest.\n\n` +
       `Your calculation shows a significant bleed. Here's what it means: every dollar sitting in low-yield accounts is slowly losing purchasing power.\n\n` +
       `The good news: it can be stopped. Complete the Forensic Scan to see exactly where the leaks are.\n\n` +
       `→ Start now: ${APP_URL}/facts-funnel\n\n— FACTS`
      ]
    );
    await pool.query(
      `INSERT INTO mod_onboarding.delayed_emails (recipient, subject, body_plain, send_at)
       VALUES ($1, $2, $3, now() + INTERVAL '72 hours')`,
      [email,
       'Ready to Lock In Your Baseline? — FACTS',
       `Ready to Lock In Your Baseline?\n\n` +
       `Your calculation resets in 48 hours.\n\n` +
       `Complete the Forensic Scan now and we\\'ll hold your baseline for 30 days.\n\n` +
       `→ Lock in your baseline: ${APP_URL}/facts-funnel\n\n` +
       `— FACTS`
      ]
    );
  } catch (err) {
    if (err.code !== '42P01') console.error('[mod_onboarding] scheduleFollowUpEmails:', err.message);
  }
}

module.exports = {
  metadata: { name: 'Onboarding Funnel', version: '1.0.0', defaultEnabled: true },
  routes: router,
  healthCheck: async (dbPool) => {
    try {
      const check = await dbPool.query(
        `SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name='mod_onboarding') AS schema_exists`
      );
      return { module:'mod_onboarding', status: check.rows[0].schema_exists ? 'ok' : 'schema_missing', version:'1.0.0', timestamp: new Date().toISOString() };
    } catch (err) {
      return { module:'mod_onboarding', status:'error', error: err.message, timestamp: new Date().toISOString() };
    }
  },
};
