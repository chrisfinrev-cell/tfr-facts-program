/**
 * Sovereign Health Score — Shared Engine
 *
 * Three structural pillars:
 *   1. Necessities Index (The Floor) — operational efficiency vs 50% target
 *   2. Reserve Index   (The Shield) — liquid capital depth vs 12-month burn
 *   3. Growth Index    (The Engine) — wealth velocity MoM + accumulated
 *
 * Composite = weighted_average × streak_multiplier
 *
 * Used by: mod_legacy_lens, mod_lending_desk
 */

'use strict';

// ─── Tier helpers ─────────────────────────────────────────────────────────────
const TIER_RANK = { free: 0, elite: 1, business: 2, sovereignty: 3 };

function normalizeTier(plan) {
  if (!plan) return 'free';
  const p = plan.toLowerCase();
  if (p.includes('sovereignty') || p.includes('sovereign')) return 'sovereignty';
  if (p.includes('business')) return 'business';
  if (p.includes('elite')) return 'elite';
  return 'free';
}

function tierRank(tier) {
  return TIER_RANK[tier] ?? -1;
}

/**
 * Determine if a user has access to an elite add-on module.
 *
 * @param {object} user          Row from users table (pricing_tier, subscription_tier, etc.)
 * @param {string} moduleId      e.g. 'legacy_lens' | 'lending_desk'
 * @param {object} pool          pg Pool for module_flags lookup
 * @returns {{ allowed: boolean, tier: string, reason: string }}
 */
async function checkModuleAccess(user, moduleId, pool) {
  const pricingTier = user.pricing_tier || user.subscription_tier || user.plan || '';
  const tier = normalizeTier(pricingTier);

  // Business / Sovereignty → always included
  if (tierRank(tier) >= tierRank('business')) {
    return { allowed: true, tier, reason: 'included' };
  }

  // Elite → check per-user add-on flag
  if (tier === 'elite') {
    const { rows } = await pool.query(
      `SELECT status FROM core.module_flags
       WHERE module_id = $1 AND user_id = $2
       LIMIT 1`,
      [moduleId, user.id]
    );
    const flag = rows[0];
    if (flag && flag.status === 'enabled') {
      return { allowed: true, tier, reason: 'addon' };
    }
    return { allowed: false, tier, reason: 'addon_required', price_cents: 2900 };
  }

  // Free / Individual / etc. → not eligible
  return { allowed: false, tier, reason: 'tier_upgrade_required' };
}

/**
 * Compute the Sovereign Health Score for a user.
 *
 * @param {number} userId
 * @param {object} pool   pg Pool
 * @returns {object} Full scorecard payload
 */
async function computeHealthScore(userId, pool) {
  const [
    necessitiesIndex,
    reserveIndex,
    growthIndex,
    streakMultiplier
  ] = await Promise.all([
    computeNecessitiesIndex(userId, pool),
    computeReserveIndex(userId, pool),
    computeGrowthIndex(userId, pool),
    computeStreakMultiplier(userId, pool)
  ]);

  // Weighted composite (equal thirds)
  const raw = (necessitiesIndex.score + reserveIndex.score + growthIndex.score) / 3;
  const composite = Math.min(100, Math.round(raw * streakMultiplier * 10) / 10);

  // Sovereignty level label
  let sovereignty_level = 'Emerging';
  if (composite >= 85) sovereignty_level = 'Sovereign';
  else if (composite >= 70) sovereignty_level = 'Elevated';
  else if (composite >= 50) sovereignty_level = 'Established';
  else if (composite >= 30) sovereignty_level = 'Building';

  return {
    necessities_index:  necessitiesIndex,
    reserve_index:      reserveIndex,
    growth_index:       growthIndex,
    streak_multiplier:  streakMultiplier,
    composite_score:    composite,
    sovereignty_level,
    computed_at:        new Date().toISOString()
  };
}

// ─── Pillar 1: Necessities Index (The Floor) ──────────────────────────────────
// Measures operational efficiency: actual necessities spend vs 50% target
async function computeNecessitiesIndex(userId, pool) {
  try {
    // Get last 30 days of income and necessities-category expenses
    const { rows: income } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM income_transactions
       WHERE user_id = $1
         AND transaction_date >= NOW() - INTERVAL '30 days'`,
      [userId]
    );

    const { rows: necessities } = await pool.query(
      `SELECT COALESCE(SUM(et.amount), 0) AS total
       FROM expense_transactions et
       JOIN categories c ON et.category_id = c.id
       WHERE et.user_id = $1
         AND et.transaction_date >= NOW() - INTERVAL '30 days'
         AND (LOWER(c.name) LIKE '%necessit%'
              OR LOWER(c.name) LIKE '%essential%'
              OR LOWER(c.name) LIKE '%floor%'
              OR c.sort_order = 1)`,
      [userId]
    );

    const totalIncome = parseFloat(income[0].total) || 0;
    const totalNecessities = parseFloat(necessities[0].total) || 0;

    if (totalIncome === 0) {
      return { score: 50, pct_actual: 0, pct_target: 50, label: 'The Floor', status: 'no_data' };
    }

    const pctActual = (totalNecessities / totalIncome) * 100;
    const deviation = Math.abs(pctActual - 50);
    const score = Math.max(0, Math.min(100, Math.round(100 - deviation * 1.5)));

    return {
      score,
      pct_actual: Math.round(pctActual * 10) / 10,
      pct_target: 50,
      label: 'The Floor',
      status: pctActual <= 52 ? 'optimal' : pctActual <= 60 ? 'watch' : 'overspend'
    };
  } catch {
    return { score: 50, label: 'The Floor', status: 'no_data' };
  }
}

// ─── Pillar 2: Reserve Index (The Shield) ─────────────────────────────────────
// Measures liquid capital depth: reserve balance vs 12-month burn rate
async function computeReserveIndex(userId, pool) {
  try {
    // Sum of reserve/save bucket balances
    const { rows: reserve } = await pool.query(
      `SELECT COALESCE(SUM(pa.current_balance), 0) AS balance
       FROM plaid_accounts pa
       WHERE pa.user_id = $1
         AND pa.is_active = true
         AND (LOWER(pa.account_type) = 'depository'
              OR LOWER(pa.bucket_type) LIKE '%reserve%'
              OR LOWER(pa.bucket_type) LIKE '%save%')`,
      [userId]
    );

    // 12-month burn rate from expense transactions
    const { rows: burn } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM expense_transactions
       WHERE user_id = $1
         AND transaction_date >= NOW() - INTERVAL '12 months'`,
      [userId]
    );

    const reserveBalance = parseFloat(reserve[0].balance) || 0;
    const yearBurn = parseFloat(burn[0].total) || 1;
    const monthlyBurn = yearBurn / 12;
    const monthsCovered = reserveBalance / (monthlyBurn || 1);

    // Full score at 12 months of Necessity. Partial below that.
    const score = Math.max(0, Math.min(100, Math.round((monthsCovered / 12) * 100)));

    return {
      score,
      reserve_balance: reserveBalance,
      monthly_burn: Math.round(monthlyBurn * 100) / 100,
      months_covered: Math.round(monthsCovered * 10) / 10,
      target_months: 12,
      label: 'The Shield',
      status: monthsCovered >= 12 ? 'optimal' : monthsCovered >= 3 ? 'building' : 'critical'
    };
  } catch {
    return { score: 50, label: 'The Shield', status: 'no_data' };
  }
}

// ─── Pillar 3: Growth Index (The Engine) ──────────────────────────────────────
// Measures wealth velocity: MoM growth + total accumulated in growth bucket
async function computeGrowthIndex(userId, pool) {
  try {
    // Current month growth bucket income
    const { rows: currentMonth } = await pool.query(
      `SELECT COALESCE(SUM(it.amount), 0) AS total
       FROM income_transactions it
       JOIN categories c ON it.category_id = c.id
       WHERE it.user_id = $1
         AND it.transaction_date >= DATE_TRUNC('month', NOW())
         AND (LOWER(c.name) LIKE '%growth%'
              OR LOWER(c.name) LIKE '%invest%'
              OR LOWER(c.name) LIKE '%wealth%'
              OR LOWER(c.name) LIKE '%engine%')`,
      [userId]
    );

    // Previous month growth bucket income
    const { rows: prevMonth } = await pool.query(
      `SELECT COALESCE(SUM(it.amount), 0) AS total
       FROM income_transactions it
       JOIN categories c ON it.category_id = c.id
       WHERE it.user_id = $1
         AND it.transaction_date >= DATE_TRUNC('month', NOW() - INTERVAL '1 month')
         AND it.transaction_date < DATE_TRUNC('month', NOW())
         AND (LOWER(c.name) LIKE '%growth%'
              OR LOWER(c.name) LIKE '%invest%'
              OR LOWER(c.name) LIKE '%wealth%'
              OR LOWER(c.name) LIKE '%engine%')`,
      [userId]
    );

    // All-time growth bucket accumulated (as proxy for total wealth velocity)
    const { rows: accumulated } = await pool.query(
      `SELECT COALESCE(SUM(it.amount), 0) AS total
       FROM income_transactions it
       JOIN categories c ON it.category_id = c.id
       WHERE it.user_id = $1
         AND (LOWER(c.name) LIKE '%growth%'
              OR LOWER(c.name) LIKE '%invest%'
              OR LOWER(c.name) LIKE '%wealth%'
              OR LOWER(c.name) LIKE '%engine%')`,
      [userId]
    );

    const curr = parseFloat(currentMonth[0].total) || 0;
    const prev = parseFloat(prevMonth[0].total) || 0;
    const total = parseFloat(accumulated[0].total) || 0;

    // MoM growth rate score (0-50)
    let momScore = 0;
    if (prev > 0) {
      const rate = (curr - prev) / prev;
      momScore = Math.max(0, Math.min(50, 25 + rate * 50));
    } else if (curr > 0) {
      momScore = 35; // has growth this month, no prior to compare
    }

    // Accumulated wealth score (0-50) — benchmarked against $10k milestone
    const accScore = Math.min(50, (total / 10000) * 50);

    const score = Math.round(momScore + accScore);

    return {
      score: Math.min(100, score),
      current_month: curr,
      prev_month: prev,
      total_accumulated: total,
      mom_growth_pct: prev > 0 ? Math.round(((curr - prev) / prev) * 1000) / 10 : null,
      label: 'The Engine',
      status: score >= 70 ? 'accelerating' : score >= 40 ? 'building' : 'starting'
    };
  } catch {
    return { score: 30, label: 'The Engine', status: 'no_data' };
  }
}

// ─── Streak Multiplier (from The Wallet) ──────────────────────────────────────
// Streak drives borrowing limits and composite score multiplier
async function computeStreakMultiplier(userId, pool) {
  try {
    const { rows } = await pool.query(
      `SELECT streak_count, longest_streak
       FROM mod_rewards.user_wallet
       WHERE user_id = $1`,
      [userId]
    );

    const streak = rows[0]?.streak_count || 0;
    // +2% per week of streak, capped at +50% (25-week streak)
    const multiplier = Math.min(1.5, 1 + streak * 0.02);
    return Math.round(multiplier * 100) / 100;
  } catch {
    return 1.0; // graceful fallback
  }
}

module.exports = {
  normalizeTier,
  tierRank,
  checkModuleAccess,
  computeHealthScore
};
