'use strict';

/**
 * Unified FACTS financial execution service.
 * One atomic transaction: income ledger → dynamic buckets → debt sweep.
 * Non-custodial: records modeled allocations only. No bank movement.
 */

const { pool } = require('../../db/pool');
const { DEFAULT_BUCKET_TARGETS, BUCKET_SLUGS } = require('../shared/constants');
const { sharesForNecessity } = require('./necessity-pull');
const { applyReserveVelocityProtocol, protocolEngaged } = require('./reserve-velocity-protocol');
const { lockReserveProtocol, persistReserveProtocol, optionsForUser } = require('./reserve-protocol-store');
const { withManualExecutionNotice } = require('../shared/edu-compliance');

function toCents(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

function fromCents(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

function asPercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > 1 ? n : n * 100;
}

function allocateByPercent(totalCents, rules) {
  const weights = rules.map((r) => ({
    slug: r.bucket_slug,
    pct: asPercent(r.target_pct)
  }));
  const weightSum = weights.reduce((sum, w) => sum + w.pct, 0) || 100;
  const raw = weights.map((w) => {
    const exact = (totalCents * w.pct) / weightSum;
    const cents = Math.floor(exact);
    return { slug: w.slug, cents, remainder: exact - cents };
  });
  let leftover = totalCents - raw.reduce((sum, row) => sum + row.cents, 0);
  raw.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < raw.length && leftover > 0; i += 1, leftover -= 1) {
    raw[i].cents += 1;
  }
  return raw.map(({ slug, cents }) => ({ slug, cents }));
}

async function ensureBucketRows(client, userId) {
  const existing = await client.query(
    `SELECT bucket_slug, target_pct, deposited_cents, spent_cents, remaining_cents
       FROM user_bucket_state
      WHERE user_id = $1
      FOR UPDATE`,
    [userId]
  );

  if (existing.rows.length) {
    return existing.rows;
  }

  for (const slug of BUCKET_SLUGS) {
    const key = String(slug).toUpperCase();
    const fraction = DEFAULT_BUCKET_TARGETS[key] || 0;
    await client.query(
      `INSERT INTO user_bucket_state
         (user_id, bucket_slug, target_pct, deposited_cents, spent_cents, remaining_cents)
       VALUES ($1, $2, $3, 0, 0, 0)
       ON CONFLICT (user_id, bucket_slug) DO NOTHING`,
      [userId, slug, Number((fraction * 100).toFixed(2))]
    );
  }

  const seeded = await client.query(
    `SELECT bucket_slug, target_pct, deposited_cents, spent_cents, remaining_cents
       FROM user_bucket_state
      WHERE user_id = $1
      FOR UPDATE`,
    [userId]
  );
  return seeded.rows;
}

async function loadDebtsForStrategy(client, userId, strategy) {
  if (strategy === 'minimum') return [];
  try {
    const result = await client.query(
      `SELECT id, name, balance, interest_rate, minimum_payment, current_payment
         FROM debts
        WHERE user_id = $1
          AND COALESCE(balance, 0) > 0
          AND COALESCE(interest_rate, 0) > 4
        FOR UPDATE`,
      [userId]
    );
    const rows = result.rows;
    if (strategy === 'snowball') {
      rows.sort((a, b) => Number(a.balance) - Number(b.balance) || Number(b.interest_rate) - Number(a.interest_rate));
    } else if (strategy === 'current') {
      const extra = (row) => Number(row.current_payment || row.minimum_payment) - Number(row.minimum_payment);
      rows.sort((a, b) => extra(b) - extra(a) || Number(a.balance) - Number(b.balance));
    } else {
      rows.sort((a, b) => Number(b.interest_rate) - Number(a.interest_rate) || Number(b.balance) - Number(a.balance));
    }
    return rows;
  } catch (err) {
    if (err.code === '42P01') return [];
    throw err;
  }
}

function debtStrategyOf(options) {
  const raw = options && (options.debtStrategy || options.debt_strategy || options.payoffStrategy || options.payoff_strategy);
  const name = String(raw || '').toLowerCase();
  if (name === 'minimum' || name === 'current' || name === 'snowball' || name === 'avalanche') return name;
  return 'avalanche';
}

/**
 * Atomically record income, allocate to dynamic buckets, and sweep
 * surplus toward debts above 4% in the order the household chose: minimum,
 * current, snowball, or avalanche. Velocity raises income as fast and as
 * simply as possible. The first raise is every debt above 4%. Education for
 * higher pay, and education that teaches how to invest, can run in the same
 * month if the household manages all three. A debt at 4% or below is not a
 * sweep target. Minimum adds no extra. Current keeps the payment the
 * household is already making. Snowball sends the extra to the smallest
 * balance first. Avalanche sends the extra to the highest interest rate
 * first. Avalanche is the best of the four.
 *
 * @param {number} userId
 * @param {number} incomeAmount dollars
 * @param {string} incomeSource
 */
async function processIncomeAllocationSweep(userId, incomeAmount, incomeSource, necessityPercent, reserveOptions) {
  const uid = Number(userId);
  if (!Number.isInteger(uid) || uid <= 0) {
    const err = new Error('A valid userId is required');
    err.status = 400;
    throw err;
  }

  const incomeCents = toCents(incomeAmount);
  if (!Number.isFinite(incomeCents) || incomeCents <= 0) {
    const err = new Error('incomeAmount must be a positive dollar amount');
    err.status = 400;
    throw err;
  }

  const source = String(incomeSource || 'Income').trim().slice(0, 255) || 'Income';
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const storedProtocol = await lockReserveProtocol(client, uid);
    const protocolInput = optionsForUser(storedProtocol, reserveOptions);
    const buckets = await ensureBucketRows(client, uid);
    const necessityProvided = necessityPercent !== undefined && necessityPercent !== null && necessityPercent !== '';
    let reserveProtocol = null;
    if (necessityProvided || protocolEngaged(protocolInput)) {
      const storedNecessity = buckets.find((row) => row.bucket_slug === 'necessities');
      const necessity = necessityProvided
        ? necessityPercent
        : (storedNecessity ? storedNecessity.target_pct : 50);
      const base = sharesForNecessity(necessity, protocolInput).percents;
      const engaged = protocolEngaged(protocolInput);
      if (engaged) reserveProtocol = applyReserveVelocityProtocol(base, protocolInput);
      const percents = reserveProtocol ? reserveProtocol.percents : base;
      for (const row of buckets) {
        const key = String(row.bucket_slug).toUpperCase();
        const next = percents[key];
        if (next === undefined) continue;
        row.target_pct = next;
        await client.query(
          `UPDATE user_bucket_state
              SET target_pct = $3, updated_at = NOW()
            WHERE user_id = $1 AND bucket_slug = $2`,
          [uid, row.bucket_slug, next]
        );
      }
    }
    const shares = allocateByPercent(incomeCents, buckets);

    const txn = await client.query(
      `INSERT INTO transactions (user_id, amount_cents, type, description, occurred_at)
       VALUES ($1, $2, 'income', $3, NOW())
       RETURNING id`,
      [uid, incomeCents, source]
    );
    const transactionId = txn.rows[0].id;

    await client.query(
      `INSERT INTO ledgers
         (user_id, bucket_slug, entry_type, amount_cents, balance_after_cents, transaction_id, memo)
       VALUES ($1, 'income', 'income', $2, $2, $3, $4)`,
      [uid, incomeCents, transactionId, source]
    );

    const allocations = [];
    const bucketState = [];

    for (const share of shares) {
      const prior = buckets.find((b) => b.bucket_slug === share.slug) || {
        deposited_cents: 0,
        spent_cents: 0,
        remaining_cents: 0,
        target_pct: 0
      };
      const deposited = Number(prior.deposited_cents || 0) + share.cents;
      const remaining = Number(prior.remaining_cents || 0) + share.cents;
      const spent = Number(prior.spent_cents || 0);

      await client.query(
        `UPDATE user_bucket_state
            SET deposited_cents = $3,
                remaining_cents = $4,
                updated_at = NOW()
          WHERE user_id = $1 AND bucket_slug = $2`,
        [uid, share.slug, deposited, remaining]
      );

      let memo = `Allocated from ${source}`;
      if (reserveProtocol && share.slug === 'lifestyle' && reserveProtocol.celebrations.length) {
        memo += '; ' + reserveProtocol.celebrations
          .map((item) => item.flag + ' ' + item.applied_percent + '%')
          .join(', ');
      }

      await client.query(
        `INSERT INTO ledgers
           (user_id, bucket_slug, entry_type, amount_cents, balance_after_cents, transaction_id, memo)
         VALUES ($1, $2, 'allocation', $3, $4, $5, $6)`,
        [uid, share.slug, share.cents, remaining, transactionId, memo]
      );

      allocations.push({
        bucket_slug: share.slug,
        target_pct: Number(asPercent(prior.target_pct).toFixed(2)),
        amount_cents: share.cents,
        amount: fromCents(share.cents),
        remaining_cents: remaining
      });
      bucketState.push({
        bucket_slug: share.slug,
        deposited_cents: deposited,
        spent_cents: spent,
        remaining_cents: remaining
      });
    }

    const velocity = allocations.find((a) => a.bucket_slug === 'velocity');
    let surplusCents = velocity ? velocity.amount_cents : 0;
    const sweep = [];
    const debtStrategy = debtStrategyOf(reserveOptions);

    const debts = surplusCents > 0 ? await loadDebtsForStrategy(client, uid, debtStrategy) : [];
    for (const debt of debts) {
      if (surplusCents <= 0) break;
      const balanceCents = toCents(debt.balance);
      if (balanceCents <= 0) continue;
      let room = balanceCents;
      if (debtStrategy === 'current') {
        const current = toCents(debt.current_payment != null ? debt.current_payment : debt.minimum_payment);
        const minimum = toCents(debt.minimum_payment);
        room = Math.min(balanceCents, Math.max(0, current - minimum));
        if (room <= 0) continue;
      }
      const applied = Math.min(surplusCents, room);
      const newBalanceCents = balanceCents - applied;
      surplusCents -= applied;

      await client.query(
        `UPDATE debts
            SET balance = $2, updated_at = NOW()
          WHERE id = $1 AND user_id = $3`,
        [debt.id, fromCents(newBalanceCents), uid]
      );

      const velState = bucketState.find((b) => b.bucket_slug === 'velocity');
      if (velState) {
        velState.remaining_cents -= applied;
        velState.spent_cents += applied;
        await client.query(
          `UPDATE user_bucket_state
              SET remaining_cents = $3,
                  spent_cents = $4,
                  updated_at = NOW()
            WHERE user_id = $1 AND bucket_slug = $2`,
          [uid, 'velocity', velState.remaining_cents, velState.spent_cents]
        );
      }

      await client.query(
        `INSERT INTO ledgers
           (user_id, bucket_slug, entry_type, amount_cents, balance_after_cents, transaction_id, memo)
         VALUES ($1, 'velocity', 'sweep', $2, $3, $4, $5)`,
        [
          uid,
          -applied,
          velState ? velState.remaining_cents : 0,
          transactionId,
          `Sweep toward ${debt.name} (${Number(debt.interest_rate)}% APR)`
        ]
      );

      sweep.push({
        debt_id: debt.id,
        name: debt.name,
        interest_rate: Number(debt.interest_rate),
        applied_cents: applied,
        applied: fromCents(applied),
        remaining_balance: fromCents(newBalanceCents)
      });
    }

    if (reserveProtocol) {
      await persistReserveProtocol(client, uid, reserveProtocol.state);
    }

    await client.query('COMMIT');

    const sweptCents = sweep.reduce((sum, row) => sum + row.applied_cents, 0);
    const summary = {
      status: 'recorded',
      transaction_id: transactionId,
      income: {
        source,
        amount: fromCents(incomeCents),
        amount_cents: incomeCents
      },
      allocations,
      sweep: {
        strategy: debtStrategy,
        surplus_cents: velocity ? velocity.amount_cents : 0,
        surplus: fromCents(velocity ? velocity.amount_cents : 0),
        applied_cents: sweptCents,
        applied: fromCents(sweptCents),
        leftover_cents: surplusCents,
        leftover: fromCents(surplusCents),
        targets: sweep
      },
      buckets: bucketState
    };
    if (reserveProtocol) summary.reserve_protocol = reserveProtocol;
    return withManualExecutionNotice(summary);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  processIncomeAllocationSweep,
  sharesForNecessity
};
