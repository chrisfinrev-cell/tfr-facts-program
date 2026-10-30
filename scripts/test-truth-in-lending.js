#!/usr/bin/env node
'use strict';

/**
 * Step 5 Staging Test: Truth in Lending Document Generator & Compliance Hard-Stop
 * Verifies SB 362 APR summary box math, legal document registry rows, and
 * user_acknowledgments hard-stop logging against staging.
 */

const bcrypt = require('bcrypt');
const {
  buildAprSummaryBox,
  validateAprSummaryBox,
  buildDocumentManifest,
  ensureTilSchema,
  persistAprBox,
  persistDocuments,
  persistAcknowledgment,
  DOCUMENT_TYPES,
  HARD_STOP_TYPE
} = require('../modules/shared/truth-in-lending');
const { loadStagingEnv, createStagingPool } = require('./lib/staging-env');

const DEAL_NUMBER = 'DEAL_TIL_STAGING_101';
const USER_EMAIL = 'staging.gamification.e2e@facts-staging.test';
const PASSWORD = process.env.STAGING_TEST_PASSWORD || 'StagingEngineTest!2026';
const BASE = process.env.VAULT_API_BASE || 'http://127.0.0.1:3010';

async function ensureUser(client, email) {
  let row = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (!row.rows[0]) {
    row = await client.query(
      `INSERT INTO users (email, name) VALUES ($1, 'TIL E2E') RETURNING id`,
      [email]
    );
  }
  const userId = row.rows[0].id;
  const hash = await bcrypt.hash(PASSWORD, 10);
  await client.query(
    `UPDATE users SET password_hash = $2, two_factor_enabled = false WHERE id = $1`,
    [userId, hash]
  );
  return userId;
}

async function ensureDeal(client, dealNumber, lenderId) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS lending_deals (
      id SERIAL PRIMARY KEY,
      deal_number VARCHAR(64) UNIQUE,
      lender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      borrower_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      interest_rate_bps INTEGER NOT NULL DEFAULT 0,
      pod_type VARCHAR(64),
      status VARCHAR(40) NOT NULL DEFAULT 'pending_signatures',
      underlying_note_id INTEGER,
      borrower_scorecard JSONB NOT NULL DEFAULT '{}'::jsonb,
      repayment_schedule JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_sweep_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const { rows } = await client.query(
    `INSERT INTO lending_deals
       (deal_number, lender_user_id, amount_cents, interest_rate_bps, pod_type, status)
     VALUES ($1,$2,2500000,850,'standard_loc','active')
     ON CONFLICT (deal_number) DO UPDATE SET
       lender_user_id = EXCLUDED.lender_user_id,
       amount_cents = EXCLUDED.amount_cents,
       interest_rate_bps = EXCLUDED.interest_rate_bps,
       status = 'active',
       updated_at = NOW()
     RETURNING id, deal_number`,
    [dealNumber, lenderId]
  );
  return rows[0];
}

async function main() {
  loadStagingEnv();
  const pool = createStagingPool();
  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
  }

  const client = await pool.connect();
  try {
    console.log('[*] Starting Step 5: Truth in Lending & Compliance Staging Test...\n');
    console.log('BASE=' + BASE);

    const userId = await ensureUser(client, USER_EMAIL);
    // lending_deals must exist before til_* FKs
    const deal = await ensureDeal(client, DEAL_NUMBER, userId);
    await ensureTilSchema(client);
    record('staging user + deal', true,
      'user_staging_' + userId + ' deal=' + deal.deal_number + ' id=' + deal.id);

    console.log('--------------------------------------------------');
    console.log('[Test 5.1] Verifying SB 362 Dynamic APR Summary Box...');
    const box = buildAprSummaryBox({
      dealNumber: DEAL_NUMBER,
      amountFinanced: 25000,
      annualPercentageRate: 0.085,
      termMonths: 12
    });
    console.log('  -> Amount Financed: $' + box.amount_financed.toLocaleString());
    console.log('  -> Total Finance Charge: $' + box.finance_charge.toLocaleString());
    console.log('  -> Calculated APR: ' + box.annual_percentage_rate);

    const formatOk = validateAprSummaryBox(box);
    const mathOk =
      box.amount_financed === 25000 &&
      box.finance_charge === 2125 &&
      box.total_of_payments === 27125 &&
      box.annual_percentage_rate === '8.50%' &&
      box.monthly_payment === 2260.42;
    record('SB 362 APR box format + math', formatOk && mathOk,
      'schedule=' + box.payment_schedule);

    const aprRow = await persistAprBox(client, {
      dealId: deal.id,
      dealNumber: DEAL_NUMBER,
      box
    });
    record('APR box persisted to til_apr_boxes',
      !!aprRow.id && Number(aprRow.amount_financed_cents) === 2500000,
      'record_id=' + aprRow.id);

    console.log('--------------------------------------------------');
    console.log('[Test 5.2] Generating Smart PDF Legal Documents...');
    const docs = buildDocumentManifest(DEAL_NUMBER, DOCUMENT_TYPES);
    docs.forEach(function (doc) {
      console.log('  -> Generated Document: ' + doc.file_name + ' [Status: ' + doc.status + ']');
    });
    const savedDocs = await persistDocuments(client, {
      dealId: deal.id,
      dealNumber: DEAL_NUMBER,
      docs
    });
    record('Smart PDF document registry (3 docs)',
      savedDocs.length === 3 &&
      savedDocs.every(function (d) { return d.status === 'READY_FOR_BIOMETRIC_SIGNATURE'; }),
      savedDocs.map(function (d) { return d.file_name; }).join(', '));

    const docCount = await client.query(
      `SELECT COUNT(*)::int AS n FROM til_documents WHERE deal_number = $1`,
      [DEAL_NUMBER]
    );
    record('til_documents rows for deal',
      docCount.rows[0].n >= 3,
      'count=' + docCount.rows[0].n);

    console.log('--------------------------------------------------');
    console.log('[Test 5.3] Testing Compliance Hard-Stop Interstitial Logging...');
    const ack = await persistAcknowledgment(client, {
      userId,
      disclaimerType: HARD_STOP_TYPE,
      accepted: true,
      dealId: deal.id,
      metadata: { source: 'staging_e2e', deal_number: DEAL_NUMBER }
    });
    console.log('  -> User ID: user_staging_' + userId);
    console.log('  -> Interstitial Status: ' + (ack.accepted ? 'ACCEPTED' : 'PENDING'));
    console.log('  -> Recorded In Table: user_acknowledgments');
    record('Hard-stop acknowledgment logged',
      ack.accepted === true && ack.disclaimer_type === HARD_STOP_TYPE,
      'ack_id=' + ack.id + ' type=' + ack.disclaimer_type);

    const ackLookup = await client.query(
      `SELECT id, accepted FROM user_acknowledgments
        WHERE user_id = $1 AND disclaimer_type = $2
        ORDER BY id DESC LIMIT 1`,
      [userId, HARD_STOP_TYPE]
    );
    record('user_acknowledgments readable',
      !!ackLookup.rows[0] && ackLookup.rows[0].accepted === true,
      'id=' + (ackLookup.rows[0] && ackLookup.rows[0].id));

    // Route presence (auth may 401 under Secure cookies on HTTP)
    const health = await fetch(BASE + '/api/mod_lending_desk/health').then(async function (r) {
      return { status: r.status, data: await r.json().catch(function () { return null; }) };
    }).catch(function (err) {
      return { status: 0, data: { error: err.message } };
    });
    record('Lending desk module reachable for TIL routes',
      health.status === 200,
      'status=' + health.status);
  } catch (err) {
    record('harness', false, err.message);
    console.error('Truth in Lending test error:', err);
  } finally {
    client.release();
    await pool.end();
  }

  const failed = results.filter(function (r) { return !r.ok; });
  console.log('\n==================================================');
  console.log(' STEP 5: TRUTH IN LENDING & COMPLIANCE TEST ' + (failed.length ? 'FAILED' : 'PASSED'));
  console.log('==================================================');
  console.log((results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exitCode = 1;
}

main().catch(function (err) {
  console.error('Truth in Lending test error:', err.message || err);
  process.exit(1);
});
