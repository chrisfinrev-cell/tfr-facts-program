#!/usr/bin/env node
'use strict';

/**
 * Staging auth + API routing check.
 * Requires the app already listening (default http://127.0.0.1:3010).
 * Loads DATABASE_URL from .env.staging to set a password on the synthetic seed user.
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.STAGING_API_BASE || 'http://127.0.0.1:3010';
const EMAIL = 'staging.engine.seed+sponsor@facts-staging.test';
const PASSWORD = process.env.STAGING_TEST_PASSWORD || 'StagingEngineTest!2026';

function loadStagingEnv() {
  const envPath = path.join(__dirname, '..', '.env.staging');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
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

class CookieJar {
  constructor() { this.cookies = {}; }
  ingest(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
    for (const header of raw) {
      const pair = header.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      this.cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }
  header() {
    return Object.entries(this.cookies).map(([k, v]) => k + '=' + v).join('; ');
  }
}

async function api(method, urlPath, body, jar) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar && jar.header()) headers.Cookie = jar.header();
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined
  });
  if (jar) jar.ingest(res);
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* keep text */ }
  return { status: res.status, data, text };
}

function summarize(data) {
  if (data == null) return '(empty)';
  if (typeof data === 'string') return data.slice(0, 180);
  const copy = Array.isArray(data) ? { type: 'array', length: data.length, sample: data[0] } : data;
  return JSON.stringify(copy, null, 0).slice(0, 400);
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
    const hash = await bcrypt.hash(PASSWORD, 10);
    const upd = await pool.query(
      `UPDATE users SET password_hash = $1, two_factor_enabled = false
        WHERE LOWER(email) = LOWER($2)
        RETURNING id, email`,
      [hash, EMAIL]
    );
    if (!upd.rows[0]) throw new Error('seed sponsor user not found — run scripts/seed-staging-engine.js first');
    record('staging users row for login', true, 'id=' + upd.rows[0].id);

    const lookup = await pool.query(
      `SELECT id, email, password_hash IS NOT NULL AS has_password
         FROM users
        WHERE LOWER(email) = $1 OR LOWER(user_id) = $1`,
      [EMAIL.toLowerCase()]
    );
    record('login SELECT against users', lookup.rows.length === 1 && lookup.rows[0].has_password,
      'rows=' + lookup.rows.length);

    const jar = new CookieJar();

    const health = await api('GET', '/health');
    record('GET /health', health.status === 200 && health.data && health.data.status === 'ok',
      'status=' + health.status + ' ' + summarize(health.data));

    const unauthDash = await api('GET', '/api/mod_sweep/bucket-dashboard');
    record('GET /api/mod_sweep/bucket-dashboard unauthenticated', unauthDash.status === 401,
      'status=' + unauthDash.status + ' ' + summarize(unauthDash.data));

    const unauthTxn = await api('GET', '/api/transactions');
    record('GET /api/transactions unauthenticated', unauthTxn.status === 401,
      'status=' + unauthTxn.status);

    const badLogin = await api('POST', '/api/auth/login', { email: EMAIL, password: 'wrong-password' }, new CookieJar());
    record('POST /api/auth/login invalid password', badLogin.status === 401,
      'status=' + badLogin.status + ' ' + summarize(badLogin.data));

    const login = await api('POST', '/api/auth/login', { email: EMAIL, password: PASSWORD }, jar);
    const loginOk = login.status === 200 && login.data && login.data.success === true && !!jar.header();
    record('POST /api/auth/login', loginOk,
      'status=' + login.status + ' cookies=' + Object.keys(jar.cookies).join(',') + ' ' + summarize(login.data));

    const me = await api('GET', '/api/auth/me', null, jar);
    const meOk = me.status === 200 && me.data && me.data.authenticated === true && me.data.user && me.data.user.email === EMAIL;
    record('GET /api/auth/me session', meOk,
      'status=' + me.status + ' ' + summarize(me.data && me.data.user ? { authenticated: me.data.authenticated, id: me.data.user.id, email: me.data.user.email } : me.data));

    const dash = await api('GET', '/api/mod_sweep/bucket-dashboard', null, jar);
    const dashOk = dash.status === 200 && dash.data && dash.data.buckets &&
      dash.data.buckets.necessities && Number.isInteger(dash.data.buckets.necessities.deposited_cents);
    record('GET /api/mod_sweep/bucket-dashboard', dashOk,
      'status=' + dash.status + ' ' + summarize(dash.data && dash.data.buckets ? dash.data.buckets : dash.data));

    const txns = await api('GET', '/api/transactions', null, jar);
    record('GET /api/transactions',
      txns.status === 200 && Array.isArray(txns.data) &&
        txns.data.every((t) => Number.isInteger(t.amount_cents) && t.occurred_at),
      'status=' + txns.status + ' ' + summarize(txns.data));

    const postTxn = await api('POST', '/api/transactions', {
      type: 'income',
      amount_cents: 2500,
      description: 'Staging API routing probe'
    }, jar);
    record('POST /api/transactions',
      postTxn.status === 201 && postTxn.data && postTxn.data.amount_cents === 2500 && postTxn.data.occurred_at,
      'status=' + postTxn.status + ' ' + summarize(postTxn.data));

    const engineHealth = await api('GET', '/api/mod_income/health');
    record('GET /api/mod_income/health (actual mount)', engineHealth.status === 200,
      'status=' + engineHealth.status + ' ' + summarize(engineHealth.data));

    const engineAlias = await api('GET', '/api/engine/health');
    record('GET /api/engine/health (documented alias)', engineAlias.status === 200,
      'status=' + engineAlias.status + ' ' + summarize(engineAlias.data));

    const sweepHealth = await api('GET', '/api/mod_sweep/health');
    record('GET /api/mod_sweep/health', sweepHealth.status === 200,
      'status=' + sweepHealth.status + ' ' + summarize(sweepHealth.data));

    const aff = await api('GET', '/api/mod_affiliate/activation-status');
    record('GET /api/mod_affiliate/activation-status', aff.status === 200 && aff.data && typeof aff.data.ready === 'boolean',
      'status=' + aff.status + ' ' + summarize(aff.data));

    const modules = await api('GET', '/api/system/health/modules');
    record('GET /api/system/health/modules', modules.status === 200,
      'status=' + modules.status + ' ' + summarize(modules.data));
  } catch (err) {
    record('harness', false, err.message);
  } finally {
    await pool.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exitCode = 1;
}

main();
