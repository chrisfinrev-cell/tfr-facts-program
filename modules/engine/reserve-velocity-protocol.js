'use strict';

/**
 * Progressive Reserve, Velocity Engine, and Milestone Protocol.
 *
 * Starting pair is Reserve 10% / Velocity 10%. As months of reserve build,
 * points step from Reserve into Velocity. At 12 months Reserve funding halts.
 * The 6-month (5%) and 12-month (10%) Lifestyle celebrations each pay once.
 * Flags stay claimed if reserves later fall and are rebuilt.
 *
 * Steady-state routing of the original Reserve allocation starts on the
 * allocation after the 12-month celebration, not on the celebration itself:
 *   5% Velocity, 2% Growth, 2% Legacy, 1% discretionary (default Lifestyle).
 * If Necessity is under 50, the step-down ladder and its celebrations do not
 * run. A completed 12-month reserve still routes the original 10%.
 * If reserves fall below a claimed milestone and Necessity is at least 50,
 * that routing stops and the pair reverts to the tier those months still support.
 *
 * Necessity pull stays in necessity-pull.js. This module adjusts the shares
 * that pull already produced. Lifestyle or discretionary points the user
 * dials down are added to Velocity.
 */

const KEYS = Object.freeze([
  'NECESSITIES', 'RESERVE', 'VELOCITY', 'GROWTH', 'LIFESTYLE', 'LEGACY'
]);

const PULL_FROM = Object.freeze(['RESERVE', 'VELOCITY', 'GROWTH', 'LEGACY']);

const OVERFLOW = Object.freeze([
  { key: 'VELOCITY', ratio: 0.5 },
  { key: 'GROWTH', ratio: 0.2 },
  { key: 'LEGACY', ratio: 0.2 },
  { key: 'DISCRETIONARY', ratio: 0.1 }
]);

const CELEBRATION_6M = 5;
const CELEBRATION_12M = 10;
const FLAG_6M = '6M_Celebration_Claimed';
const FLAG_12M = '12M_Celebration_Claimed';

const TIER_MECHANICS = Object.freeze({
  baseline: 'Baseline allocation balancing survival safety with initial capital cycling.',
  '3m': 'Milestone transfer: 2% shifts from Reserve to Velocity to increase short-term deployment power.',
  '6m': 'Milestone transfer: additional 2% shifts to Velocity.',
  '9m': 'Milestone transfer: additional 1% shifts to Velocity, maximizing pre-12-month capital rotation.',
  '12m': '12-month threshold reached: Reserve funding halts.'
});

function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pick(source, keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return undefined;
}

function readFlag(source, keys) {
  const raw = pick(source, keys);
  if (raw === undefined) return undefined;
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

function readProtocolOptions(source) {
  const lifestyle = pick(source, ['lifestylePercent', 'lifestyle_percent']);
  const discretionary = pick(source, ['discretionaryPercent', 'discretionary_percent']);
  const bucket = pick(source, ['discretionaryBucket', 'discretionary_bucket']);
  return {
    reserveMonths: pick(source, ['reserveMonths', 'reserve_months']),
    reserveFull: pick(source, ['reserveFull', 'reserve_full']),
    celebration6mClaimed: readFlag(source, [
      'celebration6mClaimed',
      'celebration_6m_claimed',
      FLAG_6M
    ]),
    celebration12mClaimed: readFlag(source, [
      'celebration12mClaimed',
      'celebration_12m_claimed',
      FLAG_12M
    ]),
    discretionaryBucket: bucket === undefined || bucket === null || bucket === ''
      ? undefined
      : String(bucket).toLowerCase(),
    lifestylePercent: lifestyle === undefined ? undefined : lifestyle,
    discretionaryPercent: discretionary === undefined ? undefined : discretionary
  };
}

function mergeProtocolOptions(stored, requested) {
  const req = readProtocolOptions(requested);
  const row = stored || {};
  const storedMonths = row.reserve_months;
  const months = req.reserveMonths !== undefined && req.reserveMonths !== null && req.reserveMonths !== ''
    ? req.reserveMonths
    : storedMonths;
  const lifestyle = req.lifestylePercent !== undefined ? req.lifestylePercent : row.lifestyle_cap;
  const discretionary = req.discretionaryPercent !== undefined
    ? req.discretionaryPercent
    : row.discretionary_cap;
  return {
    reserveMonths: months === undefined || months === null || months === '' ? undefined : months,
    reserveFull: req.reserveFull,
    celebration6mClaimed: row.celebration_6m_claimed === true || req.celebration6mClaimed === true,
    celebration12mClaimed: row.celebration_12m_claimed === true || req.celebration12mClaimed === true,
    discretionaryBucket: req.discretionaryBucket || row.discretionary_bucket || 'lifestyle',
    lifestylePercent: lifestyle === undefined ? undefined : lifestyle,
    discretionaryPercent: discretionary === undefined ? undefined : discretionary
  };
}

function protocolEngaged(options) {
  if (!options) return false;
  if (finiteOrNull(options.reserveMonths) !== null) return true;
  if (finiteOrNull(options.lifestylePercent) !== null) return true;
  if (finiteOrNull(options.discretionaryPercent) !== null) return true;
  return false;
}

function monthsOf(options) {
  const n = finiteOrNull(options && options.reserveMonths);
  if (n === null) return 0;
  return Math.max(0, n);
}

function tierForMonths(months) {
  const covered = Math.max(0, Number(months) || 0);
  if (covered >= 12) {
    return { id: '12m', months: covered, shift: 0, steady: true };
  }
  if (covered >= 9) {
    return { id: '9m', months: covered, shift: 5, steady: false };
  }
  if (covered >= 6) {
    return { id: '6m', months: covered, shift: 4, steady: false };
  }
  if (covered >= 3) {
    return { id: '3m', months: covered, shift: 2, steady: false };
  }
  return { id: 'baseline', months: covered, shift: 0, steady: false };
}

function toUnits(percents) {
  const units = {};
  KEYS.forEach((key) => {
    units[key] = Math.round(Number(percents && percents[key] || 0) * 100);
  });
  return units;
}

function percentMap(units) {
  const percents = {};
  const fractions = {};
  KEYS.forEach((key) => {
    percents[key] = units[key] / 100;
    fractions[key] = units[key] / 10000;
  });
  return { percents, fractions };
}

function discretionaryKey(bucket) {
  const name = String(bucket || 'lifestyle').toLowerCase();
  const key = name.toUpperCase();
  if (key === 'RESERVE' || KEYS.indexOf(key) === -1) return 'LIFESTYLE';
  return key;
}

function pull(units, dest, amount) {
  let need = amount;
  for (const src of PULL_FROM) {
    if (need <= 0) break;
    if (src === dest) continue;
    const take = Math.min(units[src], need);
    units[src] -= take;
    units[dest] += take;
    need -= take;
  }
  return amount - need;
}

function splitUnits(total, parts) {
  const raw = parts.map((part) => {
    const exact = total * part.ratio;
    const units = Math.floor(exact);
    return { key: part.key, units, remainder: exact - units };
  });
  let leftover = total - raw.reduce((sum, part) => sum + part.units, 0);
  raw.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < raw.length && leftover > 0; i += 1, leftover -= 1) {
    raw[i].units += 1;
  }
  return raw;
}

function capUnits(value) {
  const n = finiteOrNull(value);
  if (n === null || n < 0) return null;
  return Math.round(n * 100);
}

function applyReserveVelocityProtocol(percents, options) {
  const input = options || {};
  const months = monthsOf(input);
  const tier = tierForMonths(months);
  const already6 = input.celebration6mClaimed === true;
  const already12 = input.celebration12mClaimed === true;
  const units = toUnits(percents);
  const celebrations = [];
  let claimed6 = already6;
  let claimed12 = already12;
  let celebrationAdded = 0;
  const necessityBelow = units.NECESSITIES < 5000;

  if (!necessityBelow && months < 12 && tier.shift > 0) {
    const shiftUnits = Math.round(tier.shift * 100);
    const moved = Math.min(units.RESERVE, shiftUnits);
    units.RESERVE -= moved;
    units.VELOCITY += moved;
  }

  if (!necessityBelow && months >= 6 && !already6) {
    const want = CELEBRATION_6M * 100;
    const applied = pull(units, 'LIFESTYLE', want);
    celebrationAdded += applied;
    claimed6 = true;
    celebrations.push({
      flag: FLAG_6M,
      percent: CELEBRATION_6M,
      applied_percent: applied / 100
    });
  }

  if (!necessityBelow && months >= 12 && !already12) {
    const want = CELEBRATION_12M * 100;
    const applied = pull(units, 'LIFESTYLE', want);
    celebrationAdded += applied;
    claimed12 = true;
    celebrations.push({
      flag: FLAG_12M,
      percent: CELEBRATION_12M,
      applied_percent: applied / 100
    });
  }

  if (necessityBelow && months >= 12) {
    claimed6 = true;
    claimed12 = true;
  }

  const overflowReady = months >= 12 && (already12 || necessityBelow);
  let overflow = null;
  if (overflowReady) {
    const pool = units.RESERVE;
    units.RESERVE = 0;
    const parts = splitUnits(pool, OVERFLOW);
    const applied = { velocity: 0, growth: 0, legacy: 0, discretionary: 0 };
    let discretionaryUnits = 0;
    parts.forEach((part) => {
      if (part.key === 'DISCRETIONARY') {
        discretionaryUnits = part.units;
        applied.discretionary = part.units / 100;
        return;
      }
      units[part.key] += part.units;
      applied[part.key.toLowerCase()] = part.units / 100;
    });

    const discCap = capUnits(input.discretionaryPercent);
    let discretionaryReclaimed = 0;
    if (discCap !== null && discCap < discretionaryUnits) {
      discretionaryReclaimed = discretionaryUnits - discCap;
      discretionaryUnits = discCap;
      units.VELOCITY += discretionaryReclaimed;
      applied.discretionary = discretionaryUnits / 100;
    }

    const discKey = discretionaryKey(input.discretionaryBucket);
    units[discKey] += discretionaryUnits;
    overflow = {
      velocity: applied.velocity,
      growth: applied.growth,
      legacy: applied.legacy,
      discretionary: applied.discretionary,
      discretionary_bucket: discKey.toLowerCase(),
      discretionary_reclaimed: discretionaryReclaimed / 100
    };
  }

  const lifestyleCap = capUnits(input.lifestylePercent);
  const ongoingLifestyle = units.LIFESTYLE - celebrationAdded;
  let lifestyleReclaimed = 0;
  if (lifestyleCap !== null && lifestyleCap < ongoingLifestyle) {
    lifestyleReclaimed = ongoingLifestyle - lifestyleCap;
    units.LIFESTYLE -= lifestyleReclaimed;
    units.VELOCITY += lifestyleReclaimed;
  }

  const sum = KEYS.reduce((total, key) => total + units[key], 0);
  if (sum !== 10000) units.VELOCITY += 10000 - sum;
  if (KEYS.some((key) => units[key] < 0)) {
    throw new Error('Reserve protocol produced a negative bucket');
  }

  const mapped = percentMap(units);
  const reverted = (claimed12 && months < 12) || (claimed6 && months < 6);
  const mechanics = describeTier(tier, {
    celebrations,
    overflowReady,
    reverted,
    overflowStartsNext: months >= 12 && !already12 && !necessityBelow
  });

  const expansionRouted = (lifestyleReclaimed / 100)
    + (overflow ? overflow.discretionary_reclaimed : 0);

  return {
    tier: tier.id,
    reserve_months: months,
    steady_state: overflowReady,
    overflow_starts_next: months >= 12 && !already12 && !necessityBelow,
    reverted,
    velocity_mode: overflowReady ? 'dynamic' : 'fixed',
    mechanics,
    percents: mapped.percents,
    fractions: mapped.fractions,
    flags: {
      [FLAG_6M]: claimed6,
      [FLAG_12M]: claimed12
    },
    celebrations,
    overflow,
    expansion: {
      lifestyle_reclaimed: lifestyleReclaimed / 100,
      discretionary_reclaimed: overflow ? overflow.discretionary_reclaimed : 0,
      routed_to_velocity: expansionRouted
    },
    state: {
      celebration_6m_claimed: claimed6,
      celebration_12m_claimed: claimed12,
      reserve_months: months,
      discretionary_bucket: discretionaryKey(input.discretionaryBucket).toLowerCase(),
      lifestyle_cap: finiteOrNull(input.lifestylePercent),
      discretionary_cap: finiteOrNull(input.discretionaryPercent)
    }
  };
}

function describeTier(tier, context) {
  const parts = [];
  if (context.reverted) {
    parts.push('Steady-state distributions are suspended. Ongoing allocations reverted to the current reserve tier. Celebration flags stay claimed.');
  }
  parts.push(TIER_MECHANICS[tier.id]);
  context.celebrations.forEach((item) => {
    parts.push('One-time ' + item.applied_percent + '% Lifestyle celebration claimed (' + item.flag + ' = TRUE).');
  });
  if (context.overflowReady) {
    parts.push('Original Reserve allocation routes 5% to Velocity, 2% to Growth, 2% to Legacy, and 1% to discretionary.');
  } else if (context.overflowStartsNext) {
    parts.push('Steady-state overflow begins on the next allocation, after this celebration.');
  }
  return parts.filter(Boolean).join(' ');
}

module.exports = {
  KEYS,
  FLAG_6M,
  FLAG_12M,
  CELEBRATION_6M,
  CELEBRATION_12M,
  tierForMonths,
  readProtocolOptions,
  mergeProtocolOptions,
  protocolEngaged,
  applyReserveVelocityProtocol
};
