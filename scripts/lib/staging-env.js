'use strict';

/**
 * Shared staging / CI env + Pool helpers for E2E / UAT scripts.
 * Prefer process.env.DATABASE_URL (CI); otherwise load from .env.staging.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const STAGING_ENV = path.join(__dirname, '..', '..', '.env.staging');

const DEFAULT_KEYS = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
  'PLAID_ENV',
  'VAULT_ENCRYPTION_KEY'
];

function loadStagingEnv(extraKeys) {
  if (process.env.DATABASE_URL && !fs.existsSync(STAGING_ENV)) return;

  if (!fs.existsSync(STAGING_ENV)) {
    if (process.env.DATABASE_URL) return;
    throw new Error('.env.staging not found (or set DATABASE_URL for CI)');
  }

  const allow = new Set([...(extraKeys || []), ...DEFAULT_KEYS]);
  for (const line of fs.readFileSync(STAGING_ENV, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    const k = t.slice(0, i).trim();
    if (!allow.has(k)) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function requireDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL missing (.env.staging or CI env)');
  }
  return process.env.DATABASE_URL;
}

function createStagingPool() {
  const url = requireDatabaseUrl();
  const needsSsl = /sslmode=require|neon\.tech|aws\.neon/i.test(url);
  return new Pool({
    connectionString: url,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {})
  });
}

module.exports = {
  STAGING_ENV,
  loadStagingEnv,
  requireDatabaseUrl,
  createStagingPool
};
