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
const { processIncomeTransaction, sharesForNecessity } = require('./facts-income-processor');
const { DEFAULT_BUCKET_TARGETS } = require('../shared/constants');
const { withManualExecutionNotice } = require('../shared/edu-compliance');
const { requireAuth } = require('../../routes/auth');
const { processIncomeAllocationSweep } = require('./transactionalEngine');
const { lockReserveProtocol, persistReserveProtocol, optionsForUser } = require('./reserve-protocol-store');
const {
  sessionUserId,
  ensurePaycheckLedger,
  insertPaycheckEntry,
  insertDeductions,
  paycheckSaveErrorMessage
} = require('./paycheck-ledger');

const router = express.Router();

router.get('/health', asyncRoute(async (req, res) => {
  res.json({ status: 'ok', module: 'engine', version: '1.0.0' });
}));

async function savePaycheckLedger(req, res) {
  const body = req.body || {};
  const splits = body.custom_splits || body.customSplits || DEFAULT_BUCKET_TARGETS;
  const userId = sessionUserId(req);
  if (body.save === true && !userId) {
    res.status(401).json({ success: false, error: 'Authentication required to save paycheck entries' });
    return;
  }

  if (!(userId && body.save === true)) {
    res.json(processIncomeTransaction(body, splits));
    return;
  }

  let client;
  try {
    client = await pool.connect();
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
    const ledger = await ensurePaycheckLedger(client);
    const entryId = await insertPaycheckEntry(client, userId, body, result);
    await insertDeductions(client, entryId, body.deductions, ledger);
    if (result.reserve_protocol) {
      await persistReserveProtocol(client, userId, result.reserve_protocol.state);
    }
    await client.query('COMMIT');
    result.saved_id = entryId;
    result.user_id = userId;
    result.success = true;
    res.json(result);
  } catch (error) {
    console.error("Save paycheck failed:", error);
    console.error("Ledger save error:", error);
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already closed */ }
    }
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: paycheckSaveErrorMessage(error) });
    }
  } finally {
    if (client) {
      try { client.release(); } catch (releaseErr) {
        console.error("Save paycheck failed:", releaseErr);
      }
    }
  }
}

router.post('/process', (req, res) => {
  Promise.resolve(savePaycheckLedger(req, res)).catch((error) => {
    console.error("Save paycheck failed:", error);
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: paycheckSaveErrorMessage(error) });
  });
});

router.get('/transactions', requireAuth, asyncRoute(async (req, res) => {
  const client = await pool.connect();
  try {
    await ensurePaycheckLedger(client);
    const { rows } = await client.query(
      `SELECT id, source_name, entry_date, calculation_mode,
              gross_amount, net_amount, employer_match, employer_match_target,
              total_economic_compensation, deductions,
              liquid_take_home, net_liquid_take_home, bucket_allocations, created_at
         FROM mod_income.paycheck_entries
        WHERE user_id = $1
        ORDER BY entry_date DESC, created_at DESC
        LIMIT 50`,
      [req.userId]
    );
    res.json(withManualExecutionNotice({ entries: rows }));
  } finally {
    client.release();
  }
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
