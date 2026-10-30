#!/usr/bin/env node
'use strict';

/**
 * Affiliate partner integration test (staging).
 *
 * Verifies:
 *   - POST /api/affiliates/register (custom + auto-generated codes)
 *   - 1-code-per-user idempotent re-register
 *   - affiliate_referrals linkage
 *   - recordAffiliateMilestone (idempotent bucket_setup_complete)
 *   - GET /api/affiliates/dashboard/:partnerId metrics
 *   - cleanup of test rows
 */

const { loadStagingEnv, createStagingPool } = require('./lib/staging-env');
const { recordAffiliateMilestone } = require('../modules/mod_affiliate/milestones');

const BASE = process.env.AFFILIATE_API_BASE || process.env.STAGING_API_BASE || 'http://127.0.0.1:3010';
const TAG = 'affiliate-e2e-' + Date.now();
const PARTNER_EMAIL = TAG + '.partner@facts-staging.test';
const REFERRED_EMAIL = TAG + '.referred@facts-staging.test';
const AUTO_EMAIL = TAG + '.auto@facts-staging.test';
const PARTNER_CODE = ('E2E' + String(Date.now()).slice(-8)).toUpperCase();

async function api(method, urlPath, body) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-internal': 'affiliate-e2e'
    }
  };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + urlPath, opts);
  const text = await res.text();
  let data = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) { /* keep text */ }
  return { status: res.status, data };
}

async function main() {
  loadStagingEnv();
  const pool = createStagingPool();
  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
  }

  let partnerUserId = null;
  let referredUserId = null;
  let autoUserId = null;
  let partnerId = null;
  let autoPartnerId = null;
  let referralId = null;
  let milestoneIds = [];

  try {
    console.log('==================================================');
    console.log(' AFFILIATE PARTNER MODULE E2E TEST');
    console.log('==================================================');
    console.log('BASE=' + BASE);
    console.log('partnerCode=' + PARTNER_CODE);

    // Ensure partners schema exists
    const schema = await pool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'partners'
       ) AS ok`
    );
    if (!schema.rows[0] || !schema.rows[0].ok) {
      throw new Error('partners table missing — run migrations first');
    }
    record('partners schema present', true);

    // Create partner + referred + auto-gen users
    const partnerUser = await pool.query(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, 'Affiliate E2E Partner', 'test-not-a-real-hash')
       RETURNING id`,
      [PARTNER_EMAIL]
    );
    partnerUserId = partnerUser.rows[0].id;

    const referredUser = await pool.query(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, 'Affiliate E2E Referred', 'test-not-a-real-hash')
       RETURNING id`,
      [REFERRED_EMAIL]
    );
    referredUserId = referredUser.rows[0].id;

    const autoUser = await pool.query(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, 'Auto Code Member', 'test-not-a-real-hash')
       RETURNING id`,
      [AUTO_EMAIL]
    );
    autoUserId = autoUser.rows[0].id;

    record(
      'staging users created',
      !!partnerUserId && !!referredUserId && !!autoUserId,
      'partnerUser=' + partnerUserId +
        ' referredUser=' + referredUserId +
        ' autoUser=' + autoUserId
    );

    // a) Partner registration via API
    console.log('--------------------------------------------------');
    console.log('[A] Partner Registration');
    const reg = await api('POST', '/api/affiliates/register', {
      userId: partnerUserId,
      partnerCode: PARTNER_CODE
    });
    console.log(JSON.stringify(reg.data, null, 2));
    partnerId = reg.data && reg.data.partner && reg.data.partner.id;
    record(
      'POST /api/affiliates/register',
      reg.status === 201 &&
        reg.data &&
        reg.data.status === 'success' &&
        partnerId != null &&
        reg.data.partner.partner_code === PARTNER_CODE,
      'status=' + reg.status + ' partnerId=' + partnerId
    );

    // Duplicate code on a different user should 409
    const dup = await api('POST', '/api/affiliates/register', {
      userId: referredUserId,
      partnerCode: PARTNER_CODE
    });
    record(
      'duplicate partnerCode rejected',
      dup.status === 409,
      'status=' + dup.status
    );

    // Same user re-register returns existing partner (1-code-per-user)
    const again = await api('POST', '/api/affiliates/register', {
      userId: partnerUserId,
      partnerCode: 'SHOULD-NOT-CREATE-' + Date.now()
    });
    console.log('re-register:', JSON.stringify(again.data, null, 2));
    record(
      'duplicate registration returns existing partner',
      again.status === 200 &&
        again.data &&
        again.data.existing === true &&
        again.data.partner &&
        again.data.partner.id === partnerId &&
        again.data.partner.partner_code === PARTNER_CODE,
      'status=' + again.status +
        ' partnerId=' + (again.data && again.data.partner && again.data.partner.id)
    );

    // Auto-generate when partnerCode omitted
    console.log('--------------------------------------------------');
    console.log('[A2] Auto-Generated Partner Code');
    const autoReg = await api('POST', '/api/affiliates/register', {
      userId: autoUserId
    });
    console.log(JSON.stringify(autoReg.data, null, 2));
    autoPartnerId = autoReg.data && autoReg.data.partner && autoReg.data.partner.id;
    const autoCode =
      autoReg.data && autoReg.data.partner && autoReg.data.partner.partner_code;
    const autoCodeOk =
      typeof autoCode === 'string' &&
      new RegExp('^FR-[A-Z0-9]+-' + autoUserId + '-\\d{4}$').test(autoCode);
    record(
      'register without partnerCode auto-generates',
      autoReg.status === 201 &&
        autoReg.data &&
        autoReg.data.status === 'success' &&
        autoPartnerId != null &&
        autoCodeOk,
      'status=' + autoReg.status + ' code=' + autoCode
    );

    const autoAgain = await api('POST', '/api/affiliates/register', {
      userId: autoUserId
    });
    record(
      'auto-user re-register is idempotent',
      autoAgain.status === 200 &&
        autoAgain.data &&
        autoAgain.data.existing === true &&
        autoAgain.data.partner &&
        autoAgain.data.partner.id === autoPartnerId &&
        autoAgain.data.partner.partner_code === autoCode,
      'status=' + autoAgain.status +
        ' partnerId=' + (autoAgain.data && autoAgain.data.partner && autoAgain.data.partner.id)
    );

    // b) Referral creation
    console.log('--------------------------------------------------');
    console.log('[B] Referral Creation');
    const referral = await pool.query(
      `INSERT INTO affiliate_referrals (partner_id, referred_user_id, status)
       VALUES ($1, $2, 'registered')
       RETURNING id, status`,
      [partnerId, referredUserId]
    );
    referralId = referral.rows[0].id;
    record(
      'affiliate_referrals row linked',
      !!referralId,
      'referralId=' + referralId + ' status=' + referral.rows[0].status
    );

    // c) Milestone logging + idempotency
    console.log('--------------------------------------------------');
    console.log('[C] Milestone Logging');
    const m1 = await recordAffiliateMilestone(
      pool,
      referredUserId,
      'bucket_setup_complete',
      10.0
    );
    console.log('first:', JSON.stringify(m1));
    record(
      'recordAffiliateMilestone first insert',
      m1.recorded === true && m1.partnerId === partnerId,
      'milestoneId=' + m1.milestoneId
    );
    if (m1.milestoneId) milestoneIds.push(m1.milestoneId);

    const m2 = await recordAffiliateMilestone(
      pool,
      referredUserId,
      'bucket_setup_complete',
      10.0
    );
    console.log('second:', JSON.stringify(m2));
    record(
      'recordAffiliateMilestone idempotent',
      m2.recorded === false && m2.reason === 'already_recorded',
      'reason=' + m2.reason
    );

    const httpMilestone = await api('POST', '/api/affiliates/milestones', {
      referredUserId,
      milestoneType: 'bucket_setup_complete'
    });
    record(
      'POST /api/affiliates/milestones idempotent',
      httpMilestone.status === 200 &&
        httpMilestone.data &&
        httpMilestone.data.recorded === false,
      'status=' + httpMilestone.status
    );

    const milestoneCount = await pool.query(
      `SELECT COUNT(*)::int AS n FROM affiliate_milestones
        WHERE partner_id = $1 AND referred_user_id = $2 AND milestone_type = 'bucket_setup_complete'`,
      [partnerId, referredUserId]
    );
    record(
      'exactly one bucket_setup_complete row',
      milestoneCount.rows[0].n === 1,
      'count=' + milestoneCount.rows[0].n
    );

    // d) Dashboard metrics
    console.log('--------------------------------------------------');
    console.log('[D] Dashboard Metrics');
    const dash = await api('GET', '/api/affiliates/dashboard/' + partnerId);
    console.log(JSON.stringify(dash.data, null, 2));
    const metrics = (dash.data && dash.data.metrics) || {};
    const totalReferrals = Number(metrics.total_referrals);
    const totalMilestones = Number(metrics.total_milestones);
    const totalRewards = Number(metrics.total_rewards);
    record(
      'GET /api/affiliates/dashboard/:partnerId',
      dash.status === 200 && dash.data && dash.data.status === 'success',
      'status=' + dash.status
    );
    record(
      'dashboard referral count',
      totalReferrals === 1,
      'total_referrals=' + totalReferrals
    );
    record(
      'dashboard milestone count',
      totalMilestones === 1,
      'total_milestones=' + totalMilestones
    );
    record(
      'dashboard reward units',
      totalRewards === 10,
      'total_rewards=' + totalRewards
    );
  } catch (err) {
    record('harness', false, err.message);
    console.error('Affiliate test error:', err);
  } finally {
    // e) Cleanup
    console.log('--------------------------------------------------');
    console.log('[E] Cleanup');
    try {
      const partnerIds = [partnerId, autoPartnerId].filter(Boolean);
      for (let i = 0; i < partnerIds.length; i++) {
        const pid = partnerIds[i];
        await pool.query('DELETE FROM affiliate_milestones WHERE partner_id = $1', [pid]);
        await pool.query('DELETE FROM affiliate_referrals WHERE partner_id = $1', [pid]);
        await pool.query('DELETE FROM partners WHERE id = $1', [pid]);
      }
      if (referredUserId) {
        await pool.query('DELETE FROM users WHERE id = $1', [referredUserId]);
      }
      if (autoUserId) {
        await pool.query('DELETE FROM users WHERE id = $1', [autoUserId]);
      }
      if (partnerUserId) {
        await pool.query('DELETE FROM users WHERE id = $1', [partnerUserId]);
      }
      record('cleanup removed test rows', true, 'tag=' + TAG);
    } catch (cleanErr) {
      record('cleanup', false, cleanErr.message);
    }
    await pool.end();
  }

  const failed = results.filter(function (r) { return !r.ok; });
  console.log('\n==================================================');
  console.log(
    ' AFFILIATE E2E TEST: ' + (failed.length ? 'FAILED' : 'PASSED')
  );
  console.log('==================================================');
  console.log((results.length - failed.length) + '/' + results.length + ' passed');
  if (failed.length) process.exitCode = 1;
}

main().catch(function (err) {
  console.error('Affiliate test fatal:', err.message || err);
  process.exit(1);
});
