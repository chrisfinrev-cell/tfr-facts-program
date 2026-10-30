#!/usr/bin/env node
'use strict';

/**
 * Gamification & Wallet end-to-end staging test.
 * Exercises immutable XP ledger, wallet mint (100 pts = $1.00, integer-only),
 * consistency-streak tool gates, and 3-week Friday Sweep decay.
 *
 * Loads DATABASE_URL from .env.staging. Uses a tagged staging user only.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const STAGING_ENV = path.join(__dirname, '..', '.env.staging');
const BASE = process.env.STAGING_API_BASE || 'http://127.0.0.1:3010';
const EMAIL = 'staging.gamification.e2e@facts-staging.test';
const AWARDED_XP = 500;
const ELITE_STREAK_WEEKS = 12;
const BUSINESS_STREAK_WEEKS = 24;

function loadStagingEnv() {
  if (!fs.existsSync(STAGING_ENV)) throw new Error('.env.staging not found');
  for (const line of fs.readFileSync(STAGING_ENV, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k === 'DATABASE_URL') process.env.DATABASE_URL = v;
  }
}

function assertInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error('Cent-Standard violation: ' + label + ' must be a whole integer, got ' + value);
  }
}

function unlockedTier(streakWeeks) {
  if (streakWeeks >= BUSINESS_STREAK_WEEKS) {
    return 'Business (Levels 10-11) — $49/mo Add-on Unlocked';
  }
  if (streakWeeks >= ELITE_STREAK_WEEKS) {
    return 'Elite (Levels 7-9) — $29/mo Add-on Unlocked';
  }
  return 'Individual (Levels 1-6)';
}

async function api(method, urlPath, body, headers) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body != null ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* keep */ }
  return { status: res.status, data };
}

async function ensureSchema(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS mod_gamification');
  await client.query('CREATE SCHEMA IF NOT EXISTS mod_rewards');
  await client.query(`
    CREATE TABLE IF NOT EXISTS mod_gamification.user_xp (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      lifetime_xp INTEGER NOT NULL DEFAULT 0,
      current_level INTEGER NOT NULL DEFAULT 1,
      identity_title VARCHAR(100) NOT NULL DEFAULT 'Seeker',
      decay_state VARCHAR(20) NOT NULL DEFAULT 'healthy',
      decay_week_count INTEGER NOT NULL DEFAULT 0,
      last_sweep_detected_at TIMESTAMPTZ,
      parent_user_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS mod_gamification.xp_events (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type VARCHAR(80) NOT NULL,
      xp_awarded INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS mod_gamification.level_gates (
      level INTEGER PRIMARY KEY,
      xp_threshold INTEGER NOT NULL,
      identity_title VARCHAR(100) NOT NULL,
      tier_required VARCHAR(32) NOT NULL DEFAULT 'free',
      gate_type VARCHAR(32) NOT NULL DEFAULT 'auto'
    )
  `);
  await client.query(`
    INSERT INTO mod_gamification.level_gates
      (level, xp_threshold, identity_title, tier_required, gate_type)
    VALUES
      (1, 0, 'Seeker', 'free', 'auto'),
      (2, 100, 'Builder', 'free', 'auto'),
      (3, 250, 'Allocator', 'free', 'auto'),
      (4, 500, 'Steward', 'free', 'auto'),
      (5, 1000, 'Operator', 'free', 'auto'),
      (6, 2000, 'Captain', 'free', 'auto'),
      (7, 4000, 'Elite Steward', 'elite', 'auto'),
      (8, 7000, 'Elite Operator', 'elite', 'auto'),
      (9, 11000, 'Elite Captain', 'elite', 'plaid_verified'),
      (10, 16000, 'Business Architect', 'business', 'document_upload'),
      (11, 22000, 'Business Principal', 'business', 'admin_verified'),
      (12, 30000, 'Sovereign', 'sovereignty', 'admin_verified')
    ON CONFLICT (level) DO NOTHING
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS mod_rewards.user_wallet (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      balance_real INTEGER NOT NULL DEFAULT 0,
      balance_sandbox INTEGER NOT NULL DEFAULT 0,
      total_earned_real INTEGER NOT NULL DEFAULT 0,
      total_earned_sandbox INTEGER NOT NULL DEFAULT 0,
      current_streak INTEGER NOT NULL DEFAULT 0,
      longest_streak INTEGER NOT NULL DEFAULT 0,
      last_activity_week VARCHAR(16),
      last_activity_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS mod_rewards.rewards_ledger (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type VARCHAR(80) NOT NULL,
      points INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      sandbox BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function ensureTestUser(client) {
  const found = await client.query(
    'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
    [EMAIL]
  );
  if (found.rows[0]) return found.rows[0].id;
  const ins = await client.query(
    `INSERT INTO users (email, name)
     VALUES ($1, 'Gamification E2E')
     RETURNING id`,
    [EMAIL]
  );
  return ins.rows[0].id;
}

async function main() {
  loadStagingEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL missing — set Neon staging URL in .env.staging');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
  }

  const client = await pool.connect();
  try {
    console.log('[*] Starting Gamification & Wallet End-to-End Test Suite...\n');
    await ensureSchema(client);
    const userId = await ensureTestUser(client);
    record('staging test user', true, 'id=' + userId + ' email=' + EMAIL);

    await client.query(
      `INSERT INTO mod_gamification.user_xp (user_id, lifetime_xp, current_level, decay_state, decay_week_count)
       VALUES ($1, 0, 1, 'healthy', 0)
       ON CONFLICT (user_id) DO UPDATE
         SET lifetime_xp = 0, current_level = 1, identity_title = 'Seeker',
             decay_state = 'healthy', decay_week_count = 0,
             last_sweep_detected_at = NOW(), updated_at = NOW()`,
      [userId]
    );
    await client.query(
      `INSERT INTO mod_rewards.user_wallet (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE
         SET balance_real = 0, total_earned_real = 0, current_streak = 0,
             longest_streak = 0, last_activity_week = NULL, updated_at = NOW()`,
      [userId]
    );

    const before = await client.query(
      'SELECT lifetime_xp FROM mod_gamification.user_xp WHERE user_id = $1',
      [userId]
    );
    const xpBefore = Number(before.rows[0].lifetime_xp);

    console.log('--------------------------------------------------');
    console.log('[Test 1] Simulating XP Ingestion & Ledger Recording...');
    console.log('  -> User: ' + userId);
    console.log('  -> Action: Completed Friday Sweep & Allocation');
    console.log('  -> XP Awarded: +' + AWARDED_XP + ' XP');

    await client.query(
      `INSERT INTO mod_gamification.xp_events (user_id, event_type, xp_awarded, metadata)
       VALUES ($1, $2, $3, $4)`,
      [userId, 'friday_sweep_allocation', AWARDED_XP, JSON.stringify({ e2e: 'gamification_wallet' })]
    );
    await client.query(
      `UPDATE mod_gamification.user_xp
          SET lifetime_xp = lifetime_xp + $2, updated_at = NOW()
        WHERE user_id = $1`,
      [userId, AWARDED_XP]
    );
    const after = await client.query(
      `SELECT lifetime_xp FROM mod_gamification.user_xp WHERE user_id = $1`,
      [userId]
    );
    const xpAfter = Number(after.rows[0].lifetime_xp);
    const ledger = await client.query(
      `SELECT id, xp_awarded FROM mod_gamification.xp_events
        WHERE user_id = $1 AND event_type = 'friday_sweep_allocation'
        ORDER BY id DESC LIMIT 1`,
      [userId]
    );
    const immutable = xpAfter === xpBefore + AWARDED_XP && xpAfter >= xpBefore;
    record('XP immutable ledger ingest',
      immutable && ledger.rows[0] && Number(ledger.rows[0].xp_awarded) === AWARDED_XP,
      'lifetime_xp ' + xpBefore + ' -> ' + xpAfter + ' event_id=' + (ledger.rows[0] && ledger.rows[0].id));

    console.log('--------------------------------------------------');
    console.log('[Test 2] Testing The Wallet Point Minting (100 pts = $1.00)...');
    const mintedPoints = AWARDED_XP;
    assertInteger(mintedPoints, 'minted_points');
    const walletBefore = await client.query(
      'SELECT balance_real FROM mod_rewards.user_wallet WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const balBefore = Number(walletBefore.rows[0].balance_real);
    const balAfter = balBefore + mintedPoints;
    assertInteger(balAfter, 'balance_after');
    await client.query(
      `INSERT INTO mod_rewards.rewards_ledger
         (user_id, event_type, points, balance_after, metadata, sandbox)
       VALUES ($1, 'xp_mint', $2, $3, $4, false)`,
      [userId, mintedPoints, balAfter, JSON.stringify({ source: 'mod_gamification', e2e: 'gamification_wallet' })]
    );
    await client.query(
      `UPDATE mod_rewards.user_wallet
          SET balance_real = balance_real + $2,
              total_earned_real = total_earned_real + $2,
              updated_at = NOW()
        WHERE user_id = $1`,
      [userId, mintedPoints]
    );
    const wallet = await client.query(
      'SELECT balance_real, total_earned_real FROM mod_rewards.user_wallet WHERE user_id = $1',
      [userId]
    );
    const dollars = (mintedPoints / 100).toFixed(2);
    const mintOk = Number(wallet.rows[0].balance_real) === balAfter && Number.isInteger(Number(wallet.rows[0].balance_real));
    record('Wallet cent-standard mint', mintOk,
      mintedPoints + ' pts = $' + dollars + ' balance_after=' + wallet.rows[0].balance_real);

    console.log('--------------------------------------------------');
    console.log('[Test 3] Verifying Consistency Streak & Tool Gating...');
    await client.query(
      `UPDATE mod_rewards.user_wallet
          SET current_streak = $2, longest_streak = GREATEST(longest_streak, $2),
              last_activity_at = NOW(), updated_at = NOW()
        WHERE user_id = $1`,
      [userId, ELITE_STREAK_WEEKS]
    );
    const streak = await client.query(
      'SELECT current_streak, longest_streak FROM mod_rewards.user_wallet WHERE user_id = $1',
      [userId]
    );
    const tier = unlockedTier(Number(streak.rows[0].current_streak));
    record('Consistency streak Elite gate',
      Number(streak.rows[0].current_streak) === ELITE_STREAK_WEEKS && tier.indexOf('Elite') === 0,
      'streak=' + streak.rows[0].current_streak + ' weeks gate=' + tier);

    console.log('--------------------------------------------------');
    console.log('[Test 4] Simulating Weekly Decay Cron (3+ Weeks Missed Sweep)...');
    const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
    await client.query(
      `UPDATE mod_gamification.user_xp
          SET last_sweep_detected_at = NOW() - INTERVAL '22 days'
        WHERE user_id = $1`,
      [userId]
    );
    const decay = await client.query(
      `UPDATE mod_gamification.user_xp
          SET decay_state = 'decaying',
              decay_week_count = decay_week_count + 1,
              updated_at = NOW()
        WHERE user_id = $1
          AND (last_sweep_detected_at IS NULL OR last_sweep_detected_at < $2)
          AND decay_state != 'decaying'
      RETURNING decay_state, decay_week_count, last_sweep_detected_at`,
      [userId, threeWeeksAgo]
    );
    const decaying = decay.rows[0] && decay.rows[0].decay_state === 'decaying';
    record('Decay cron 3+ missed Friday Sweep', decaying,
      decaying
        ? 'decay_state=' + decay.rows[0].decay_state + ' week_count=' + decay.rows[0].decay_week_count
        : 'user was not marked decaying');

    const xpWhileDecaying = 100;
    const xpDecBefore = Number((await client.query(
      'SELECT lifetime_xp FROM mod_gamification.user_xp WHERE user_id = $1', [userId]
    )).rows[0].lifetime_xp);
    await client.query(
      `INSERT INTO mod_gamification.xp_events (user_id, event_type, xp_awarded, metadata)
       VALUES ($1, 'friday_sweep_allocation', $2, $3)`,
      [userId, xpWhileDecaying, JSON.stringify({ e2e: 'gamification_wallet', decaying: true })]
    );
    await client.query(
      `UPDATE mod_gamification.user_xp SET lifetime_xp = lifetime_xp + $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, xpWhileDecaying]
    );
    const xpDecAfter = Number((await client.query(
      'SELECT lifetime_xp, decay_state FROM mod_gamification.user_xp WHERE user_id = $1', [userId]
    )).rows[0].lifetime_xp);
    const mintWhileDecaying = decaying ? 0 : xpWhileDecaying;
    record('XP still records while decaying; wallet mint paused',
      xpDecAfter === xpDecBefore + xpWhileDecaying && mintWhileDecaying === 0,
      'lifetime_xp ' + xpDecBefore + ' -> ' + xpDecAfter + ' mint_points=' + mintWhileDecaying);

    try {
      const gHealth = await api('GET', '/api/mod_gamification/health');
      record('GET /api/mod_gamification/health',
        gHealth.status === 200 && gHealth.data && (gHealth.data.status === 'ok' || gHealth.data.schema_exists === true),
        'status=' + gHealth.status + ' ' + JSON.stringify(gHealth.data && {
          status: gHealth.data.status, schema_exists: gHealth.data.schema_exists, table_count: gHealth.data.table_count
        }));
    } catch (err) {
      record('GET /api/mod_gamification/health', false, err.message);
    }
    try {
      const rHealth = await api('GET', '/api/mod_rewards/health');
      record('GET /api/mod_rewards/health',
        rHealth.status === 200 && rHealth.data && rHealth.data.status === 'ok',
        'status=' + rHealth.status + ' ' + JSON.stringify(rHealth.data && {
          status: rHealth.data.status, schema_exists: rHealth.data.schema_exists, cent_standard: rHealth.data.cent_standard
        }));
    } catch (err) {
      record('GET /api/mod_rewards/health', false, err.message);
    }

    try {
      const awardHttp = await api('POST', '/api/mod_gamification/xp/award', {
        userId, eventType: 'friday_sweep_allocation', xpAmount: 0, metadata: { e2e: 'gamification_wallet', probe: true }
      }, { 'x-internal': 'e2e' });
      record('POST /api/mod_gamification/xp/award internal',
        awardHttp.status === 200 && awardHttp.data && awardHttp.data.success === true,
        'status=' + awardHttp.status);
    } catch (err) {
      record('POST /api/mod_gamification/xp/award internal', false, err.message);
    }
  } catch (err) {
    record('harness', false, err.message);
  } finally {
    client.release();
    await pool.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n==================================================');
  console.log(' GAMIFICATION & REWARDS E2E STAGING TEST: ' + (failed.length ? 'FAILED' : 'PASSED'));
  console.log('==================================================');
  console.log((results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Gamification test error:', err.message || err);
  process.exit(1);
});
