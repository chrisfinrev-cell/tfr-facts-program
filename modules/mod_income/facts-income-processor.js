'use strict';

const { withManualExecutionNotice } = require('../shared/edu-compliance');
const { DEFAULT_BUCKET_TARGETS } = require('../shared/constants');

const BUCKETS = Object.freeze([
  'NECESSITIES', 'RESERVE', 'VELOCITY', 'GROWTH', 'LIFESTYLE', 'LEGACY'
]);

function emptyBuckets() {
  return { NECESSITIES: 0, RESERVE: 0, VELOCITY: 0, GROWTH: 0, LIFESTYLE: 0, LEGACY: 0 };
}

function round2(n) {
  return Number((Number(n) || 0).toFixed(2));
}

function processIncomeTransaction(payload, customSplits = DEFAULT_BUCKET_TARGETS) {
  const {
    calculation_mode = 'GROSS',
    gross_amount = 0,
    net_amount = 0,
    employer_match = 0,
    employer_match_target = 'GROWTH',
    deductions = []
  } = payload || {};

  const splits = customSplits && typeof customSplits === 'object'
    ? customSplits
    : DEFAULT_BUCKET_TARGETS;

  const bucketAllocations = emptyBuckets();
  const mode = String(calculation_mode || 'GROSS').toUpperCase() === 'NET' ? 'NET' : 'GROSS';
  const gross = Number(gross_amount) || 0;
  const net = Number(net_amount) || 0;
  const matchAmt = Number(employer_match) || 0;

  let totalPreTaxOffPulls = 0;
  if (mode === 'GROSS') {
    (Array.isArray(deductions) ? deductions : []).forEach((item) => {
      const amt = Number(item.amount) || 0;
      const bucket = item && item.target_bucket;
      if (bucketAllocations[bucket] !== undefined) {
        bucketAllocations[bucket] += amt;
        totalPreTaxOffPulls += amt;
      }
    });
  }

  if (matchAmt > 0) {
    const matchBucket = BUCKETS.includes(employer_match_target)
      ? employer_match_target
      : 'GROWTH';
    bucketAllocations[matchBucket] += matchAmt;
  }

  const liquidTakeHome = mode === 'GROSS' ? gross - totalPreTaxOffPulls : net;
  const totalEconomicCompensation = (mode === 'GROSS' ? gross : net) + matchAmt;

  Object.keys(splits).forEach((bucket) => {
    if (bucketAllocations[bucket] === undefined) return;
    bucketAllocations[bucket] += round2(liquidTakeHome * Number(splits[bucket] || 0));
  });

  Object.keys(bucketAllocations).forEach((bucket) => {
    bucketAllocations[bucket] = round2(bucketAllocations[bucket]);
  });

  const liquid = round2(liquidTakeHome);

  return withManualExecutionNotice({
    status: 'calculated',
    summary: {
      total_economic_compensation: round2(totalEconomicCompensation),
      total_pre_tax_off_pulls: round2(totalPreTaxOffPulls),
      net_liquid_take_home: liquid,
      liquid_take_home: liquid
    },
    bucket_allocations: bucketAllocations
  });
}

module.exports = { processIncomeTransaction, BUCKETS };
