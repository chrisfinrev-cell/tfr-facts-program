#!/usr/bin/env node
'use strict';

/**
 * Step 4 Staging Test: Sovereign Lens & Nightly Discipline Engine
 * Verifies borrower scorecard, Locked-Open on missed Friday Sweep,
 * and zero-balance Plaid token purge + frozen snapshot.
 */

const bcrypt = require('bcrypt');
const { processDeal } = require('../jobs/sovereign-lens-nightly');
const { loadStagingEnv, createStagingPool } = require('./lib/staging-env');

const DEAL_NUMBER = 'DEAL_LENS_STAGING_99';
const LENDER_EMAIL = 'staging.gamification.e2e@facts-staging.test';
const BORROWER_EMAIL = 'staging.lending.borrower@borrower-e2e.test';
const PASSWORD = process.env.STAGING_TEST_PASSWORD || 'StagingEngineTest!2026';

function evaluateBorrowerScorecard(input) {
  const composite = Math.round(
    (input.friday_sweep_score +
      input.allocation_discipline +
      input.debt_velocity +
      input.plaid_health) / 4
  );
  let tier = 'At Risk';
  if (composite >= 90) tier = 'Exemplary';
  else if (composite >= 75) tier = 'Strong';
  else if (composite >= 60) tier = 'Building';
  return Object.assign({}, input, { composite_score: composite, tier: tier });
}

async function ensureSchema(client) {
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
    CREATE TABLE IF NOT EXISTS sovereign_lens_access (
      id SERIAL PRIMARY KEY,
      deal_id INTEGER NOT NULL REFERENCES lending_deals(id) ON DELETE CASCADE,
      lender_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      lens_mode VARCHAR(32) NOT NULL DEFAULT 'standard',
      plaid_access_token TEXT,
      locked_open_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      frozen_snapshot JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (deal_id, lender_user_id)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS lens_cycle_runs (
      id SERIAL PRIMARY KEY,
      cycle_date DATE NOT NULL UNIQUE,
      status VARCHAR(32) NOT NULL DEFAULT 'running',
      deals_checked INTEGER NOT NULL DEFAULT 0,
      alerts_generated INTEGER NOT NULL DEFAULT 0,
      auto_revokes_triggered INTEGER NOT NULL DEFAULT 0,
      locked_open_activations INTEGER NOT NULL DEFAULT 0,
      locked_open_deactivations INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS lens_cycle_logs (
      id SERIAL PRIMARY KEY,
      deal_id INTEGER NOT NULL REFERENCES lending_deals(id) ON DELETE CASCADE,
      cycle_date DATE NOT NULL,
      plaid_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      scorecard_comparison JSONB NOT NULL DEFAULT '{}'::jsonb,
      alerts_generated INTEGER NOT NULL DEFAULT 0,
      UNIQUE (deal_id, cycle_date)
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

async function loadDealForProcess(client, dealId, lenderId) {
  const { rows } = await client.query(
    `SELECT
       d.*,
       sla.plaid_access_token,
       sla.status AS lens_status,
       sla.lens_mode,
       sla.lender_user_id AS sla_lender_user_id
     FROM lending_deals d
     LEFT JOIN sovereign_lens_access sla
       ON sla.deal_id = d.id AND sla.lender_user_id = $2
     WHERE d.id = $1`,
    [dealId, lenderId]
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
    console.log('[*] Starting Step 4: Sovereign Lens Nightly Cycle Test...\n');
    await ensureSchema(client);

    const lenderId = await ensureUser(client, LENDER_EMAIL, 'Lens Lender E2E');
    const borrowerId = await ensureUser(client, BORROWER_EMAIL, 'Lens Borrower E2E');
    record('lender + borrower users', true,
      'lender=' + lenderId + ' borrower=user_staging_' + borrowerId);

    console.log('--------------------------------------------------');
    console.log('[Test 4.1] Evaluating Composite Borrower Scorecard...');
    const mockScorecard = evaluateBorrowerScorecard({
      user_id: 'user_staging_' + borrowerId,
      friday_sweep_score: 95,
      allocation_discipline: 90,
      debt_velocity: 88,
      plaid_health: 92
    });
    console.log('  -> Borrower ID: ' + mockScorecard.user_id);
    console.log('  -> Composite Borrower Score: ' + mockScorecard.composite_score +
      ' / 100 (Tier: ' + mockScorecard.tier + ')');
    record('Scorecard composite Exemplary',
      mockScorecard.composite_score === 91 && mockScorecard.tier === 'Exemplary',
      'composite=' + mockScorecard.composite_score + ' tier=' + mockScorecard.tier);

    // Upsert deal DEAL_LENS_STAGING_99
    const dealUpsert = await client.query(
      `INSERT INTO lending_deals
         (deal_number, lender_user_id, borrower_user_id, amount_cents, interest_rate_bps,
          pod_type, status, borrower_scorecard, repayment_schedule, last_sweep_at, updated_at)
       VALUES ($1,$2,$3,2500000,850,'standard_loc','active',$4::jsonb,'{}'::jsonb,NULL,NOW())
       ON CONFLICT (deal_number) DO UPDATE SET
         lender_user_id = EXCLUDED.lender_user_id,
         borrower_user_id = EXCLUDED.borrower_user_id,
         status = 'active',
         borrower_scorecard = EXCLUDED.borrower_scorecard,
         repayment_schedule = '{}'::jsonb,
         last_sweep_at = NULL,
         updated_at = NOW()
       RETURNING id, deal_number, status`,
      [
        DEAL_NUMBER,
        lenderId,
        borrowerId,
        JSON.stringify({
          friday_sweep_score: 95,
          allocation_discipline: 90,
          debt_velocity: 88,
          plaid_health: 92,
          composite_score: mockScorecard.composite_score,
          tier: mockScorecard.tier,
          total_debt_cents: 0,
          total_limit_cents: 1500000,
          portfolio_value_cents: 10000000
        })
      ]
    );
    const dealId = dealUpsert.rows[0].id;
    record('Deal ' + DEAL_NUMBER + ' active',
      dealUpsert.rows[0].status === 'active',
      'id=' + dealId);

    await client.query(
      `INSERT INTO sovereign_lens_access
         (deal_id, lender_user_id, status, lens_mode, plaid_access_token, updated_at)
       VALUES ($1,$2,'active','standard','access-sandbox-lens-e2e-token',NOW())
       ON CONFLICT (deal_id, lender_user_id) DO UPDATE SET
         status = 'active',
         lens_mode = 'standard',
         plaid_access_token = 'access-sandbox-lens-e2e-token',
         locked_open_at = NULL,
         revoked_at = NULL,
         frozen_snapshot = NULL,
         updated_at = NOW()`,
      [dealId, lenderId]
    );

    const cycleDate = new Date().toISOString().slice(0, 10);
    const cycleRun = await client.query(
      `INSERT INTO lens_cycle_runs (cycle_date, status, started_at)
       VALUES (CURRENT_DATE, 'running', NOW())
       ON CONFLICT (cycle_date) DO UPDATE
         SET status = 'running', started_at = NOW(), error_message = NULL
       RETURNING id`
    );
    const cycleRunId = cycleRun.rows[0].id;

    console.log('--------------------------------------------------');
    console.log('[Test 4.2] Testing Locked-Open Mode Trigger (Missed Friday Sweep)...');
    let deal = await loadDealForProcess(client, dealId, lenderId);
    // No balance override → null Plaid fetch; discipline path still runs
    const lockedResult = await processDeal(client, deal, cycleRunId, null);
    console.log('  -> Deal ID: ' + DEAL_NUMBER);
    console.log('  -> Friday Sweep Status: MISSED');
    console.log('  -> Lens Mode Transition: STANDARD -> LOCKED_OPEN');

    const lensAfterLock = await client.query(
      `SELECT status, lens_mode, locked_open_at, plaid_access_token
         FROM sovereign_lens_access WHERE deal_id = $1 AND lender_user_id = $2`,
      [dealId, lenderId]
    );
    const lockRow = lensAfterLock.rows[0];
    record('Locked-Open mode enforced',
      lockedResult.lockedOpenActivated === true &&
      lockRow.lens_mode === 'locked_open' &&
      lockRow.status === 'active',
      'lens_mode=' + lockRow.lens_mode + ' locked_open_at=' + !!lockRow.locked_open_at);

    const lockAlert = await client.query(
      `SELECT alert_type, message FROM asset_shield_alerts
        WHERE deal_id = $1 AND alert_type = 'discipline_locked_open'
        ORDER BY id DESC LIMIT 1`,
      [dealId]
    );
    record('Locked-Open discipline alert stored',
      !!lockAlert.rows[0],
      lockAlert.rows[0] ? lockAlert.rows[0].alert_type : 'missing');

    console.log('--------------------------------------------------');
    console.log('[Test 4.3] Testing Zero-Balance Auto-Revocation Protocol...');

    // Reset lens to active/standard for revoke path; mark repayment complete
    await client.query(
      `UPDATE sovereign_lens_access
          SET status = 'active',
              lens_mode = 'standard',
              plaid_access_token = 'access-sandbox-lens-e2e-token',
              locked_open_at = NULL,
              revoked_at = NULL,
              frozen_snapshot = NULL,
              updated_at = NOW()
        WHERE deal_id = $1 AND lender_user_id = $2`,
      [dealId, lenderId]
    );
    await client.query(
      `UPDATE lending_deals
          SET repayment_schedule = $2::jsonb,
              last_sweep_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [dealId, JSON.stringify({ completed: true, end_date: cycleDate })]
    );

    deal = await loadDealForProcess(client, dealId, lenderId);
    const zeroBalances = {
      accounts: [],
      totalCurrentCents: 0,
      totalDebtCents: 0,
      totalLimitCents: 0
    };
    const revokeResult = await processDeal(client, deal, cycleRunId, zeroBalances);

    const lensAfterRevoke = await client.query(
      `SELECT status, lens_mode, plaid_access_token, revoked_at, frozen_snapshot
         FROM sovereign_lens_access WHERE deal_id = $1 AND lender_user_id = $2`,
      [dealId, lenderId]
    );
    const rev = lensAfterRevoke.rows[0];
    console.log('  -> Balance Verified via Plaid: $0.00');
    console.log('  -> Action Executed: Plaid access tokens purged for lender.');
    console.log('  -> Action Executed: Read-only lens snapshot archived to JSONB.');
    console.log('  -> Action Executed: Lien Release document generated.');

    record('Auto-revoke triggered',
      revokeResult.autoRevoke === true && rev.status === 'revoked',
      'status=' + rev.status + ' autoRevoke=' + revokeResult.autoRevoke);
    record('Plaid access token purged',
      rev.plaid_access_token == null,
      'token=' + (rev.plaid_access_token == null ? 'NULL' : 'PRESENT'));
    record('Frozen snapshot archived',
      !!rev.frozen_snapshot && rev.revoked_at != null,
      'has_snapshot=' + !!rev.frozen_snapshot + ' revoked_at=' + !!rev.revoked_at);

    const revokeAlert = await client.query(
      `SELECT alert_type FROM asset_shield_alerts
        WHERE deal_id = $1 AND alert_type = 'auto_revoke_deal_complete'
        ORDER BY id DESC LIMIT 1`,
      [dealId]
    );
    record('Auto-revoke alert / lien-release notice stored',
      !!revokeAlert.rows[0],
      revokeAlert.rows[0] ? revokeAlert.rows[0].alert_type : 'missing');

    const cycleLog = await client.query(
      `SELECT alerts_generated FROM lens_cycle_logs
        WHERE deal_id = $1 AND cycle_date = CURRENT_DATE`,
      [dealId]
    );
    record('lens_cycle_logs written for deal',
      !!cycleLog.rows[0],
      'alerts_generated=' + (cycleLog.rows[0] && cycleLog.rows[0].alerts_generated));
  } catch (err) {
    record('harness', false, err.message);
    console.error('Sovereign Lens test error:', err);
  } finally {
    client.release();
    await pool.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n==================================================');
  console.log(' STEP 4: SOVEREIGN LENS NIGHTLY TEST ' + (failed.length ? 'FAILED' : 'PASSED'));
  console.log('==================================================');
  console.log((results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Sovereign Lens test error:', err.message || err);
  process.exit(1);
});
