#!/usr/bin/env node
'use strict';

/**
 * Staging-only seed + engine check.
 *
 * Uses DATABASE_URL from .env.staging (never .env / .env.production).
 * Creates tagged synthetic users, runs the 10-tier orphan split engine and
 * 6-bucket allocation engine, then asserts user_bucket_state math.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const STAGING_ENV = path.join(__dirname, '..', '.env.staging');
const EMAIL_DOMAIN = 'facts-staging.test';
const INCOME_CENTS = 500000; // $5,000.00
const EXPENSES = Object.freeze({
  necessities: 120000,
  lifestyle: 8000,
  velocity: 5000
});
const TARGETS = Object.freeze({
  necessities: 50,
  reserve: 10,
  velocity: 10,
  growth: 10,
  lifestyle: 10,
  legacy: 10
});

function loadStagingEnv() {
  if (!fs.existsSync(STAGING_ENV)) {
    throw new Error('.env.staging not found');
  }
  const text = fs.readFileSync(STAGING_ENV, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const eq = trimmed.indexOf('=');
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key === 'DATABASE_URL') process.env.DATABASE_URL = value;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL missing from .env.staging');
  }
}

loadStagingEnv();

const { seedDefaultAllocations, DEFAULTS } = require('../modules/mod_affiliate/seed-allocations');
const { routeOrphanUser, decidePlacement } = require('../modules/mod_affiliate/orphan-router');
const { processIncomeTransaction } = require('../modules/mod_income/facts-income-processor');
const {
  CANONICAL_PILLARS,
  syncUserBucketState,
  getMonthlyBucketDepositsCents
} = require('../db/bucket-deposits');

function emailFor(role) {
  return 'staging.engine.seed+' + role + '@' + EMAIL_DOMAIN;
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertInteger(value, label) {
  assert(Number.isInteger(value), 'Cent-Standard violation: ' + label + ' must be integer, got ' + value);
}

function splitCents(totalCents, pctBySlug) {
  const keys = CANONICAL_PILLARS;
  const raw = keys.map((k) => Math.floor((totalCents * (pctBySlug[k] || 0)) / 100));
  const allocated = raw.reduce((a, b) => a + b, 0);
  raw[0] += totalCents - allocated;
  return Object.fromEntries(keys.map((k, i) => [k, raw[i]]));
}

async function upsertUser(pool, role, name) {
  const email = emailFor(role);
  const existing = await pool.query(
    `SELECT id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await pool.query(
    `INSERT INTO users (email, name, referral_code)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [email, name, 'SEED-' + role.toUpperCase().slice(0, 12)]
  );
  return inserted.rows[0].id;
}

async function upsertAffiliate(pool, userId, { master, orphans }) {
  const existing = await pool.query(
    `SELECT id FROM affiliates WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE affiliates
          SET is_master_node = $2,
              orphans_assigned_count = $3
        WHERE id = $1`,
      [existing.rows[0].id, !!master, orphans || 0]
    );
    return existing.rows[0].id;
  }
  const inserted = await pool.query(
    `INSERT INTO affiliates (user_id, is_master_node, orphans_assigned_count)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [userId, !!master, orphans || 0]
  );
  return inserted.rows[0].id;
}

async function wipeFinance(pool, userId) {
  await pool.query(
    `DELETE FROM transaction_allocations
      WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = $1)`,
    [userId]
  );
  await pool.query(`DELETE FROM transactions WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM user_bucket_state WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM user_allocations WHERE user_id = $1`, [userId]);
  await pool.query(
    `DELETE FROM mod_income.income_deductions
      WHERE paycheck_id IN (SELECT id FROM mod_income.paycheck_entries WHERE user_id = $1)
         OR entry_id IN (SELECT id FROM mod_income.paycheck_entries WHERE user_id = $1)`,
    [userId]
  ).catch(() => {});
  await pool.query(`DELETE FROM mod_income.paycheck_entries WHERE user_id = $1`, [userId]).catch(() => {});
}

async function seedIncomeAndExpenses(pool, userId, categoriesBySlug) {
  const deposits = splitCents(INCOME_CENTS, TARGETS);
  const income = await pool.query(
    `INSERT INTO transactions (user_id, type, amount_cents, description, occurred_at)
     VALUES ($1, 'income', $2, $3, NOW())
     RETURNING id`,
    [userId, INCOME_CENTS, 'Staging seed paycheck']
  );
  const incomeId = income.rows[0].id;
  for (const slug of CANONICAL_PILLARS) {
    const cat = categoriesBySlug[slug];
    assert(cat, 'missing category ' + slug);
    await pool.query(
      `INSERT INTO transaction_allocations
         (transaction_id, category_id, bucket_slug, percentage, amount_cents)
       VALUES ($1, $2, $3, $4, $5)`,
      [incomeId, cat.id, slug, TARGETS[slug], deposits[slug]]
    );
  }

  for (const slug of Object.keys(EXPENSES)) {
    const cents = EXPENSES[slug];
    const cat = categoriesBySlug[slug];
    const expense = await pool.query(
      `INSERT INTO transactions (user_id, type, amount_cents, description, occurred_at)
       VALUES ($1, 'expense', $2, $3, NOW())
       RETURNING id`,
      [userId, cents, 'Staging seed ' + slug + ' spend']
    );
    await pool.query(
      `INSERT INTO transaction_allocations
         (transaction_id, category_id, bucket_slug, percentage, amount_cents)
       VALUES ($1, $2, $3, 100, $4)`,
      [expense.rows[0].id, cat.id, slug, cents]
    );
  }

  const processed = processIncomeTransaction({
    calculation_mode: 'GROSS',
    gross_amount: INCOME_CENTS / 100,
    net_amount: INCOME_CENTS / 100,
    employer_match: 0,
    employer_match_target: 'GROWTH'
  });
  await pool.query(
    `INSERT INTO mod_income.paycheck_entries (
       user_id, source_name, entry_date, calculation_mode,
       gross_amount, net_amount, employer_match, employer_match_target,
       liquid_take_home, bucket_allocations, result
     ) VALUES ($1,$2,CURRENT_DATE,'GROSS',$3,$3,0,'GROWTH',$4,$5,$6)`,
    [
      userId,
      'Staging seed paycheck',
      INCOME_CENTS / 100,
      processed.summary.liquid_take_home,
      JSON.stringify(processed.bucket_allocations),
      JSON.stringify(processed.summary)
    ]
  );

  return { deposits, processed };
}

function expectedRemaining() {
  const deposits = splitCents(INCOME_CENTS, TARGETS);
  const remaining = {};
  for (const slug of CANONICAL_PILLARS) {
    remaining[slug] = deposits[slug] - (EXPENSES[slug] || 0);
  }
  return { deposits, remaining };
}

async function verifyBuckets(pool, userId, label) {
  const result = await syncUserBucketState(pool, userId);
  const liveDeposits = await getMonthlyBucketDepositsCents(pool, userId);
  const expected = expectedRemaining();
  const errors = [];

  assert(result.rows.length === 6, label + ': expected 6 user_bucket_state rows, got ' + result.rows.length);

  let targetSum = 0;
  let depositSum = 0;
  for (const row of result.rows) {
    const slug = row.bucket_slug;
    const deposited = parseInt(row.deposited_cents, 10);
    const spent = parseInt(row.spent_cents, 10);
    const remaining = parseInt(row.remaining_cents, 10);
    const target = Number(row.target_pct);
    targetSum += target;
    depositSum += deposited;

    assertInteger(deposited, label + '.' + slug + '.deposited_cents');
    assertInteger(spent, label + '.' + slug + '.spent_cents');
    assertInteger(remaining, label + '.' + slug + '.remaining_cents');

    if (deposited !== expected.deposits[slug]) {
      errors.push(slug + ' deposited ' + deposited + ' != ' + expected.deposits[slug]);
    }
    if (deposited !== liveDeposits[slug]) {
      errors.push(slug + ' deposited mismatch vs engine ' + deposited + ' != ' + liveDeposits[slug]);
    }
    if (spent !== (EXPENSES[slug] || 0)) {
      errors.push(slug + ' spent ' + spent + ' != ' + (EXPENSES[slug] || 0));
    }
    if (remaining !== deposited - spent) {
      errors.push(slug + ' remaining ' + remaining + ' != ' + deposited + '-' + spent);
    }
    if (remaining !== expected.remaining[slug]) {
      errors.push(slug + ' remaining ' + remaining + ' != expected ' + expected.remaining[slug]);
    }
    if (target !== TARGETS[slug]) {
      errors.push(slug + ' target_pct ' + target + ' != ' + TARGETS[slug]);
    }
  }

  if (depositSum !== INCOME_CENTS) {
    errors.push('deposit sum ' + depositSum + ' != income ' + INCOME_CENTS);
  }
  if (targetSum !== 100) {
    errors.push('target_pct sum ' + targetSum + ' != 100');
  }

  const processor = result && result.rows ? processIncomeTransaction({
    calculation_mode: 'GROSS',
    gross_amount: INCOME_CENTS / 100,
    net_amount: INCOME_CENTS / 100
  }) : null;
  if (processor) {
    const dollars = CANONICAL_PILLARS.reduce((sum, slug) => {
      return sum + Number(processor.bucket_allocations[slug.toUpperCase()] || 0);
    }, 0);
    if (Math.round(dollars * 100) !== INCOME_CENTS) {
      errors.push('income processor split ' + Math.round(dollars * 100) + ' != ' + INCOME_CENTS);
    }
  }

  if (errors.length) {
    throw new Error(label + ' bucket verification failed:\n  - ' + errors.join('\n  - '));
  }
  return result.rows;
}

async function verifySplits(pool, referred, sponsorAffId, rootAffId) {
  const errors = [];
  for (let i = 0; i < referred.length; i++) {
    const nextIndex = 51 + i;
    const expected = decidePlacement(nextIndex, sponsorAffId, rootAffId);
    const user = referred[i];
    const { rows } = await pool.query(
      `SELECT affiliate_id, new_user_id, assigned_to_id, tier_level, destination, split_label, next_index
         FROM orphan_assignment_events
        WHERE new_user_id = $1`,
      [user.id]
    );
    if (rows.length !== 1) {
      errors.push(user.role + ' expected 1 orphan event, got ' + rows.length);
      continue;
    }
    const row = rows[0];
    if (row.affiliate_id !== sponsorAffId) {
      errors.push(user.role + ' affiliate_id ' + row.affiliate_id + ' != ' + sponsorAffId);
    }
    if (row.assigned_to_id !== expected.assignedToId) {
      errors.push(user.role + ' assigned_to_id ' + row.assigned_to_id + ' != ' + expected.assignedToId);
    }
    if (row.destination !== expected.destination) {
      errors.push(user.role + ' destination ' + row.destination + ' != ' + expected.destination);
    }
    if (Number(row.next_index) !== nextIndex) {
      errors.push(user.role + ' next_index ' + row.next_index + ' != ' + nextIndex);
    }
    if (Number(row.tier_level) !== expected.tierLevel) {
      errors.push(user.role + ' tier_level ' + row.tier_level + ' != ' + expected.tierLevel);
    }
  }
  if (errors.length) {
    throw new Error('split engine verification failed:\n  - ' + errors.join('\n  - '));
  }
}

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const failures = [];
  try {
    console.log('[seed-staging-engine] connected to staging');

    const cats = await pool.query(`SELECT id, slug FROM categories`);
    const categoriesBySlug = {};
    cats.rows.forEach((c) => { categoriesBySlug[c.slug] = c; });
    for (const def of DEFAULTS) {
      assert(categoriesBySlug[def.slug], 'category missing: ' + def.slug);
    }

    const rootUserId = await upsertUser(pool, 'root', 'Staging Engine Company Root');
    const sponsorUserId = await upsertUser(pool, 'sponsor', 'Staging Engine Sponsor');
    const referredRoles = ['u51-field', 'u52-company', 'u53-field', 'u54-company'];
    const referred = [];
    for (const role of referredRoles) {
      referred.push({ role, id: await upsertUser(pool, role, 'Staging Engine ' + role) });
    }

    const rootAffId = await upsertAffiliate(pool, rootUserId, { master: true, orphans: 0 });
    const sponsorAffId = await upsertAffiliate(pool, sponsorUserId, { master: false, orphans: 50 });

    const seedUserIds = [rootUserId, sponsorUserId].concat(referred.map((u) => u.id));
    await pool.query(
      `DELETE FROM orphan_assignment_events WHERE new_user_id = ANY($1::int[])`,
      [seedUserIds]
    );

    await pool.query(
      `UPDATE affiliates SET orphans_assigned_count = 50 WHERE id = $1`,
      [sponsorAffId]
    );

    for (const user of referred) {
      const placement = await routeOrphanUser(pool, {
        newUserId: user.id,
        affiliateId: sponsorAffId
      });
      assert(placement, 'routeOrphanUser returned null for ' + user.role);
      user.placement = placement;
      console.log('[split]', user.role, placement.destination, 'tier', placement.tierLevel, 'index', placement.nextIndex);
    }

    await verifySplits(pool, referred, sponsorAffId, rootAffId);
    console.log('[split] 51–54 company/field placements match decidePlacement');

    const financeUsers = [{ role: 'sponsor', id: sponsorUserId }].concat(referred);
    for (const user of financeUsers) {
      await wipeFinance(pool, user.id);
      const seeded = await seedDefaultAllocations(pool, user.id);
      if (!seeded) {
        const n = await pool.query(
          `SELECT COUNT(*)::int AS n FROM user_allocations WHERE user_id = $1`,
          [user.id]
        );
        assert(n.rows[0].n > 0, user.role + ': allocations missing after seed');
      }
      await seedIncomeAndExpenses(pool, user.id, categoriesBySlug);
      const rows = await verifyBuckets(pool, user.id, user.role);
      console.log('[buckets]', user.role, rows.map((r) => {
        return r.bucket_slug + '=' + r.deposited_cents + '/' + r.spent_cents + '/' + r.remaining_cents;
      }).join(' '));
    }

    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM user_bucket_state WHERE user_id = ANY($1::int[])`,
      [financeUsers.map((u) => u.id)]
    );
    assert(count.rows[0].n === financeUsers.length * 6, 'unexpected user_bucket_state row count ' + count.rows[0].n);

    console.log('[seed-staging-engine] PASS');
    console.log(JSON.stringify({
      users: {
        root: rootUserId,
        sponsor: sponsorUserId,
        referred: referred.map((u) => ({ role: u.role, id: u.id, destination: u.placement.destination }))
      },
      affiliates: { root: rootAffId, sponsor: sponsorAffId },
      income_cents: INCOME_CENTS,
      bucket_rows: count.rows[0].n
    }, null, 2));
  } catch (err) {
    failures.push(err.message);
    console.error('[seed-staging-engine] FAIL:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
