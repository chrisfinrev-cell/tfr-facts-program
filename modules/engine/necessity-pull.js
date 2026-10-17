'use strict';

/**
 * Starting split is 50/10/10/10/10/10.
 * When Necessity is above 50, pull share in this order:
 * Legacy, Growth, Velocity, Reserve, then Lifestyle.
 * Lifestyle stays at 10 until the other four are each at 5.
 * After that, take 1 point at a time from each of the five, in that same order,
 * until Necessity is covered. Necessity can reach 100.
 * When Necessity is under 50 and Reserve is still short of 12 months,
 * split the unused share evenly across Reserve, Velocity, Growth, and Legacy.
 * The reserve step-down ladder does not run in that case.
 * When Reserve already holds 12 months, split the unused share in whole
 * percentage points across Velocity, Growth, and Legacy. Remainder points
 * go to Velocity, then Growth, then Legacy. Reserve stays at 10 here so
 * reserve-velocity-protocol.js can route that original 10%:
 * 5% Velocity, 2% Growth, 2% Legacy, and 1% the household assigns.
 * The 6-month and 12-month celebration months are not applied here.
 * Recomputing from the current Necessity percent restores the over-50 pull.
 */

const START = Object.freeze({
  NECESSITIES: 50,
  RESERVE: 10,
  VELOCITY: 10,
  GROWTH: 10,
  LIFESTYLE: 10,
  LEGACY: 10
});

const PHASE_ONE = Object.freeze(['LEGACY', 'GROWTH', 'VELOCITY', 'RESERVE']);
const PHASE_TWO = Object.freeze(['LEGACY', 'GROWTH', 'VELOCITY', 'RESERVE', 'LIFESTYLE']);
const UNDER_SHORT = Object.freeze(['RESERVE', 'VELOCITY', 'GROWTH', 'LEGACY']);
const UNDER_FULL = Object.freeze(['VELOCITY', 'GROWTH', 'LEGACY']);
const FLOOR = 5;

function addEven(shares, freed, keys) {
  const each = freed / keys.length;
  keys.forEach((key) => {
    shares[key] += each;
  });
}

function addWholePoints(shares, freed, keys) {
  const base = Math.floor(freed / keys.length);
  let remainder = freed - (base * keys.length);
  keys.forEach((key) => {
    shares[key] += base;
  });
  for (let i = 0; i < remainder; i += 1) {
    shares[keys[i]] += 1;
  }
}

function asWholePercent(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  const percent = n > 1 ? n : n * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function reserveIsFull(options) {
  if (!options || typeof options !== 'object') return false;
  if (options.reserveFull === true || options.reserve_full === true) return true;
  const months = Number(options.reserveMonths ?? options.reserve_months);
  return Number.isFinite(months) && months >= 12;
}

function blankShares() {
  return {
    NECESSITIES: START.NECESSITIES,
    RESERVE: START.RESERVE,
    VELOCITY: START.VELOCITY,
    GROWTH: START.GROWTH,
    LIFESTYLE: START.LIFESTYLE,
    LEGACY: START.LEGACY
  };
}

function sharesForNecessity(necessityPercent, options) {
  const target = asWholePercent(necessityPercent);
  const shares = blankShares();

  if (target < 50) {
    const freed = 50 - target;
    shares.NECESSITIES = target;
    if (reserveIsFull(options)) addWholePoints(shares, freed, UNDER_FULL);
    else addEven(shares, freed, UNDER_SHORT);
  } else if (target > 50) {
    let gap = target - 50;

    for (const bucket of PHASE_ONE) {
      if (gap <= 0) break;
      const available = shares[bucket] - FLOOR;
      const take = Math.min(available, gap);
      shares[bucket] -= take;
      shares.NECESSITIES += take;
      gap -= take;
    }

    while (gap > 0) {
      let moved = false;
      for (const bucket of PHASE_TWO) {
        if (gap <= 0) break;
        if (shares[bucket] <= 0) continue;
        shares[bucket] -= 1;
        shares.NECESSITIES += 1;
        gap -= 1;
        moved = true;
      }
      if (!moved) break;
    }
  }

  const percents = {};
  const fractions = {};
  Object.keys(START).forEach((key) => {
    percents[key] = shares[key];
    fractions[key] = shares[key] / 100;
  });

  return {
    necessity_percent: target,
    reserve_full: reserveIsFull(options),
    percents,
    fractions
  };
}

module.exports = {
  START,
  sharesForNecessity
};
