#!/usr/bin/env node
'use strict';

/**
 * Step 3 Staging Test: Sovereign Lending Desk Scaffold & 9 Funding Pods
 * Initializes a private deployment deal, scaffolds 9 pods, and runs all
 * Asset Shield monitors from jobs/sovereign-lens-nightly.js against staging.
 */

const bcrypt = require('bcrypt');
const {
  SHIELD_MAP,
  runTaxGuard,
  runLapseGuard,
  runMarginGuard,
  runRateGuard,
  runEquityGuard,
  runLiquidityGuard,
  runBurnGuard,
  runDefaultGuard,
  runComplianceGuard
} = require('../jobs/sovereign-lens-nightly');
const { loadStagingEnv, createStagingPool } = require('./lib/staging-env');

const BASE = process.env.VAULT_API_BASE || 'http://127.0.0.1:3010';
const LENDER_EMAIL = 'staging.gamification.e2e@facts-staging.test';
const BORROWER_EMAIL = 'staging.lending.borrower@borrower-e2e.test';
const PASSWORD = process.env.STAGING_TEST_PASSWORD || 'StagingEngineTest!2026';

const POD_SHIELDS = [
  { id: 1, pod_type: 'sdira', pod: 'SDIRA', shield: 'Tax Guard', runner: runTaxGuard,
    passDetail: 'No IRC §4975 disqualified person match' },
  { id: 2, pod_type: 'cvli', pod: 'CVLI', shield: 'Lapse Guard', runner: runLapseGuard,
    passDetail: 'Cash value ratio > 1.5x annual premium' },
  { id: 3, pod_type: 'sbloc', pod: 'SBLOC', shield: 'Margin Guard', runner: runMarginGuard,
    passDetail: '24-hr portfolio volatility <= 15%' },
  { id: 4, pod_type: 'credit_card', pod: 'Credit Card', shield: 'Rate Guard', runner: runRateGuard,
    passDetail: '0% APR countdown > 60 days' },
  { id: 5, pod_type: 'heloc_ploc', pod: 'HELOC/PLOC', shield: 'Equity Guard', runner: runEquityGuard,
    passDetail: 'Collateral ratio >= 120% loan balance' },
  { id: 6, pod_type: 'personal_cash', pod: 'Personal Cash', shield: 'Liquidity Guard', runner: runLiquidityGuard,
    passDetail: 'Reserve balance >= 6 months operational cash' },
  { id: 7, pod_type: 'business_revenue', pod: 'Business Rev.', shield: 'Burn Guard', runner: runBurnGuard,
    passDetail: 'MoM revenue drop <= 25%' },
  { id: 8, pod_type: 'note_on_note', pod: 'Note-on-Note', shield: 'Default Guard', runner: runDefaultGuard,
    passDetail: 'Primary underlying note status active' },
  { id: 9, pod_type: 'standard_loc', pod: 'Standard LOC', shield: 'Compliance Guard', runner: runComplianceGuard,
    passDetail: 'SB 362 dynamic APR box format verified' }
];

async function api(method, urlPath) {
  const res = await fetch(BASE + urlPath, { method, headers: { Accept: 'application/json' } });
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* keep */ }
  return { status: res.status, data };
}

async function ensureSchema(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS mod_lending_desk');
  await client.query(`
    CREATE TABLE IF NOT EXISTS mod_lending_desk.pods (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pod_number INTEGER NOT NULL CHECK (pod_number BETWEEN 1 AND 9),
      label TEXT,
      status VARCHAR(32) NOT NULL DEFAULT 'empty',
      principal_cents INTEGER NOT NULL DEFAULT 0,
      outstanding_cents INTEGER NOT NULL DEFAULT 0,
      interest_rate_bps INTEGER NOT NULL DEFAULT 0,
      collateral_description TEXT,
      collateral_value_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      opened_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, pod_number)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS mod_lending_desk.sweep_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pod_id INTEGER REFERENCES mod_lending_desk.pods(id) ON DELETE SET NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS mod_lending_desk.notifications_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notification_type VARCHAR(64) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
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
  await client.query(`
    CREATE TABLE IF NOT EXISTS shield_config (
      deal_id INTEGER PRIMARY KEY REFERENCES lending_deals(id) ON DELETE CASCADE,
      annual_premium_cents INTEGER,
      cash_value_account_ref TEXT,
      apr_expiry_date DATE,
      apr_rate_after_expiry NUMERIC(8,4),
      collateral_estimated_value_cents INTEGER,
      monthly_ops_cash_cents INTEGER,
      stripe_account_id TEXT,
      prev_month_revenue_cents INTEGER,
      custom_config JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS asset_shield_alerts (
      id SERIAL PRIMARY KEY,
      deal_id INTEGER NOT NULL REFERENCES lending_deals(id) ON DELETE CASCADE,
      shield_type VARCHAR(64) NOT NULL,
      severity VARCHAR(16) NOT NULL,
      alert_type VARCHAR(80) NOT NULL,
      message TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      cycle_run_id INTEGER,
      acknowledged BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS lending_notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      deal_id INTEGER REFERENCES lending_deals(id) ON DELETE SET NULL,
      alert_id INTEGER,
      type VARCHAR(40) NOT NULL,
      title TEXT,
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      alert_type VARCHAR(80) NOT NULL,
      in_app BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, alert_type)
    )
  `);
}

async function ensureUser(client, email, name) {
  let row = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  if (!row.rows[0]) {
    row = await client.query(
      `INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id`,
      [email, name]
    );
  }
  const userId = row.rows[0].id;
  const hash = await bcrypt.hash(PASSWORD, 10);
  await client.query(
    `UPDATE users
        SET password_hash = $2,
            two_factor_enabled = false,
            subscription_tier = COALESCE(NULLIF(subscription_tier, ''), 'elite'),
            plan = COALESCE(NULLIF(plan, ''), 'elite'),
            subscription_status = COALESCE(NULLIF(subscription_status, ''), 'active')
      WHERE id = $1`,
    [userId, hash]
  );
  return userId;
}

async function ensurePods(client, userId) {
  for (let i = 1; i <= 9; i++) {
    const meta = POD_SHIELDS[i - 1];
    await client.query(
      `INSERT INTO mod_lending_desk.pods (user_id, pod_number, label, status)
       VALUES ($1, $2, $3, 'empty')
       ON CONFLICT (user_id, pod_number) DO UPDATE
         SET label = EXCLUDED.label`,
      [userId, i, meta.pod]
    );
  }
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
    console.log('[*] Starting Step 3: Sovereign Vault & 9-Pod Staging Test...\n');
    console.log('BASE=' + BASE);

    await ensureSchema(client);
    const lenderId = await ensureUser(client, LENDER_EMAIL, 'Vault Lender E2E');
    const borrowerId = await ensureUser(client, BORROWER_EMAIL, 'Vault Borrower E2E');
    record('lender + borrower users', true,
      'lender_id=' + lenderId + ' (user_staging_' + lenderId + ') borrower_id=' + borrowerId);

    const health = await api('GET', '/api/mod_lending_desk/health');
    record('GET /api/mod_lending_desk/health',
      health.status === 200 && health.data && health.data.status === 'ok',
      'status=' + health.status + ' ' + JSON.stringify(health.data && { status: health.data.status, module: health.data.module }));

    console.log('--------------------------------------------------');
    console.log('[Test 3.1] Initializing Private Deployment Contract...');
    const amountCents = 2500000; // $25,000
    const interestBps = 850; // 8.5%
    const dealNumber = 'DEAL_' + Date.now();
    const dealIns = await client.query(
      `INSERT INTO lending_deals
         (deal_number, lender_user_id, borrower_user_id, amount_cents, interest_rate_bps,
          pod_type, status, borrower_scorecard, updated_at)
       VALUES ($1,$2,$3,$4,$5,'standard_loc','pending_signatures',$6::jsonb, NOW() - INTERVAL '1 hour')
       RETURNING id, deal_number, status, amount_cents, interest_rate_bps, pod_type`,
      [
        dealNumber,
        lenderId,
        borrowerId,
        amountCents,
        interestBps,
        JSON.stringify({ portfolio_value_cents: 10000000, total_debt_cents: 125000, total_limit_cents: 1500000 })
      ]
    );
    const deal = dealIns.rows[0];
    console.log('  -> Deal ID: ' + deal.deal_number);
    console.log('  -> Amount: $' + (deal.amount_cents / 100).toLocaleString() +
      ' @ ' + (deal.interest_rate_bps / 100).toFixed(1) + '% APR');
    console.log('  -> Target Pod: ' + deal.pod_type);
    record('Contract scaffold pending_signatures',
      deal.status === 'pending_signatures' && deal.amount_cents === amountCents,
      'id=' + deal.id + ' status=' + deal.status);

    const activated = await client.query(
      `UPDATE lending_deals
          SET status = 'active', updated_at = NOW() - INTERVAL '30 minutes'
        WHERE id = $1
        RETURNING id, status`,
      [deal.id]
    );
    record('Deal state transition pending_signatures → active',
      activated.rows[0].status === 'active',
      'status=' + activated.rows[0].status);

    await ensurePods(client, lenderId);
    const podRows = await client.query(
      `SELECT pod_number, label, status FROM mod_lending_desk.pods
        WHERE user_id = $1 ORDER BY pod_number`,
      [lenderId]
    );
    record('9 Funding Pods scaffolded',
      podRows.rows.length === 9 && podRows.rows.every((p) => p.pod_number >= 1 && p.pod_number <= 9),
      'pods=' + podRows.rows.map((p) => p.pod_number + ':' + (p.label || 'n/a')).join(','));

    // Activate Standard LOC pod (#9) with the deal principal
    await client.query(
      `UPDATE mod_lending_desk.pods
          SET status = 'active',
              label = 'Standard LOC',
              principal_cents = $2,
              outstanding_cents = $2,
              interest_rate_bps = $3,
              opened_at = COALESCE(opened_at, NOW()),
              updated_at = NOW()
        WHERE user_id = $1 AND pod_number = 9`,
      [lenderId, amountCents, interestBps]
    );

    // Shield config values that should PASS all monitors
    const aprExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await client.query(
      `INSERT INTO shield_config
         (deal_id, annual_premium_cents, apr_expiry_date, apr_rate_after_expiry,
          collateral_estimated_value_cents, monthly_ops_cash_cents,
          prev_month_revenue_cents, custom_config, updated_at)
       VALUES ($1, 100000, $2, 19.99, 4000000, 100000, 500000,
               $3::jsonb, NOW())
       ON CONFLICT (deal_id) DO UPDATE SET
         annual_premium_cents = EXCLUDED.annual_premium_cents,
         apr_expiry_date = EXCLUDED.apr_expiry_date,
         collateral_estimated_value_cents = EXCLUDED.collateral_estimated_value_cents,
         monthly_ops_cash_cents = EXCLUDED.monthly_ops_cash_cents,
         prev_month_revenue_cents = EXCLUDED.prev_month_revenue_cents,
         custom_config = EXCLUDED.custom_config,
         updated_at = NOW()`,
      [
        deal.id,
        aprExpiry,
        JSON.stringify({ apr_box_generated_at: new Date().toISOString() })
      ]
    );

    // Underlying note for Default Guard — active
    const underlying = await client.query(
      `INSERT INTO lending_deals
         (deal_number, lender_user_id, borrower_user_id, amount_cents, interest_rate_bps,
          pod_type, status)
       VALUES ($1,$2,$3,1000000,700,'note_on_note','active')
       RETURNING id`,
      ['UNDER_' + Date.now(), lenderId, borrowerId]
    );
    await client.query(
      `UPDATE lending_deals SET underlying_note_id = $2 WHERE id = $1`,
      [deal.id, underlying.rows[0].id]
    );

    const dealRow = (await client.query('SELECT * FROM lending_deals WHERE id = $1', [deal.id])).rows[0];

    // Balance fixture: healthy cash, insurance CV, brokerage near baseline
    const balanceData = {
      accounts: [
        {
          account_id: 'acct-cv',
          name: 'Cash Value Life',
          type: 'investment',
          subtype: 'life insurance',
          balances: { current: 2000.00, available: 2000.00 }
        },
        {
          account_id: 'acct-broker',
          name: 'Brokerage',
          type: 'investment',
          subtype: 'brokerage',
          balances: { current: 98000.00, available: 98000.00 }
        },
        {
          account_id: 'acct-cash',
          name: 'Operating Cash',
          type: 'depository',
          subtype: 'checking',
          balances: { current: 75000.00, available: 75000.00 }
        }
      ],
      totalCurrentCents: 7500000,
      totalDebtCents: 125000,
      totalLimitCents: 1500000
    };

    console.log('--------------------------------------------------');
    console.log('[Test 3.2] Executing 9 Asset Shield Logic Monitors...');
    let allPassed = true;
    for (const s of POD_SHIELDS) {
      if (typeof SHIELD_MAP[s.pod_type] !== 'function') {
        record('Shield map has ' + s.pod_type, false, 'missing runner');
        allPassed = false;
        continue;
      }
      const dealForShield = Object.assign({}, dealRow, { pod_type: s.pod_type });
      const alerts = await s.runner(client, dealForShield, balanceData, null);
      const status = alerts === 0 ? 'PASSED' : 'FAILED';
      console.log('  Pod #' + s.id + ' [' + s.pod + '] -> ' + s.shield + ': ' + status +
        ' (' + (alerts === 0 ? s.passDetail : alerts + ' alert(s)') + ')');
      if (alerts !== 0) allPassed = false;
      record(s.shield + ' (' + s.pod + ')', alerts === 0, 'alerts=' + alerts);
    }

    const alertCount = await client.query(
      `SELECT COUNT(*)::int AS n FROM asset_shield_alerts WHERE deal_id = $1`,
      [deal.id]
    );
    record('No shield alerts for healthy fixture',
      alertCount.rows[0].n === 0 && allPassed,
      'alerts_for_deal=' + alertCount.rows[0].n);

    console.log('\n  [✔] All 9 Asset Shields evaluated successfully.\n');
  } catch (err) {
    record('harness', false, err.message);
    console.error('Vault Scaffold test error:', err);
  } finally {
    client.release();
    await pool.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('==================================================');
  console.log(' STEP 3: VAULT SCAFFOLD & 9-POD TEST ' + (failed.length ? 'FAILED' : 'PASSED'));
  console.log('==================================================');
  console.log((results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Vault Scaffold test error:', err.message || err);
  process.exit(1);
});
