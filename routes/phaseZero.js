'use strict';

/**
 * Phase Zero onboarding routes, gates, and verification helpers.
 * Mount:
 *   app.use('/api/phase-zero', router)
 *   app.use('/api/email-verify', emailRouter)
 *   app.use('/api/sms-verify', smsRouter)
 *   app.use(pageRouter)  // /phase-zero and /lockout pages
 *   applyPhaseZeroGates(app, pool)
 */

const express = require('express');
const path = require('path');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');
const { sendEmail } = require('../lib/mailer');
const { getOpenAI } = require('../lib/aiClient');
const {
  sendVerification,
  checkVerification
} = require('../services/twilio');
const pzDeadlineModule = require('../modules/mod_pz_deadline');
const { ensureDefaultFactsSetup } = require('./allocations');

const router = express.Router();
const emailRouter = express.Router();
const smsRouter = express.Router();
const pageRouter = express.Router();

const runtime = {};
function bindPhaseZeroRuntime(helpers) {
  Object.assign(runtime, helpers || {});
}

function ensureFgBalance(userId) {
  if (typeof runtime.ensureFgBalance === 'function') return runtime.ensureFgBalance(userId);
  return Promise.resolve();
}

async function tfrEnsureStats(userId, q) {
  if (typeof runtime.tfrEnsureStats === 'function') return runtime.tfrEnsureStats(userId, q);
}

async function tfrAwardXp(userId, source, description, xpAmount, client) {
  if (typeof runtime.tfrAwardXp === 'function') {
    return runtime.tfrAwardXp(userId, source, description, xpAmount, client);
  }
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}


async function pzLogReward(userId, eventType, xpAmount, pointsAmount, metadata, dbClient) {
  try {
    var q = dbClient || pool;
    await q.query(
      'INSERT INTO phase_zero_rewards_log (user_id, event_type, xp_amount, points_amount, metadata) VALUES ($1,$2,$3,$4,$5)',
      [userId, eventType, xpAmount, pointsAmount, JSON.stringify(metadata || {})]
    );
  } catch(e) { /* non-fatal */ }
}

// Utility: award TFR XP (wraps tfrAwardXp, handles missing stats row gracefully)
async function pzAwardXp(userId, source, description, xpAmount, dbClient) {
  var q = dbClient || pool;
  try {
    // Ensure stats row exists
    await tfrEnsureStats(userId, q);
    // Need a transaction client for tfrAwardXp
    if (dbClient) {
      return await tfrAwardXp(userId, source, description, xpAmount, dbClient);
    } else {
      var client = await pool.connect();
      try {
        await client.query('BEGIN');
        var result = await tfrAwardXp(userId, source, description, xpAmount, client);
        await client.query('COMMIT');
        return result;
      } catch(e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  } catch(e) {
    console.error('[PhaseZero] XP award failed:', e.message);
    await pzLogReward(userId, source, xpAmount, 0, { description, error: e.message });
  }
}

// Utility: award FG wallet points
async function pzAwardWalletPoints(userId, amount, activity, description) {
  try {
    await ensureFgBalance(userId);
    await pool.query(
      'UPDATE fg_points_balances SET balance = balance + $2, total_earned = total_earned + $2, updated_at = NOW() WHERE user_id = $1',
      [userId, amount]
    );
    await pool.query(
      'INSERT INTO fg_earning_events (user_id, activity_type, description, points) VALUES ($1,$2,$3,$4)',
      [userId, activity, description, amount]
    );
  } catch(e) {
    console.error('[PhaseZero] Wallet points award failed:', e.message);
    await pzLogReward(userId, activity, 0, amount, { description, error: e.message });
  }
}

// Rule-based allocation suggestion (fallback when AI unavailable)
// Always returns the canonical 50/10/10/10/10/10 baseline with a goal-specific rationale.
// The AI path can personalize; the fallback must be safe and predictable.
function buildAllocationSuggestion(answers) {
  var alloc = { necessities: 50, velocity: 10, reserve: 10, lifestyle: 10, growth: 10, legacy: 10 };
  var rationale = 'Balanced allocation across all 6 categories — the FACTS baseline. You can customize anytime in Settings.';

  if (answers.goal === 'crush_debt' || answers.debt === 'yes_significant') {
    rationale = 'Starting with the balanced 50/10/10/10/10/10 baseline. Once settled, consider boosting Velocity to accelerate debt payoff — adjust in Settings.';
  } else if (answers.goal === 'build_savings' || answers.emergency === 'no') {
    rationale = 'Starting with the balanced 50/10/10/10/10/10 baseline. Once settled, consider boosting The Reserve to build your emergency fund — adjust in Settings.';
  } else if (answers.goal === 'grow_wealth') {
    rationale = 'Starting with the balanced 50/10/10/10/10/10 baseline. Once settled, consider boosting Growth and Legacy to accelerate wealth building — adjust in Settings.';
  } else if (answers.debt === 'yes_mortgage') {
    rationale = 'Starting with the balanced 50/10/10/10/10/10 baseline. Mortgage-only debt allows a balanced approach — adjust in Settings as your strategy evolves.';
  }

  return { allocations: alloc, rationale: rationale };
}


// ─── Phase Zero Navigation Gate ───────────────────────────────────────────────
// Redirects logged-in users who haven't completed Phase Zero.
// Admin/owner emails bypass the gate for testing.
// Deadline lockout (mod_pz_deadline) must run before this gate.
function applyPhaseZeroNavigationGate(app, db) {
  // NOTE: /app is intentionally NOT bypassed — incomplete Phase Zero users
  // must finish onboarding (login/signup land here via redirect).
  var PZ_BYPASS_PATHS = [
    '/', '/index.html', '/login', '/login.html', '/signup', '/signup.html',
    '/admin', '/admin.html',
    '/bleed-calculator', '/stolen-calculator', '/facts-funnel', '/forensic-scan',
    '/phase-zero', '/phase-zero.html', '/phase-zero-widget.js',
    '/lockout', '/lockout.html',
    '/forgot-password', '/forgot-password.html',
    '/reset-password', '/reset-password.html',
    '/health', '/compliance-disclaimer.js',
    '/terms-of-service', '/terms-of-service.html',
    '/nda', '/nda.html', '/dashboard',
    '/privacy-policy', '/privacy-policy.html'
  ];
  var PZ_EXT_RE = /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|webp|map|json|txt|xml)$/i;

  app.use(function phaseZeroGate(req, res, next) {
    if (req.path.startsWith('/api/')) return next();
    if (PZ_EXT_RE.test(req.path)) return next();
    if (PZ_BYPASS_PATHS.indexOf(req.path) !== -1) return next();
    if (!req.session || !req.session.userId) return next();
    var email = (req.session.email || '').toLowerCase();
    var creator = (process.env.CREATOR_EMAIL || '').toLowerCase();
    var adminEmails = (process.env.ADMIN_EMAILS || 'chris.finrev@gmail.com')
      .split(',').map(function(e) { return e.trim().toLowerCase(); }).filter(Boolean);
    var ownerEmails = (process.env.OWNER_EMAILS || process.env.FUTURE_GEN_EMAILS || 'ecci2760@gmail.com,ecci2760f@gmail.com,dianes3cps@gmail.com')
      .split(',').map(function(e) { return e.trim().toLowerCase(); }).filter(Boolean);
    if (email && (
      email === creator ||
      adminEmails.indexOf(email) !== -1 ||
      ownerEmails.indexOf(email) !== -1
    )) return next();
    // Always re-check DB so admin reset-data clears a stale session.pzComplete cache
    db.query('SELECT phase_zero_completed_at FROM users WHERE id = $1', [req.session.userId])
      .then(function(r) {
        var u = r.rows[0];
        if (u && u.phase_zero_completed_at) {
          req.session.pzComplete = true;
          return next();
        }
        req.session.pzComplete = false;
        return res.redirect('/phase-zero');
      })
      .catch(function() { next(); });
  });
}

// ─── Audit Lockout Middleware ──────────────────────────────────────────────────
// Blocks write APIs for users in audit lockout (read-only mode).
function applyAuditLockoutGuard(app, db) {
  app.use(function auditLockoutGuard(req, res, next) {
    if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') return next();
    var writePaths = ['/api/transactions', '/api/income', '/api/allocations'];
    var isWrite = writePaths.some(function(p) { return req.path === p || req.path.startsWith(p + '/'); });
    if (!isWrite) return next();
    if (!req.session || !req.session.userId) return next();
    db.query('SELECT audit_status, audit_lockout_until FROM users WHERE id = $1', [req.session.userId])
      .then(function(r) {
        var u = r.rows[0];
        if (!u || u.audit_status !== 'locked') return next();
        var until = u.audit_lockout_until ? new Date(u.audit_lockout_until) : null;
        if (!until || until <= new Date()) {
          db.query(
            'UPDATE users SET audit_status = $1 WHERE id = $2',
            ['not_started', req.session.userId]
          ).catch(function() {});
          return next();
        }
        return res.status(403).json({
          error: 'Account is in read-only mode during lockout period.',
          lockout_until: until.toISOString(),
          code: 'AUDIT_LOCKED'
        });
      })
      .catch(function() { next(); });
  });
}

function applyPhaseZeroGates(app, db) {
  const database = db || pool;
  pzDeadlineModule.applyDeadlineLockoutMiddleware(app, database);
  applyPhaseZeroNavigationGate(app, database);
  applyAuditLockoutGuard(app, database);
}

pageRouter.get('/phase-zero', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'phase-zero.html'));
});

pageRouter.get('/lockout', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'lockout.html'));
});

async function ensurePhaseZeroColumns() {
  try {
    const { ensureAuthSchema } = require('../lib/ensureAuthSchema');
    await ensureAuthSchema(pool);
  } catch (err) {
    console.error('[PhaseZero] ensureAuthSchema:', err.message);
  }
}

router.get('/status', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;
    var result;
    try {
      result = await pool.query(
        `SELECT email, declaration_accepted_at, phase_zero_completed_at, ai_guided_setup,
                ai_setup_answers, phone_verified_at, audit_status, audit_day_count, audit_start_date,
                audit_last_activity_date, audit_completed_at, audit_attempts, audit_lockout_until,
                updated_at
         FROM users WHERE id = $1`, [userId]
      );
    } catch (selectErr) {
      console.error('[PhaseZero] status SELECT failed, self-healing schema:', selectErr.message);
      await ensurePhaseZeroColumns();
      result = await pool.query(
        `SELECT email, declaration_accepted_at, phase_zero_completed_at, ai_guided_setup,
                ai_setup_answers, phone_verified_at, audit_status, audit_day_count, audit_start_date,
                audit_last_activity_date, audit_completed_at, audit_attempts, audit_lockout_until,
                updated_at
         FROM users WHERE id = $1`, [userId]
      );
    }
    var user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Client resumes steps using allocation_set_at (derived when skip-ai or ai-setup saved answers).
    var answers = user.ai_setup_answers;
    if (typeof answers === 'string') {
      try { answers = JSON.parse(answers); } catch (e) { answers = null; }
    }
    var allocationSet = !!(answers && (answers.allocations || answers.method === 'manual'));
    res.json(Object.assign({}, user, {
      allocation_set_at: allocationSet ? (user.updated_at || true) : null
    }));
  } catch(e) {
    console.error('[PhaseZero] status error:', e.message);
    res.status(500).json({ error: 'Server error', detail: String(e.message || '').slice(0, 180) });
  }
});

router.post('/accept-declaration', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;
    // Set declaration_accepted_at + phase_zero_started_at (starts the 7-day deadline timer)
    // COALESCE preserves the original start time if user re-accepts (e.g., after admin override resets timer)
    try {
      await pool.query(
        `UPDATE users SET
           declaration_accepted_at = COALESCE(declaration_accepted_at, NOW()),
           phase_zero_started_at = COALESCE(phase_zero_started_at, NOW()),
           updated_at = NOW()
         WHERE id = $1`,
        [userId]
      );
    } catch (updateErr) {
      console.error('[PhaseZero] declaration UPDATE failed, self-healing schema:', updateErr.message);
      await ensurePhaseZeroColumns();
      await pool.query(
        `UPDATE users SET
           declaration_accepted_at = COALESCE(declaration_accepted_at, NOW()),
           phase_zero_started_at = COALESCE(phase_zero_started_at, NOW()),
           updated_at = NOW()
         WHERE id = $1`,
        [userId]
      );
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('[PhaseZero] declaration error:', e.message);
    res.status(500).json({ error: 'Server error', detail: String(e.message || '').slice(0, 180) });
  }
});

router.post('/skip-ai', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;
    var defaults = { necessities: 50, velocity: 10, reserve: 10, lifestyle: 10, growth: 10, legacy: 10 };
    await pool.query(
      'UPDATE users SET ai_guided_setup = FALSE, ai_setup_answers = $2, updated_at = NOW() WHERE id = $1',
      [userId, JSON.stringify({ method: 'manual', allocations: defaults })]
    );
    // Apply default allocations if allocation columns exist
    try {
      await pool.query(
        `UPDATE users SET
          alloc_necessities = $2, alloc_velocity = $3, alloc_reserve = $4,
          alloc_lifestyle = $5, alloc_growth = $6, alloc_legacy = $7
         WHERE id = $1`,
        [userId, defaults.necessities, defaults.velocity, defaults.reserve,
         defaults.lifestyle, defaults.growth, defaults.legacy]
      );
    } catch(e2) { /* allocation columns might not exist — non-fatal */ }
    res.json({ ok: true });
  } catch(e) {
    console.error('[PhaseZero] skip-ai error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/ai-suggest', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;
    var { income, debt, emergency, goal } = req.body;
    if (!income || !debt || !emergency || !goal) {
      return res.status(400).json({ error: 'All four answers are required.' });
    }

    // Try AI first, fall back to rule-based
    var suggestion = null;
    try {
      var aiClient = getOpenAI();
      var prompt = `You are a FACTS Protocol financial architect. Based on the user's answers, suggest optimal allocation percentages across 6 buckets that sum to exactly 100.

User answers:
- Monthly income: $${income}
- Debt situation: ${debt}
- Emergency fund: ${emergency}
- Primary goal: ${goal}

Buckets (must sum to exactly 100):
- necessities (shelter, utilities, food) — typically 40-55%
- velocity (debt payoff) — increase if significant debt
- reserve (emergency savings) — increase if no emergency fund
- lifestyle (discretionary spending)
- growth (investments, wealth building)
- legacy (generational wealth, giving)

Respond with JSON only:
{"necessities": N, "velocity": N, "reserve": N, "lifestyle": N, "growth": N, "legacy": N, "rationale": "one sentence explanation"}`;

      var completion = await aiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        max_tokens: 300,
        temperature: 0.3
      }, { headers: { 'x-task': 'phase_zero_allocation_suggest' } });

      var parsed = JSON.parse(completion.choices[0].message.content);
      var total = (parsed.necessities||0) + (parsed.velocity||0) + (parsed.reserve||0) +
                  (parsed.lifestyle||0) + (parsed.growth||0) + (parsed.legacy||0);

      // Normalize if needed
      if (Math.abs(total - 100) > 2) {
        // Fall through to rule-based
        throw new Error('AI allocation did not sum to 100: ' + total);
      }
      // Adjust final bucket to ensure exact 100
      var buckets = ['necessities','velocity','reserve','lifestyle','growth','legacy'];
      var runningTotal = 0;
      for (var i = 0; i < buckets.length - 1; i++) {
        parsed[buckets[i]] = Math.round(parsed[buckets[i]]);
        runningTotal += parsed[buckets[i]];
      }
      parsed.legacy = 100 - runningTotal;

      suggestion = { allocations: parsed, rationale: parsed.rationale || 'AI-optimized allocation based on your financial situation.' };
    } catch(aiErr) {
      console.warn('[PhaseZero] AI suggest fallback:', aiErr.message);
      suggestion = buildAllocationSuggestion({ income, debt, emergency, goal });
    }

    res.json(suggestion);
  } catch(e) {
    console.error('[PhaseZero] ai-suggest error:', e.message);
    res.status(500).json({ error: 'Server error generating suggestion.' });
  }
});

router.post('/ai-setup', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;
    var { answers, allocations } = req.body;
    if (!allocations) return res.status(400).json({ error: 'Allocations required.' });
    var total = Object.values(allocations).reduce(function(a,b) { return a+b; }, 0);
    if (Math.abs(total - 100) > 0.5) {
      return res.status(400).json({ error: 'Allocations must sum to 100. Got: ' + total });
    }

    await pool.query(
      'UPDATE users SET ai_guided_setup = TRUE, ai_setup_answers = $2, updated_at = NOW() WHERE id = $1',
      [userId, JSON.stringify({ answers: answers, allocations: allocations })]
    );
    // Apply allocations if columns exist
    try {
      await pool.query(
        `UPDATE users SET
          alloc_necessities = $2, alloc_velocity = $3, alloc_reserve = $4,
          alloc_lifestyle = $5, alloc_growth = $6, alloc_legacy = $7
         WHERE id = $1`,
        [userId, allocations.necessities||50, allocations.velocity||10, allocations.reserve||10,
         allocations.lifestyle||10, allocations.growth||10, allocations.legacy||10]
      );
    } catch(e2) { /* non-fatal */ }
    res.json({ ok: true });
  } catch(e) {
    console.error('[PhaseZero] ai-setup error:', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

emailRouter.post('/send', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;

    // Rate limit: max 3 attempts per hour
    var user = (await pool.query(
      'SELECT email, name, phone_otp_attempts, phone_otp_window_start FROM users WHERE id = $1', [userId]
    )).rows[0];
    if (!user || !user.email) {
      return res.status(400).json({ error: 'User not found or no email on account.' });
    }

    var windowStart = user.phone_otp_window_start ? new Date(user.phone_otp_window_start) : null;
    var windowOpen = windowStart && (Date.now() - windowStart.getTime()) < 3600000;
    if (windowOpen && (user.phone_otp_attempts || 0) >= 3) {
      return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
    }

    var otp = generateOtp();
    var expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    var attempts = (user && windowOpen) ? (user.phone_otp_attempts || 0) + 1 : 1;

    // Reuse phone_otp columns for email OTP (same schema, no migration needed)
    await pool.query(
      `UPDATE users SET phone_otp = $2, phone_otp_expires_at = $3,
          phone_otp_attempts = $4,
          phone_otp_window_start = CASE WHEN $5 THEN phone_otp_window_start ELSE NOW() END,
          updated_at = NOW() WHERE id = $1`,
      [userId, otp, expiresAt, attempts, !!(windowOpen)]
    );

    // Send OTP via Resend
    var appName = 'FACTS';
    var appUrl = process.env.APP_URL || 'https://app.factsmoney.com';
    try {
      await sendEmail({
          to: user.email,
          subject: `${otp} is your ${appName} verification code`,
          text: `Your ${appName} Phase Zero verification code is: ${otp}\n\nThis code expires in 10 minutes.\n\nIf you didn't request this, you can ignore this email.`,
          html: `
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0a0f1a;border-radius:16px;">
              <h2 style="color:#10b981;margin:0 0 8px;font-size:1.4rem;">${appName} Verification Code</h2>
              <p style="color:#94a3b8;margin:0 0 28px;font-size:0.95rem;">Hi ${user.name || 'there'},</p>
              <p style="color:#e2e8f0;margin:0 0 24px;font-size:0.95rem;line-height:1.6;">
                Use the code below to complete your Phase Zero identity verification. It expires in <strong style="color:#f59e0b;">10 minutes</strong>.
              </p>
              <div style="background:#1a2332;border:2px solid #10b981;border-radius:12px;padding:24px;text-align:center;margin-bottom:28px;">
                <span style="font-size:2.5rem;font-weight:700;letter-spacing:12px;color:#10b981;font-family:'Courier New',monospace;">${otp}</span>
              </div>
              <p style="color:#64748b;font-size:0.85rem;line-height:1.5;">
                If you didn't request this, you can safely ignore this email.<br>
                <a href="${appUrl}" style="color:#10b981;">${appUrl}</a>
              </p>
            </div>`
      });
    } catch (emailErr) {
      console.error('[PhaseZero] email-verify send error:', emailErr.message);
      // Still return success — code is stored, user can retry
    }

    res.json({ ok: true, message: 'Code sent to your email.' });
  } catch(e) {
    console.error('[PhaseZero] email-verify-send error:', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

emailRouter.post('/confirm', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;
    var { code } = req.body;
    if (!code || code.trim().length !== 6) {
      return res.status(400).json({ error: 'Enter the 6-digit code.' });
    }

    var user = (await pool.query(
      'SELECT phone_otp, phone_otp_expires_at FROM users WHERE id = $1', [userId]
    )).rows[0];

    if (!user || !user.phone_otp) {
      return res.status(400).json({ error: 'No pending verification. Request a new code.' });
    }
    if (new Date(user.phone_otp_expires_at) < new Date()) {
      return res.status(400).json({ error: 'Code expired. Request a new one.' });
    }
    if (code.trim() !== user.phone_otp) {
      return res.status(400).json({ error: 'Incorrect code. Try again.' });
    }

    // Mark email verified — reuse phone_verified_at as the verification timestamp
    await pool.query(
      `UPDATE users SET phone_verified_at = NOW(),
          phone_otp = NULL, phone_otp_expires_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );

    res.json({ ok: true });
  } catch(e) {
    console.error('[PhaseZero] email-verify-confirm error:', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

smsRouter.post('/set-phone', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;
    var { phone } = req.body;

    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Phone number is required.' });
    }

    // Validate and normalize E.164 format (allow + prefix, strip spaces/dashes)
    var normalized = phone.trim().replace(/[\t ]+/g, '');
    if (!normalized.startsWith('+')) {
      normalized = '+' + normalized;
    }
    // Basic E.164 validation: + then 7-15 digits
    if (!/^\\+[1-9]\/[1-9]{7,14}$/.test(normalized.replace(/[ -]/g, ''))) {
      // More permissive check: at least + and reasonable digit count
      var digitsOnly = normalized.replace(/[^0-9]/g, '');
      if (digitsOnly.length < 7 || digitsOnly.length > 15) {
        return res.status(400).json({ error: 'Enter a valid phone number with country code (e.g. +12025551234).' });
      }
    }

    // Store the phone number
    await pool.query(
      'UPDATE users SET verified_phone = $2, updated_at = NOW() WHERE id = $1',
      [userId, normalized]
    );

    // Reset OTP attempts on new phone registration
    await pool.query(
      `UPDATE users SET phone_otp_attempts = 0, phone_otp_window_start = NULL WHERE id = $1`,
      [userId]
    );

    // Send first SMS verification
    var rateLimitUser = (await pool.query(
      'SELECT phone_otp_attempts, phone_otp_window_start FROM users WHERE id = $1', [userId]
    )).rows[0];

    var windowStart = rateLimitUser.phone_otp_window_start ? new Date(rateLimitUser.phone_otp_window_start) : null;
    var windowOpen = windowStart && (Date.now() - windowStart.getTime()) < 3600000;
    if (windowOpen && (rateLimitUser.phone_otp_attempts || 0) >= 3) {
      return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
    }

    var attempts = (windowOpen) ? (rateLimitUser.phone_otp_attempts || 0) + 1 : 1;
    await pool.query(
      `UPDATE users SET phone_otp_attempts = $2,
          phone_otp_window_start = CASE WHEN $3 THEN phone_otp_window_start ELSE NOW() END
       WHERE id = $1`,
      [userId, attempts, !!(windowOpen)]
    );

    var result = await sendVerification(normalized);

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to send SMS. Please check your phone number.' });
    }

    res.json({
      ok: true,
      message: 'Verification code sent to ' + normalized + '.',
      stub: result.stub || false
    });
  } catch(e) {
    console.error('[SMS] set-phone error:', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

smsRouter.post('/send', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;

    var user = (await pool.query(
      'SELECT verified_phone, phone_otp_attempts, phone_otp_window_start FROM users WHERE id = $1', [userId]
    )).rows[0];

    if (!user || !user.verified_phone) {
      return res.status(400).json({ error: 'No phone number set. Call /api/sms-verify/set-phone first.' });
    }

    // Rate limit: max 3 sends per hour
    var windowStart = user.phone_otp_window_start ? new Date(user.phone_otp_window_start) : null;
    var windowOpen = windowStart && (Date.now() - windowStart.getTime()) < 3600000;
    if (windowOpen && (user.phone_otp_attempts || 0) >= 3) {
      return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
    }

    var attempts = (windowOpen) ? (user.phone_otp_attempts || 0) + 1 : 1;
    await pool.query(
      `UPDATE users SET phone_otp_attempts = $2,
          phone_otp_window_start = CASE WHEN $3 THEN phone_otp_window_start ELSE NOW() END
       WHERE id = $1`,
      [userId, attempts, !!(windowOpen)]
    );

    var result = await sendVerification(user.verified_phone);

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to send verification code.' });
    }

    res.json({ ok: true, message: 'Code resent to ' + user.verified_phone + '.' });
  } catch(e) {
    console.error('[SMS] send error:', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

smsRouter.post('/confirm', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;
    var { code, phone } = req.body;

    if (!code || code.trim().length !== 6) {
      return res.status(400).json({ error: 'Enter the 6-digit verification code.' });
    }

    // Use provided phone or fall back to stored verified_phone
    var phoneToVerify = (phone && phone.trim()) ? phone.trim().replace(/[\t ]+/g, '') : null;

    var user = (await pool.query(
      'SELECT verified_phone FROM users WHERE id = $1', [userId]
    )).rows[0];

    if (!phoneToVerify && !user.verified_phone) {
      return res.status(400).json({ error: 'No phone number on file. Call /api/sms-verify/set-phone first.' });
    }

    var targetPhone = phoneToVerify || user.verified_phone;

    var result = await checkVerification(targetPhone, code.trim());

    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Incorrect verification code.' });
    }

    // Mark phone verified
    await pool.query(
      `UPDATE users SET phone_verified_at = NOW(),
          verified_phone = $2,
          phone_otp = NULL, phone_otp_expires_at = NULL,
          updated_at = NOW() WHERE id = $1`,
      [userId, targetPhone]
    );

    res.json({ ok: true });
  } catch(e) {
    console.error('[SMS] confirm error:', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

router.post('/complete', requireAuth, async (req, res) => {
  try {
    var userId = req.userId;
    var user = (await pool.query(
      `SELECT declaration_accepted_at, phone_verified_at, ai_guided_setup, phase_zero_completed_at,
              ai_setup_answers
       FROM users WHERE id = $1`,
      [userId]
    )).rows[0];

    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.phase_zero_completed_at) {
      return res.json({ ok: true, already_complete: true, ai_guided: user.ai_guided_setup });
    }
    if (!user.declaration_accepted_at) {
      return res.status(400).json({ error: 'Declaration not yet accepted.' });
    }
    if (!user.phone_verified_at) {
      return res.status(400).json({ error: 'Phone not yet verified.' });
    }

    // Ensure six FACTS categories + permanent/user allocations exist before audit starts.
    var percentages = null;
    try {
      var answers = user.ai_setup_answers;
      if (typeof answers === 'string') {
        try { answers = JSON.parse(answers); } catch (e) { answers = null; }
      }
      if (answers && answers.allocations && typeof answers.allocations === 'object') {
        percentages = answers.allocations;
      }
    } catch (e) { /* use defaults */ }

    try {
      await ensureDefaultFactsSetup(userId, {
        percentages: percentages || undefined,
        forceUserColumns: true
      });
    } catch (seedErr) {
      console.error('[PhaseZero] ensureDefaultFactsSetup failed:', seedErr.message);
      return res.status(500).json({ error: 'Failed to initialize default allocations.' });
    }

    // Mark complete, start audit
    await pool.query(
      `UPDATE users SET
          phase_zero_completed_at = NOW(),
          audit_status = 'in_progress',
          audit_start_date = NOW(),
          audit_day_count = 0,
          audit_last_activity_date = NULL,
          updated_at = NOW()
       WHERE id = $1`, [userId]
    );

    // Clear session cache so gate re-checks
    req.session.pzComplete = true;

    // Award 100 XP for Phase Zero completion
    await pzAwardXp(userId, 'phase_zero_complete', 'Phase Zero Complete — 100 XP', 100);

    // Award 25 bonus wallet points for AI-guided path
    if (user.ai_guided_setup) {
      await pzAwardWalletPoints(userId, 25, 'phase_zero_ai_bonus', 'Phase Zero AI-Guided Setup Bonus — 25 Points');
    }

    // Log rewards for retroactive application
    await pzLogReward(userId, 'phase_zero_complete', 100, user.ai_guided_setup ? 25 : 0,
      { source: 'phase_zero_complete', ai_guided: user.ai_guided_setup });

    // Partner milestone: referred user finished Phase Zero / bucket setup
    try {
      const { recordAffiliateMilestone } = require('../modules/mod_affiliate/milestones');
      await recordAffiliateMilestone(pool, userId, 'bucket_setup_complete');
    } catch (affErr) {
      console.warn('[PhaseZero] affiliate milestone:', affErr.message);
    }

    res.json({ ok: true, ai_guided: !!user.ai_guided_setup });
  } catch(e) {
    console.error('[PhaseZero] complete error:', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

module.exports = {
  router,
  emailRouter,
  smsRouter,
  pageRouter,
  applyPhaseZeroGates,
  bindPhaseZeroRuntime,
  pzAwardXp,
  pzAwardWalletPoints,
  buildAllocationSuggestion
};
