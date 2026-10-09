// mod_pz_deadline — Phase Zero 7-Day Deadline + 30-Day Lockout System
//
// Owns: phase_zero_started_at, pz_deadline_lockout_until, pz_deadline_locked_at
//       columns on users; pz_lockout_overrides table.
//
// Does NOT own: Phase Zero completion flow, audit system, gamification rewards,
//               session management, or the phaseZeroGate middleware.
//
// Exports:
//   routes       — Express router mounted at /api/mod_pz_deadline by module-loader
//   metadata     — module descriptor
//   healthCheck  — standard module health check
//   applyDeadlineLockoutMiddleware(app, pool) — installs the global lockout gate
//   runDeadlineSweep(pool) — daily cron logic
//   deadlineInfo(started_at) — pure helper: computes deadline state

'use strict';

const express = require('express');
const { Pool } = require('pg');

const router = express.Router();

const DEADLINE_DAYS = 7;
const LOCKOUT_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ─── DB Pool (lazy-init, mirrors mod_analytics pattern) ───────────────────────
let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deadlineInfo(phase_zero_started_at) {
  if (!phase_zero_started_at) return null;
  const startMs = new Date(phase_zero_started_at).getTime();
  const deadlineMs = startMs + DEADLINE_DAYS * MS_PER_DAY;
  const nowMs = Date.now();
  const msLeft = deadlineMs - nowMs;
  const daysLeft = Math.max(0, Math.ceil(msLeft / MS_PER_DAY));
  const hoursLeft = Math.max(0, Math.floor(msLeft / (60 * 60 * 1000)));
  const expired = msLeft <= 0;
  return {
    started_at: phase_zero_started_at,
    deadline_at: new Date(deadlineMs).toISOString(),
    days_left: daysLeft,
    hours_left: hoursLeft,
    expired
  };
}

function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || 'chris.finrev@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

function getOwnerEmails() {
  return (process.env.OWNER_EMAILS || process.env.FUTURE_GEN_EMAILS || 'ecci2760@gmail.com,ecci2760f@gmail.com,dianes3cps@gmail.com')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}

function getCreatorEmail() {
  return (process.env.CREATOR_EMAIL || '').toLowerCase();
}

function isBypassEmail(email) {
  const e = (email || '').toLowerCase();
  return e === getCreatorEmail() || getAdminEmails().includes(e) || getOwnerEmails().includes(e);
}

// ─── Middleware: Deadline Lockout Gate ───────────────────────────────────────
// Call BEFORE phaseZeroGate. Redirects locked users to /lockout.
// API requests get a 403 JSON. Expires naturally after 30 days.

function applyDeadlineLockoutMiddleware(app, pool) {
  const BYPASS_PATHS = [
    '/', '/index.html', '/login', '/login.html', '/signup', '/signup.html',
    '/admin', '/admin.html',
    '/phase-zero', '/phase-zero.html', '/lockout', '/lockout.html',
    '/forgot-password', '/forgot-password.html',
    '/reset-password', '/reset-password.html',
    '/health', '/terms-of-service', '/terms-of-service.html',
    '/privacy-policy', '/privacy-policy.html',
    '/settings', '/settings.html',
    '/compliance-disclaimer.js', '/phase-zero-widget.js',
    '/legal-disclaimer.js'
  ];
  const EXT_RE = /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|webp|map|json|txt|xml)$/i;

  app.use(function pzDeadlineLockoutGate(req, res, next) {
    if (EXT_RE.test(req.path)) return next();
    if (BYPASS_PATHS.indexOf(req.path) !== -1) return next();
    if (!req.session || !req.session.userId) return next();

    var email = (req.session.email || '').toLowerCase();
    if (isBypassEmail(email)) return next();

    pool.query(
      'SELECT pz_deadline_lockout_until, phase_zero_completed_at FROM users WHERE id = $1',
      [req.session.userId]
    ).then(function(r) {
      var u = r.rows[0];
      if (!u) return next();
      // No lockout active
      if (!u.pz_deadline_lockout_until) return next();
      // Phase Zero already completed — lockout irrelevant
      if (u.phase_zero_completed_at) return next();

      var lockoutUntil = new Date(u.pz_deadline_lockout_until);
      var now = new Date();

      if (lockoutUntil <= now) {
        // Lockout expired — clear it, reset 7-day timer so user can resume
        pool.query(
          `UPDATE users SET pz_deadline_lockout_until = NULL, pz_deadline_locked_at = NULL,
           phase_zero_started_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [req.session.userId]
        ).catch(function() {});
        return next();
      }

      // User is still locked out
      if (req.path.startsWith('/api/')) {
        return res.status(403).json({
          error: 'Account locked. Complete Phase Zero within 7 days to avoid lockout.',
          lockout_until: lockoutUntil.toISOString(),
          return_date: lockoutUntil.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
          code: 'PZ_DEADLINE_LOCKED'
        });
      }
      return res.redirect('/lockout');
    }).catch(function() { next(); });
  });
}

// ─── Cron: Daily Deadline Sweep ───────────────────────────────────────────────
// Finds users whose 7-day Phase Zero window has expired and locks them for 30 days.
// Run this daily (e.g., from server.js cron or /api/internal/audit-sweep companion).

async function runDeadlineSweep(pool) {
  var now = new Date();
  try {
    var r = await pool.query(`
      SELECT id, email, phase_zero_started_at
      FROM users
      WHERE phase_zero_started_at IS NOT NULL
        AND phase_zero_completed_at IS NULL
        AND pz_deadline_lockout_until IS NULL
        AND phase_zero_started_at < NOW() - INTERVAL '7 days'
        AND is_creator = false
    `);

    if (r.rows.length === 0) return { locked: 0 };

    var lockoutUntil = new Date(now.getTime() + LOCKOUT_DAYS * MS_PER_DAY).toISOString();

    for (var i = 0; i < r.rows.length; i++) {
      var user = r.rows[i];
      await pool.query(
        `UPDATE users SET
           pz_deadline_lockout_until = $1,
           pz_deadline_locked_at = NOW(),
           updated_at = NOW()
         WHERE id = $2`,
        [lockoutUntil, user.id]
      );
    }

    console.log('[PZDeadline] Sweep: locked ' + r.rows.length + ' users for failing 7-day Phase Zero deadline');
    return { locked: r.rows.length, users: r.rows.map(function(u) { return u.email; }) };
  } catch (err) {
    console.error('[PZDeadline] Sweep error:', err.message);
    return { locked: 0, error: err.message };
  }
}

// ─── Auth middleware (local) ───────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.userId = req.session.userId;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  var email = (req.session.email || '').toLowerCase();
  if (!getAdminEmails().includes(email) && email !== getCreatorEmail()) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  req.userId = req.session.userId;
  next();
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/mod_pz_deadline/status — Current user's deadline/lockout state
router.get('/status', requireAuth, async function(req, res) {
  try {
    var pool = getPool();
    var r = await pool.query(
      `SELECT phase_zero_started_at, pz_deadline_lockout_until, pz_deadline_locked_at,
              phase_zero_completed_at
       FROM users WHERE id = $1`,
      [req.session.userId]
    );
    var u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });

    var info = deadlineInfo(u.phase_zero_started_at);
    var isLocked = !!(u.pz_deadline_lockout_until && new Date(u.pz_deadline_lockout_until) > new Date());

    res.json({
      completed: !!u.phase_zero_completed_at,
      started_at: u.phase_zero_started_at,
      deadline_info: info,
      is_locked: isLocked,
      lockout_until: u.pz_deadline_lockout_until || null,
      locked_at: u.pz_deadline_locked_at || null
    });
  } catch (err) {
    console.error('[PZDeadline] /status error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/mod_pz_deadline/admin/override — Lift lockout, reset 7-day timer
router.post('/admin/override', requireAdmin, async function(req, res) {
  var { userId, notes } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    var pool = getPool();
    var r = await pool.query(
      `SELECT pz_deadline_lockout_until, pz_deadline_locked_at, phase_zero_started_at, phase_zero_completed_at
       FROM users WHERE id = $1`,
      [userId]
    );
    var u = r.rows[0];
    if (!u) return res.status(404).json({ error: 'User not found' });

    var daysRemainingAtOverride = null;
    var priorState = 'no_lockout';
    if (u.pz_deadline_lockout_until) {
      var msLeft = new Date(u.pz_deadline_lockout_until).getTime() - Date.now();
      daysRemainingAtOverride = Math.max(0, Math.ceil(msLeft / MS_PER_DAY));
      priorState = 'deadline_locked';
    } else if (u.phase_zero_started_at && !u.phase_zero_completed_at) {
      priorState = 'deadline_active';
    }

    var adminEmail = (req.session.email || '').toLowerCase();

    // Lift lockout + give fresh 7-day window
    await pool.query(
      `UPDATE users SET
         pz_deadline_lockout_until = NULL,
         pz_deadline_locked_at = NULL,
         phase_zero_started_at = NOW(),
         updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );

    // Log override for audit trail
    await pool.query(
      `INSERT INTO pz_lockout_overrides
         (user_id, admin_email, overridden_at, days_remaining_at_override, prior_state, notes)
       VALUES ($1, $2, NOW(), $3, $4, $5)`,
      [userId, adminEmail, daysRemainingAtOverride, priorState, notes || null]
    );

    res.json({
      success: true,
      message: 'Lockout lifted. User has a fresh 7-day window to complete Phase Zero.',
      prior_state: priorState,
      days_remaining_at_override: daysRemainingAtOverride
    });
  } catch (err) {
    console.error('[PZDeadline] Admin override error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/mod_pz_deadline/admin/users — All users' deadline status (admin only)
router.get('/admin/users', requireAdmin, async function(req, res) {
  try {
    var pool = getPool();
    var r = await pool.query(
      `SELECT u.id, u.email, u.name,
              u.phase_zero_started_at, u.pz_deadline_lockout_until, u.pz_deadline_locked_at,
              u.phase_zero_completed_at, u.declaration_accepted_at,
              (SELECT COUNT(*) FROM pz_lockout_overrides o WHERE o.user_id = u.id) AS override_count
       FROM users u
       WHERE u.is_creator = false
       ORDER BY u.created_at DESC
       LIMIT 200`
    );

    var users = r.rows.map(function(u) {
      var info = deadlineInfo(u.phase_zero_started_at);
      var isLocked = !!(u.pz_deadline_lockout_until && new Date(u.pz_deadline_lockout_until) > new Date());
      return Object.assign({}, u, { deadline_info: info, is_locked: isLocked });
    });

    res.json({ success: true, users: users });
  } catch (err) {
    console.error('[PZDeadline] Admin users error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/mod_pz_deadline/admin/overrides — Override log (admin only)
router.get('/admin/overrides', requireAdmin, async function(req, res) {
  try {
    var pool = getPool();
    var r = await pool.query(
      `SELECT o.id, o.admin_email, o.overridden_at, o.days_remaining_at_override,
              o.prior_state, o.notes, u.email AS user_email, u.name AS user_name
       FROM pz_lockout_overrides o
       JOIN users u ON u.id = o.user_id
       ORDER BY o.overridden_at DESC
       LIMIT 100`
    );
    res.json({ success: true, overrides: r.rows });
  } catch (err) {
    console.error('[PZDeadline] Admin overrides error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/mod_pz_deadline/internal/sweep — Manual trigger (internal secret)
router.post('/internal/sweep', async function(req, res) {
  var secret = req.headers['x-internal-secret'];
  if (!secret || secret !== process.env.INTERNAL_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  var pool = getPool();
  var result = await runDeadlineSweep(pool);
  res.json({ success: true, result: result });
});

// ─── Module exports ──────────────────────────────────────────────────────────

module.exports = {
  metadata: {
    name: 'Phase Zero Deadline & Lockout',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true
  },

  routes: router,

  healthCheck: async function() {
    return {
      module: 'mod_pz_deadline',
      status: 'ok',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    };
  },

  // Exported for server.js to call during initialization
  applyDeadlineLockoutMiddleware: applyDeadlineLockoutMiddleware,
  runDeadlineSweep: runDeadlineSweep,
  deadlineInfo: deadlineInfo
};
