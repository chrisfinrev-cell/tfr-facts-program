#!/usr/bin/env node
'use strict';

/**
 * FACTS population simulation (SQLAlchemy port).
 *
 * Writes only to isolated simulation_accounts / simulation_ledger tables.
 * Loads DATABASE_URL from .env.staging (never .env / production).
 *
 * Python source used non-FACTS bucket labels. Columns keep those names;
 * FACTS mapping: necessities, emergency≈reserve, freedom≈velocity,
 * growth, education≈lifestyle, giving≈legacy.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const STAGING_ENV = path.join(__dirname, '..', '.env.staging');
const TOTAL_ACCOUNTS = 150;
const MAX_LEVELS = 10;
const DAYS = 120;
const LEVEL_WEIGHTS = [20, 18, 15, 12, 10, 8, 7, 5, 3, 2];
const LEDGER_BATCH = 1000;

function loadStagingEnv() {
  if (!fs.existsSync(STAGING_ENV)) {
    throw new Error('.env.staging not found');
  }
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

function randomRange(min, max) {
  return Math.random() * (max - min) + min;
}

function randomInt(min, max) {
  return Math.floor(randomRange(min, max + 1));
}

function weightedLevel() {
  const total = LEVEL_WEIGHTS.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < LEVEL_WEIGHTS.length; i++) {
    roll -= LEVEL_WEIGHTS[i];
    if (roll <= 0) return i + 1;
  }
  return MAX_LEVELS;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS simulation_accounts (
      id SERIAL PRIMARY KEY,
      account_identifier VARCHAR(50) UNIQUE NOT NULL,
      account_type VARCHAR(50) NOT NULL,
      affiliation_level INTEGER NOT NULL,
      balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      necessities_bucket NUMERIC(14,2) NOT NULL DEFAULT 0,
      growth_bucket NUMERIC(14,2) NOT NULL DEFAULT 0,
      freedom_bucket NUMERIC(14,2) NOT NULL DEFAULT 0,
      education_bucket NUMERIC(14,2) NOT NULL DEFAULT 0,
      emergency_bucket NUMERIC(14,2) NOT NULL DEFAULT 0,
      giving_bucket NUMERIC(14,2) NOT NULL DEFAULT 0
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS simulation_ledger (
      id SERIAL PRIMARY KEY,
      day INTEGER NOT NULL,
      account_identifier VARCHAR(50) NOT NULL,
      level INTEGER NOT NULL,
      transaction_type VARCHAR(50) NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS simulation_ledger_account_day_idx
      ON simulation_ledger (account_identifier, day)
  `);
}

async function generateAccounts(client) {
  console.log('[*] Initializing ' + TOTAL_ACCOUNTS + ' test accounts (5% children, 10% business, population tiers)...');
  await client.query('TRUNCATE simulation_ledger, simulation_accounts RESTART IDENTITY');

  const childCount = Math.floor(TOTAL_ACCOUNTS * 0.05);
  const businessCount = Math.floor(TOTAL_ACCOUNTS * 0.10);
  const standardCount = TOTAL_ACCOUNTS - childCount - businessCount;
  const rows = [];
  let accountId = 1;

  for (let i = 0; i < businessCount; i++) {
    rows.push(['BUS_' + accountId, 'Business', randomInt(1, 3), 15000]);
    accountId += 1;
  }
  for (let i = 0; i < childCount; i++) {
    rows.push(['CHD_' + accountId, 'Child', randomInt(4, MAX_LEVELS), 200]);
    accountId += 1;
  }
  for (let i = 0; i < standardCount; i++) {
    rows.push(['ACC_' + accountId, 'Standard', weightedLevel(), round2(randomRange(2000, 85000))]);
    accountId += 1;
  }

  const values = [];
  const params = [];
  rows.forEach((row, idx) => {
    const b = idx * 4;
    values.push('($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ')');
    params.push(row[0], row[1], row[2], row[3]);
  });
  await client.query(
    'INSERT INTO simulation_accounts (account_identifier, account_type, affiliation_level, balance) VALUES ' + values.join(','),
    params
  );
  console.log('[+] Successfully inserted ' + rows.length + ' accounts into Neon DB.');
}

async function runSimulation(client) {
  console.log('[*] Running ' + DAYS + '-day simulation cycle (30-minute ratio timeline)...');
  const { rows: accounts } = await client.query(
    `SELECT account_identifier, account_type, affiliation_level,
            balance::float8 AS balance,
            necessities_bucket::float8 AS necessities_bucket,
            growth_bucket::float8 AS growth_bucket,
            freedom_bucket::float8 AS freedom_bucket,
            education_bucket::float8 AS education_bucket,
            emergency_bucket::float8 AS emergency_bucket,
            giving_bucket::float8 AS giving_bucket
       FROM simulation_accounts`
  );

  const ledger = [];
  async function flushLedger() {
    if (!ledger.length) return;
    const values = [];
    const params = [];
    ledger.forEach((row, idx) => {
      const b = idx * 5;
      values.push('($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) + ')');
      params.push(row.day, row.account_identifier, row.level, row.transaction_type, row.amount);
    });
    await client.query(
      'INSERT INTO simulation_ledger (day, account_identifier, level, transaction_type, amount) VALUES ' + values.join(','),
      params
    );
    ledger.length = 0;
  }

  for (let day = 1; day <= DAYS; day++) {
    for (const acc of accounts) {
      let dailyInflow;
      if (acc.account_type === 'Business') dailyInflow = randomRange(500, 2000);
      else if (acc.account_type === 'Child') dailyInflow = randomRange(5, 25);
      else dailyInflow = randomRange(50, 400);

      acc.necessities_bucket += dailyInflow * 0.50;
      acc.growth_bucket += dailyInflow * 0.20;
      acc.freedom_bucket += dailyInflow * 0.10;
      acc.education_bucket += dailyInflow * 0.10;
      acc.emergency_bucket += dailyInflow * 0.05;
      acc.giving_bucket += dailyInflow * 0.05;
      acc.balance += dailyInflow;

      if (acc.affiliation_level < MAX_LEVELS) {
        ledger.push({
          day,
          account_identifier: acc.account_identifier,
          level: acc.affiliation_level,
          transaction_type: 'Affiliate_Payout',
          amount: round2(dailyInflow * 0.01)
        });
      } else {
        ledger.push({
          day,
          account_identifier: acc.account_identifier,
          level: acc.affiliation_level,
          transaction_type: 'Level_10_Cutoff_Logged',
          amount: 0
        });
      }
    }
    if (ledger.length >= LEDGER_BATCH) await flushLedger();
  }
  await flushLedger();

  for (const acc of accounts) {
    await client.query(
      `UPDATE simulation_accounts
          SET balance = $2,
              necessities_bucket = $3,
              growth_bucket = $4,
              freedom_bucket = $5,
              education_bucket = $6,
              emergency_bucket = $7,
              giving_bucket = $8
        WHERE account_identifier = $1`,
      [
        acc.account_identifier,
        round2(acc.balance),
        round2(acc.necessities_bucket),
        round2(acc.growth_bucket),
        round2(acc.freedom_bucket),
        round2(acc.education_bucket),
        round2(acc.emergency_bucket),
        round2(acc.giving_bucket)
      ]
    );
  }
  console.log('[+] Simulation completed successfully across all ' + DAYS + ' simulated days.');
}

async function summarize(client) {
  const { rows: types } = await client.query(
    `SELECT account_type, COUNT(*)::int AS n,
            ROUND(AVG(affiliation_level)::numeric, 2) AS avg_level,
            ROUND(SUM(balance)::numeric, 2) AS total_balance
       FROM simulation_accounts
      GROUP BY account_type
      ORDER BY account_type`
  );
  const { rows: ledger } = await client.query(
    `SELECT transaction_type, COUNT(*)::int AS n, ROUND(SUM(amount)::numeric, 2) AS total
       FROM simulation_ledger
      GROUP BY transaction_type
      ORDER BY transaction_type`
  );
  const { rows: cutoff } = await client.query(
    `SELECT COUNT(*)::int AS level10_accounts
       FROM simulation_accounts WHERE affiliation_level = 10`
  );
  console.log('[summary] accounts', JSON.stringify(types));
  console.log('[summary] ledger', JSON.stringify(ledger));
  console.log('[summary] level_10_accounts=' + cutoff[0].level10_accounts);
}

async function main() {
  loadStagingEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is missing. Set the Neon staging connection string in .env.staging.');
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSchema(client);
    await generateAccounts(client);
    await runSimulation(client);
    await client.query('COMMIT');
    await summarize(client);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Simulation failed:', err.message || err);
  process.exit(1);
});
