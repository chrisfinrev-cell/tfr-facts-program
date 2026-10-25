'use strict';

const assert = require('assert');
const { sharesForNecessity } = require('../modules/engine/necessity-pull');
const { processIncomeTransaction } = require('../modules/engine/facts-income-processor');
const {
  applyReserveVelocityProtocol,
  mergeProtocolOptions
} = require('../modules/engine/reserve-velocity-protocol');

const BASE = {
  NECESSITIES: 50,
  RESERVE: 10,
  VELOCITY: 10,
  GROWTH: 10,
  LIFESTYLE: 10,
  LEGACY: 10
};

function apply(months, extra) {
  return applyReserveVelocityProtocol(BASE, Object.assign({ reserveMonths: months }, extra || {}));
}

function sumOf(percents) {
  return Object.keys(percents).reduce((total, key) => total + percents[key], 0);
}

function assertSplit(percents, expected) {
  Object.keys(expected).forEach((key) => {
    assert.strictEqual(percents[key], expected[key], key + ' expected ' + expected[key] + ' got ' + percents[key]);
  });
  assert.strictEqual(sumOf(percents), 100);
}

let checks = 0;

function check(name, fn) {
  fn();
  checks += 1;
  console.log('PASS  ' + name);
}

check('baseline under 3 months keeps 10/10', () => {
  const result = apply(2.9);
  assertSplit(result.percents, BASE);
  assert.strictEqual(result.tier, 'baseline');
  assert.strictEqual(result.flags['6M_Celebration_Claimed'], false);
  assert.strictEqual(result.flags['12M_Celebration_Claimed'], false);
  assert.strictEqual(result.celebrations.length, 0);
});

check('3 months shifts 2 points from Reserve to Velocity', () => {
  const result = apply(3);
  assertSplit(result.percents, Object.assign({}, BASE, { RESERVE: 8, VELOCITY: 12 }));
  assert.strictEqual(result.tier, '3m');
});

check('6-month claim pays 5% to Lifestyle once and leaves the ladder in place', () => {
  const first = apply(6);
  assertSplit(first.percents, Object.assign({}, BASE, { RESERVE: 1, VELOCITY: 14, LIFESTYLE: 15 }));
  assert.strictEqual(first.flags['6M_Celebration_Claimed'], true);
  assert.strictEqual(first.celebrations.length, 1);
  assert.strictEqual(first.celebrations[0].percent, 5);

  const second = apply(6, { celebration6mClaimed: true });
  assertSplit(second.percents, Object.assign({}, BASE, { RESERVE: 6, VELOCITY: 14 }));
  assert.strictEqual(second.celebrations.length, 0);
  assert.strictEqual(second.flags['6M_Celebration_Claimed'], true);
});

check('9 months holds Reserve 5 and Velocity 15 after the 6-month flag', () => {
  const result = apply(9, { celebration6mClaimed: true });
  assertSplit(result.percents, Object.assign({}, BASE, { RESERVE: 5, VELOCITY: 15 }));
  assert.strictEqual(result.tier, '9m');
  assert.strictEqual(result.steady_state, false);
});

check('12-month claim pays 10% to Lifestyle and defers overflow', () => {
  const claim = apply(12, { celebration6mClaimed: true });
  assertSplit(claim.percents, Object.assign({}, BASE, { RESERVE: 0, LIFESTYLE: 20 }));
  assert.strictEqual(claim.flags['12M_Celebration_Claimed'], true);
  assert.strictEqual(claim.steady_state, false);
  assert.strictEqual(claim.overflow_starts_next, true);
  assert.strictEqual(claim.overflow, null);

  const steady = apply(12, { celebration6mClaimed: true, celebration12mClaimed: true });
  assertSplit(steady.percents, {
    NECESSITIES: 50,
    RESERVE: 0,
    VELOCITY: 15,
    GROWTH: 12,
    LIFESTYLE: 11,
    LEGACY: 12
  });
  assert.strictEqual(steady.steady_state, true);
  assert.strictEqual(steady.velocity_mode, 'dynamic');
  assert.strictEqual(steady.overflow.discretionary_bucket, 'lifestyle');
  assert.strictEqual(steady.celebrations.length, 0);
});

check('arriving at 12 months with neither flag pays both celebrations once', () => {
  const claim = apply(14);
  assertSplit(claim.percents, {
    NECESSITIES: 50,
    RESERVE: 0,
    VELOCITY: 5,
    GROWTH: 10,
    LIFESTYLE: 25,
    LEGACY: 10
  });
  assert.strictEqual(claim.flags['6M_Celebration_Claimed'], true);
  assert.strictEqual(claim.flags['12M_Celebration_Claimed'], true);

  const again = apply(14, {
    celebration6mClaimed: true,
    celebration12mClaimed: true
  });
  assert.strictEqual(again.celebrations.length, 0);
  assert.strictEqual(again.percents.VELOCITY, 15);
  assert.strictEqual(again.percents.LIFESTYLE, 11);
});

check('a reserve drop reverts the tier and does not pay the celebration again', () => {
  const dropped = apply(4, { celebration6mClaimed: true, celebration12mClaimed: true });
  assertSplit(dropped.percents, Object.assign({}, BASE, { RESERVE: 8, VELOCITY: 12 }));
  assert.strictEqual(dropped.tier, '3m');
  assert.strictEqual(dropped.reverted, true);
  assert.strictEqual(dropped.steady_state, false);
  assert.strictEqual(dropped.celebrations.length, 0);

  const recovered = apply(12, { celebration6mClaimed: true, celebration12mClaimed: true });
  assert.strictEqual(recovered.steady_state, true);
  assert.strictEqual(recovered.reverted, false);
  assert.strictEqual(recovered.percents.VELOCITY, 15);
});

check('dialed-back Lifestyle and discretionary points route to Velocity', () => {
  const result = apply(12, {
    celebration6mClaimed: true,
    celebration12mClaimed: true,
    lifestylePercent: 8,
    discretionaryPercent: 0
  });
  assertSplit(result.percents, {
    NECESSITIES: 50,
    RESERVE: 0,
    VELOCITY: 18,
    GROWTH: 12,
    LIFESTYLE: 8,
    LEGACY: 12
  });
  assert.strictEqual(result.expansion.routed_to_velocity, 3);
});

check('discretionary 1% can be aimed at Growth', () => {
  const result = apply(12, {
    celebration6mClaimed: true,
    celebration12mClaimed: true,
    discretionaryBucket: 'growth'
  });
  assert.strictEqual(result.percents.GROWTH, 13);
  assert.strictEqual(result.percents.LIFESTYLE, 10);
  assert.strictEqual(result.percents.VELOCITY, 15);
  assert.strictEqual(result.percents.LEGACY, 12);
  assert.strictEqual(sumOf(result.percents), 100);
});

check('a stored celebration flag cannot be cleared by a later false', () => {
  const merged = mergeProtocolOptions(
    { celebration_6m_claimed: true, celebration_12m_claimed: true, reserve_months: 12 },
    { '6M_Celebration_Claimed': false, reserveMonths: 4 }
  );
  assert.strictEqual(merged.celebration6mClaimed, true);
  assert.strictEqual(merged.celebration12mClaimed, true);
  assert.strictEqual(Number(merged.reserveMonths), 4);
});

check('necessity pull still runs, then the ladder shifts Reserve and Velocity', () => {
  const base = sharesForNecessity(60, { reserveMonths: 3 }).percents;
  const result = applyReserveVelocityProtocol(base, { reserveMonths: 3 });
  assert.strictEqual(result.percents.NECESSITIES, 60);
  assert.strictEqual(result.percents.RESERVE, 8);
  assert.strictEqual(result.percents.VELOCITY, 12);
  assert.strictEqual(sumOf(result.percents), 100);
});

check('paycheck math follows the 9-month ladder and the post-celebration overflow', () => {
  const nine = processIncomeTransaction({
    calculation_mode: 'GROSS',
    gross_amount: 1000,
    necessity_percent: 50,
    reserve_months: 9,
    celebration_6m_claimed: true
  });
  assert.strictEqual(nine.bucket_allocations.RESERVE, 50);
  assert.strictEqual(nine.bucket_allocations.VELOCITY, 150);
  assert.strictEqual(nine.reserve_protocol.tier, '9m');

  const steady = processIncomeTransaction({
    calculation_mode: 'GROSS',
    gross_amount: 1000,
    necessity_percent: 50,
    reserve_months: 12,
    '6M_Celebration_Claimed': true,
    '12M_Celebration_Claimed': true
  });
  assert.strictEqual(steady.bucket_allocations.RESERVE, 0);
  assert.strictEqual(steady.bucket_allocations.VELOCITY, 150);
  assert.strictEqual(steady.bucket_allocations.GROWTH, 120);
  assert.strictEqual(steady.bucket_allocations.LEGACY, 120);
  assert.strictEqual(steady.bucket_allocations.LIFESTYLE, 110);
  assert.strictEqual(steady.bucket_allocations.NECESSITIES, 500);
});

check('35% necessity skips the ladder while reserves are still needed', () => {
  const base = sharesForNecessity(35, { reserveMonths: 4 }).percents;
  const result = applyReserveVelocityProtocol(base, { reserveMonths: 4 });
  assertSplit(result.percents, {
    NECESSITIES: 35,
    RESERVE: 13.75,
    VELOCITY: 13.75,
    GROWTH: 13.75,
    LIFESTYLE: 10,
    LEGACY: 13.75
  });
  assert.strictEqual(result.celebrations.length, 0);
  assert.strictEqual(result.steady_state, false);
});

check('35% necessity with a completed reserve lands on 20/17/17 and 1% discretion', () => {
  const base = sharesForNecessity(35, { reserveMonths: 12 }).percents;
  const result = applyReserveVelocityProtocol(base, {
    reserveMonths: 12,
    discretionaryBucket: 'lifestyle'
  });
  assertSplit(result.percents, {
    NECESSITIES: 35,
    RESERVE: 0,
    VELOCITY: 20,
    GROWTH: 17,
    LIFESTYLE: 11,
    LEGACY: 17
  });
  assert.strictEqual(result.steady_state, true);
  assert.strictEqual(result.celebrations.length, 0);
});

check('shares stay at 100 with no negative bucket across the ladder', () => {
  const necessities = [0, 40, 50, 60, 70, 100];
  const months = [0, 2.9, 3, 6, 9, 11.9, 12, 18];
  const flagSets = [
    {},
    { celebration6mClaimed: true },
    { celebration6mClaimed: true, celebration12mClaimed: true }
  ];
  necessities.forEach((necessity) => {
    months.forEach((monthsCovered) => {
      flagSets.forEach((flags) => {
        const base = sharesForNecessity(necessity, { reserveMonths: monthsCovered }).percents;
        const result = applyReserveVelocityProtocol(base, Object.assign({
          reserveMonths: monthsCovered,
          lifestylePercent: 8
        }, flags));
        assert.strictEqual(sumOf(result.percents), 100);
        Object.keys(result.percents).forEach((key) => {
          assert.ok(result.percents[key] >= 0, key + ' went negative');
        });
      });
    });
  });
});

console.log('');
console.log(checks + ' reserve protocol checks passed.');
