/**
 * FACTS Gross vs Net income engine (educational / non-custodial).
 *
 * Routes (mounted at /api/engine):
 *   GET  /health
 *   POST /process          — deterministic paycheck split (no bank movement)
 *   GET  /transactions     — recent saved paycheck models (auth)
 *   POST /execute-sweep    — atomic income → buckets → debt sweep (auth)
 *
 * Reserve months, when supplied, run the progressive reserve / velocity
 * ladder, one-time 6- and 12-month Lifestyle celebrations, and the
 * post-celebration overflow. Celebration flags persist on save and sweep.
 */

'use strict';

const express = require('express');
const { asyncRoute } = require('../../module-error-boundary');
const { pool } = require('../../db/pool');
const { processIncomeTransaction, BUCKETS, sharesForNecessity } = require('./facts-income-processor');
const { DEFAULT_BUCKET_TARGETS } = require('../shared/constants');
const { withManualExecutionNotice } = require('../shared/edu-compliance');
const { requireAuth } = require('../../routes/auth');
const { processIncomeAllocationSweep } = require('./transactionalEngine');
const { lockReserveProtocol, persistReserveProtocol, optionsForUser } = require('./reserve-protocol-store');

const router = express.Router();

router.get('/health', asyncRoute(async (req, res) => {
  res.json({ status: 'ok', module: 'engine', version: '1.0.0' });
}));

router.post('/process', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const splits = body.custom_splits || body.customSplits || DEFAULT_BUCKET_TARGETS;
  const userId = req.session?.userId || null;
  if (body.save === true && !userId) {
    return res.status(401).json({ error: 'Authentication required to save paycheck entries' });
  }

  if (!(userId && body.save === true)) {
    return res.json(processIncomeTransaction(body, splits));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stored = await lockReserveProtocol(client, userId);
    const merged = optionsForUser(stored, body);
    const result = processIncomeTransaction(Object.assign({}, body, {
      reserveMonths: merged.reserveMonths,
      reserveFull: merged.reserveFull,
      celebration6mClaimed: merged.celebration6mClaimed,
      celebration12mClaimed: merged.celebration12mClaimed,
      discretionaryBucket: merged.discretionaryBucket,
      lifestylePercent: merged.lifestylePercent,
      discretionaryPercent: merged.discretionaryPercent
    }), splits);
    const matchTarget = BUCKETS.includes(body.employer_match_target)
      ? body.employer_match_target
      : 'GROWTH';
    const inserted = await client.query(
      `INSERT INTO mod_income.paycheck_entries (
         user_id, source_name, entry_date, calculation_mode,
         gross_amount, net_amount, employer_match, employer_match_target,
         liquid_take_home, bucket_allocations
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        userId,
        body.source_name || 'Paycheck',
        body.entry_date || new Date(),
        String(body.calculation_mode || 'GROSS').toUpperCase() === 'NET' ? 'NET' : 'GROSS',
        Number(body.gross_amount) || 0,
        Number(body.net_amount) || 0,
        Number(body.employer_match) || 0,
        matchTarget,
        result.summary.net_liquid_take_home,
        JSON.stringify(result.bucket_allocations)
      ]
    );
    const entryId = inserted.rows[0].id;
    for (const item of Array.isArray(body.deductions) ? body.deductions : []) {
      if (!item || !item.label || !BUCKETS.includes(item.target_bucket)) continue;
      await client.query(
        `INSERT INTO mod_income.income_deductions (entry_id, label, amount, target_bucket)
         VALUES ($1,$2,$3,$4)`,
        [entryId, String(item.label), Number(item.amount) || 0, item.target_bucket]
      );
    }
    if (result.reserve_protocol) {
      await persistReserveProtocol(client, userId, result.reserve_protocol.state);
    }
    await client.query('COMMIT');
    result.saved_id = entryId;
    res.json(result);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
}));

router.get('/transactions', requireAuth, asyncRoute(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, source_name, entry_date, calculation_mode,
            gross_amount, net_amount, employer_match, employer_match_target,
            liquid_take_home, bucket_allocations, created_at
       FROM mod_income.paycheck_entries
      WHERE user_id = $1
      ORDER BY entry_date DESC, created_at DESC
      LIMIT 50`,
    [req.userId]
  );
  res.json(withManualExecutionNotice({ entries: rows }));
}));

router.post('/execute-sweep', requireAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const incomeAmount = body.incomeAmount ?? body.income_amount;
  const incomeSource = body.incomeSource ?? body.income_source ?? 'Income';
  const necessityPercent = body.necessityPercent ?? body.necessity_percent;
  const summary = await processIncomeAllocationSweep(req.userId, incomeAmount, incomeSource, necessityPercent, body);
  res.json(summary);
}));

module.exports = {
  metadata: {
    name: 'FACTS Income Engine',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true
  },
  routes: router,
  healthCheck: async () => ({
    module: 'engine',
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  }),
  processIncomeTransaction,
  processIncomeAllocationSweep,
  sharesForNecessity
};
