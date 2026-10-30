#!/usr/bin/env node
'use strict';

/**
 * Vault eligibility API: GET /api/vault/eligibility/:userId
 * Scenario A = 10-week Friday Sweep streak (locked)
 * Scenario B = 12-week streak (Elite unlock)
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const STAGING_ENV = path.join(__dirname, '..', '.env.staging');
const BASE = process.env.VAULT_API_BASE || 'http://127.0.0.1:3010';
const TEST_USER_ID = 17;
const API_USER_ID = 'user_staging_17';

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

async function api(urlPath) {
  const res = await fetch(BASE + urlPath, {
    headers: { 'x-internal': 'vault-eligibility-e2e' }
  });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* keep */ }
  return { status: res.status, data };
}

async function setStreak(pool, weeks) {
  await pool.query(
    `INSERT INTO mod_rewards.user_wallet (user_id, current_streak, longest_streak)
     VALUES ($1, $2, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET current_streak = $2,
           longest_streak = GREATEST(mod_rewards.user_wallet.longest_streak, $2),
           updated_at = NOW()`,
    [TEST_USER_ID, weeks]
  );
}

async function main() {
  loadStagingEnv();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
  }

  try {
    console.log('==================================================');
    console.log(' VAULT ELIGIBILITY API SIMULATION TEST            ');
    console.log('==================================================');
    console.log('BASE=' + BASE);

    const exists = await pool.query('SELECT id FROM users WHERE id = $1', [TEST_USER_ID]);
    if (!exists.rows[0]) throw new Error('staging user 17 missing — run test-gamification-engine.js first');

    console.log('\n[Scenario A] User has a 10-week Friday Sweep streak:');
    await setStreak(pool, 10);
    const result10 = await api('/api/vault/eligibility/' + API_USER_ID);
    console.log(JSON.stringify(result10.data, null, 2));
    record('10-week streak locked',
      result10.status === 200 &&
      result10.data &&
      result10.data.eligible === false &&
      result10.data.tier === 'Individual / Locked' &&
      result10.data.streakWeeks === 10 &&
      result10.data.requiredWeeks === 12 &&
      result10.data.unlockCost == null &&
      result10.data.userId === TEST_USER_ID,
      'status=' + result10.status);

    console.log('\n[Scenario B] User crosses the threshold to a 12-week streak:');
    await setStreak(pool, 12);
    const result12 = await api('/api/vault/eligibility/' + API_USER_ID);
    console.log(JSON.stringify(result12.data, null, 2));
    record('12-week streak Elite unlock',
      result12.status === 200 &&
      result12.data &&
      result12.data.eligible === true &&
      result12.data.tier === 'Elite (Levels 7-9)' &&
      result12.data.streakWeeks === 12 &&
      result12.data.requiredWeeks === 24 &&
      result12.data.unlockCost === '$29/mo',
      'status=' + result12.status);

    const unauth = await fetch(BASE + '/api/vault/eligibility/' + TEST_USER_ID);
    record('unauthenticated eligibility is 401', unauth.status === 401, 'status=' + unauth.status);
  } catch (err) {
    record('harness', false, err.message);
  } finally {
    await pool.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n==================================================');
  console.log(' ELIGIBILITY TEST COMPLETE: ' + (failed.length ? 'FAILED' : 'BEHAVIORAL GATES PASSED'));
  console.log('==================================================');
  console.log((results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Vault eligibility test error:', err.message || err);
  process.exit(1);
});
