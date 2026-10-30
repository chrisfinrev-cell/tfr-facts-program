'use strict';

/** Canonical FACTS 2.0 bucket slugs */
const CANONICAL_PILLARS = [
  'necessities', 'reserve', 'velocity', 'growth', 'lifestyle', 'legacy'
];

/**
 * Map legacy category slugs → canonical bucket slug.
 * @param {string|null|undefined} slug
 * @returns {string|null}
 */
function normalizeBucketSlug(slug) {
  if (!slug) return null;
  const s = String(slug).toLowerCase();
  if (s === 'nec' || s === 'necessities') return 'necessities';
  if (s === 'save') return 'reserve';
  if (s === 'ff' || s === 'financial-freedom') return 'growth';
  if (CANONICAL_PILLARS.includes(s)) return s;
  return null;
}

const SLUG_SQL = `
  CASE
    WHEN COALESCE(ta.bucket_slug, '') <> '' THEN
      CASE
        WHEN ta.bucket_slug IN ('nec', 'necessities') THEN 'necessities'
        WHEN ta.bucket_slug = 'save' THEN 'reserve'
        WHEN ta.bucket_slug IN ('ff', 'financial-freedom') THEN 'growth'
        ELSE ta.bucket_slug
      END
    WHEN c.slug IN ('nec', 'necessities') THEN 'necessities'
    WHEN c.slug = 'save' THEN 'reserve'
    WHEN c.slug IN ('ff', 'financial-freedom') THEN 'growth'
    ELSE c.slug
  END
`;

let _shape = null;

async function getSchemaShape(pool) {
  if (_shape) return _shape;
  const { rows } = await pool.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('transactions', 'transaction_allocations')`
  );
  const t = new Set();
  const a = new Set();
  for (const r of rows) {
    if (r.table_name === 'transactions') t.add(r.column_name);
    else a.add(r.column_name);
  }
  const txnAmount = t.has('amount_cents')
    ? 't.amount_cents'
    : 'ROUND((t.amount::numeric) * 100)';
  const allocCents = a.has('amount_cents')
    ? 'ta.amount_cents'
    : (a.has('amount') ? 'ROUND((ta.amount::numeric) * 100)' : 'NULL');
  const pct = a.has('percentage') ? 'COALESCE(ta.percentage, 0)' : '0';
  _shape = {
    txnDate: t.has('occurred_at')
      ? 't.occurred_at'
      : (t.has('transaction_date') ? 't.transaction_date' : 't.created_at'),
    skipEom: t.has('payment_method'),
    centsExpr: `COALESCE(${allocCents}, ROUND((${txnAmount}) * ${pct} / 100.0))::INTEGER`
  };
  return _shape;
}

function emptyBuckets() {
  return Object.fromEntries(CANONICAL_PILLARS.map((s) => [s, 0]));
}

async function sumAllocationsByBucket(pool, userId, txnType) {
  const shape = await getSchemaShape(pool);
  const eom = shape.skipEom ? `AND COALESCE(t.payment_method, '') <> 'EOM Sweep'` : '';
  const { rows } = await pool.query(
    `WITH line_items AS (
       SELECT ${SLUG_SQL} AS bucket_slug,
              ${shape.centsExpr} AS cents
         FROM transaction_allocations ta
         JOIN transactions t ON t.id = ta.transaction_id
         LEFT JOIN categories c ON c.id = ta.category_id
        WHERE t.user_id = $1
          AND t.type = $2
          AND DATE_TRUNC('month', ${shape.txnDate}) = DATE_TRUNC('month', CURRENT_DATE)
          ${eom}
     )
     SELECT bucket_slug, COALESCE(SUM(cents), 0)::INTEGER AS total_cents
       FROM line_items
      WHERE bucket_slug = ANY($3::text[])
      GROUP BY bucket_slug`,
    [userId, txnType, CANONICAL_PILLARS]
  );
  const byBucket = emptyBuckets();
  for (const row of rows) {
    byBucket[row.bucket_slug] = parseInt(row.total_cents, 10);
  }
  return byBucket;
}

/**
 * Sum frozen income allocation snapshots for the current calendar month.
 * @param {import('pg').Pool} pool
 * @param {number} userId
 * @returns {Promise<Record<string, number>>} bucket_slug → deposited_cents (integer)
 */
async function getMonthlyBucketDepositsCents(pool, userId) {
  return sumAllocationsByBucket(pool, userId, 'income');
}

async function getMonthlyBucketSpendCents(pool, userId) {
  return sumAllocationsByBucket(pool, userId, 'expense');
}

async function getTargetPctByBucket(pool, userId) {
  const { rows } = await pool.query(
    `SELECT c.slug, ua.percentage
       FROM user_allocations ua
       JOIN categories c ON c.id = ua.category_id
      WHERE ua.user_id = $1
        AND COALESCE(ua.is_temporary, false) = false`,
    [userId]
  );
  const by = emptyBuckets();
  for (const row of rows) {
    const slug = normalizeBucketSlug(row.slug);
    if (slug) by[slug] = Number(row.percentage);
  }
  return by;
}

function assertInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`Cent-Standard violation: ${label} must be integer, got ${value}`);
  }
}

/**
 * Recompute and upsert user_bucket_state for the current month.
 * remaining_cents = deposited_cents - spent_cents (may be negative if overspent).
 */
async function syncUserBucketState(pool, userId) {
  const deposited = await getMonthlyBucketDepositsCents(pool, userId);
  const spent = await getMonthlyBucketSpendCents(pool, userId);
  const targets = await getTargetPctByBucket(pool, userId);

  for (const slug of CANONICAL_PILLARS) {
    const depositedCents = deposited[slug] || 0;
    const spentCents = spent[slug] || 0;
    const remainingCents = depositedCents - spentCents;
    assertInteger(depositedCents, slug + '.deposited_cents');
    assertInteger(spentCents, slug + '.spent_cents');
    assertInteger(remainingCents, slug + '.remaining_cents');

    await pool.query(
      `INSERT INTO user_bucket_state
         (user_id, bucket_slug, target_pct, deposited_cents, spent_cents, remaining_cents, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (user_id, bucket_slug) DO UPDATE SET
         target_pct = EXCLUDED.target_pct,
         deposited_cents = EXCLUDED.deposited_cents,
         spent_cents = EXCLUDED.spent_cents,
         remaining_cents = EXCLUDED.remaining_cents,
         updated_at = NOW()`,
      [userId, slug, targets[slug] || 0, depositedCents, spentCents, remainingCents]
    );
  }

  const { rows } = await pool.query(
    `SELECT bucket_slug, target_pct, deposited_cents, spent_cents, remaining_cents, updated_at
       FROM user_bucket_state
      WHERE user_id = $1
      ORDER BY array_position($2::text[], bucket_slug)`,
    [userId, CANONICAL_PILLARS]
  );
  return { deposited, spent, targets, rows };
}

async function getLiveBucketDashboard(pool, userId) {
  return syncUserBucketState(pool, userId);
}

module.exports = {
  CANONICAL_PILLARS,
  normalizeBucketSlug,
  getMonthlyBucketDepositsCents,
  getMonthlyBucketSpendCents,
  getTargetPctByBucket,
  syncUserBucketState,
  getLiveBucketDashboard
};
