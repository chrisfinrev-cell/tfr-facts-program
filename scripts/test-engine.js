'use strict';

/**
 * Standalone verification of processIncomeAllocationSweep.
 * Creates a temporary user + buckets + sample debts, runs a $2,500
 * bi-weekly paycheck through the atomic engine, prints math checks,
 * then deletes the temporary rows.
 */

const { pool } = require('../db/pool');
const { DEFAULT_BUCKET_TARGETS, BUCKET_SLUGS } = require('../modules/shared/constants');
const { processIncomeAllocationSweep } = require('../modules/engine/transactionalEngine');

const INCOME = 2500.00;
const INCOME_CENTS = 250000;
const SOURCE = 'Bi-weekly Paycheck';

function fail(message) {
  console.error('FAIL  ' + message);
  return false;
}

function pass(message) {
  console.log('PASS  ' + message);
  return true;
}

function dollars(cents) {
  return (Number(cents) / 100).toFixed(2);
}

async function cleanup(userId) {
  if (!userId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ledgers WHERE user_id = $1', [userId]).catch(function () {});
    await client.query('DELETE FROM transaction_allocations WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = $1)', [userId]).catch(function () {});
    await client.query('DELETE FROM transactions WHERE user_id = $1', [userId]).catch(function () {});
    await client.query('DELETE FROM debts WHERE user_id = $1', [userId]).catch(function () {});
    await client.query('DELETE FROM user_bucket_state WHERE user_id = $1', [userId]).catch(function () {});
    await client.query('DELETE FROM user_reserve_protocol WHERE user_id = $1', [userId]).catch(function () {});
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.query('COMMIT');
    console.log('Cleanup removed temporary user id=' + userId);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) {}
    console.error('Cleanup failed:', err.message);
  } finally {
    client.release();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Cannot run engine test.');
    process.exit(1);
  }

  let userId = null;
  let ok = true;

  try {
    const email = 'engine-test-' + Date.now() + '@facts.test';
    const user = await pool.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email',
      [email, 'Engine Test User', 'test-not-a-real-hash']
    );
    userId = user.rows[0].id;
    console.log('Created temporary user', user.rows[0].email, 'id=' + userId);

    for (const slug of BUCKET_SLUGS) {
      const fraction = DEFAULT_BUCKET_TARGETS[String(slug).toUpperCase()] || 0;
      await pool.query(
        'INSERT INTO user_bucket_state (user_id, bucket_slug, target_pct, deposited_cents, spent_cents, remaining_cents) VALUES ($1, $2, $3, 0, 0, 0)',
        [userId, slug, Number((fraction * 100).toFixed(2))]
      );
    }
    console.log('Seeded default user_bucket_state for 6 buckets');

    await pool.query(
      "INSERT INTO debts (user_id, name, balance, interest_rate, minimum_payment, current_payment, notes) VALUES ($1, 'Test Card Apex', 180.00, 24.99, 25.00, 25.00, 'engine-test'), ($1, 'Test Card Bravo', 400.00, 19.99, 20.00, 20.00, 'engine-test'), ($1, 'Test Student Loan', 900.00, 5.50, 40.00, 40.00, 'engine-test below APR floor')",
      [userId]
    );
    console.log('Seeded high-interest test debts (24.99%, 19.99%, 5.50%)');

    const result = await processIncomeAllocationSweep(userId, INCOME, SOURCE);

    console.log('');
    console.log('=== Bucket allocations ===');
    let allocSum = 0;
    for (const row of result.allocations || []) {
      allocSum += Number(row.amount_cents);
      console.log('  ' + String(row.bucket_slug).padEnd(12), String(row.target_pct).padStart(5) + '%', '$' + Number(row.amount).toFixed(2), '(' + row.amount_cents + ' cents)');
    }

    console.log('');
    console.log('=== Cent-exact math ===');
    ok = (allocSum === INCOME_CENTS ? pass('allocations sum to ' + INCOME_CENTS + ' cents ($' + dollars(INCOME_CENTS) + ')') : fail('allocations sum ' + allocSum + ' !== ' + INCOME_CENTS)) && ok;

    const expected = { necessities: 125000, reserve: 25000, velocity: 25000, growth: 25000, lifestyle: 25000, legacy: 25000 };
    for (const row of result.allocations || []) {
      const want = expected[row.bucket_slug];
      if (want == null) continue;
      ok = (Number(row.amount_cents) === want ? pass(row.bucket_slug + ' = ' + want + ' cents') : fail(row.bucket_slug + ' = ' + row.amount_cents + ' expected ' + want)) && ok;
    }

    console.log('');
    console.log('=== Avalanche sweep ===');
    const sweep = result.sweep || {};
    console.log('  surplus    $' + Number(sweep.surplus || 0).toFixed(2), '(' + sweep.surplus_cents + ' cents)');
    console.log('  applied    $' + Number(sweep.applied || 0).toFixed(2), '(' + sweep.applied_cents + ' cents)');
    console.log('  leftover   $' + Number(sweep.leftover || 0).toFixed(2), '(' + sweep.leftover_cents + ' cents)');
    for (const target of sweep.targets || []) {
      console.log('  ->', target.name, target.interest_rate + '%', 'applied $' + Number(target.applied).toFixed(2), 'remaining $' + Number(target.remaining_balance).toFixed(2));
    }

    ok = (sweep.surplus_cents === 25000 ? pass('velocity surplus is 25000 cents') : fail('velocity surplus ' + sweep.surplus_cents + ' !== 25000')) && ok;
    const targets = sweep.targets || [];
    ok = (targets.length === 2 ? pass('two higher-rate debts targeted (5.50% loan not reached)') : fail('expected 2 sweep targets, got ' + targets.length)) && ok;
    if (targets[0]) {
      ok = (targets[0].interest_rate === 24.99 && targets[0].applied_cents === 18000 ? pass('highest APR (24.99%) received $180.00 first') : fail('first target should be 24.99% for 18000 cents')) && ok;
    }
    if (targets[1]) {
      ok = (targets[1].interest_rate === 19.99 && targets[1].applied_cents === 7000 ? pass('next APR (19.99%) received remaining $70.00') : fail('second target should be 19.99% for 7000 cents')) && ok;
    }
    ok = (sweep.applied_cents === 25000 && sweep.leftover_cents === 0 ? pass('full surplus applied, leftover 0') : fail('applied/leftover mismatch')) && ok;

    console.log('');
    console.log('=== Summary ===');
    console.log(JSON.stringify({
      transaction_id: result.transaction_id,
      income: result.income,
      allocations: result.allocations,
      sweep: result.sweep,
      checks_passed: ok
    }, null, 2));

    if (!ok) throw new Error('One or more engine checks failed');
    console.log('');
    console.log('Engine test passed.');
  } finally {
    await cleanup(userId);
    await pool.end();
  }
}

main().catch(function (err) {
  console.error('');
  console.error('Engine test failed:', err.message);
  process.exit(1);
});
