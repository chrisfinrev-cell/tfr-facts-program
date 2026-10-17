'use strict';

/**
 * Platform aggregate metrics. Every read is isolated: a missing table,
 * a missing column, or a statement timeout becomes a zero or an empty list.
 * No individual user rows are returned.
 */

function emptyAggregate(warnings) {
  return {
    success: true,
    degraded: !!(warnings && warnings.length),
    warnings: warnings || [],
    user_counts: { total: 0, active_7d: 0, active_30d: 0 },
    tier_distribution: [],
    registration_trend: [],
    feature_usage: [],
    module_adoption: [],
    dau_trend: [],
    revenue_metrics: [],
    mrr: { paid_count: 0, mrr: 0 }
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function has(columns, name) {
  return !!(columns && columns.has(name));
}

function buildTierSql(columns) {
  const whens = [];
  if (has(columns, 'is_creator')) whens.push("WHEN is_creator IS TRUE THEN 'Admin'");

  const paidLabelParts = [];
  if (has(columns, 'pricing_tier')) paidLabelParts.push("NULLIF(TRIM(pricing_tier), '')");
  if (has(columns, 'subscription_tier')) paidLabelParts.push("NULLIF(TRIM(subscription_tier), '')");
  const paidLabel = paidLabelParts.length ? 'COALESCE(' + paidLabelParts.join(', ') + ", 'Paid')" : "'Paid'";

  if (has(columns, 'plan') && has(columns, 'paid_until')) {
    whens.push("WHEN plan = 'paid' AND paid_until > NOW() THEN " + paidLabel);
  } else if (has(columns, 'subscription_status')) {
    const planLabel = has(columns, 'subscription_plan')
      ? "COALESCE(NULLIF(TRIM(subscription_plan), ''), 'Paid')"
      : "'Paid'";
    whens.push("WHEN subscription_status IN ('active', 'trialing') THEN " + planLabel);
  }

  if (has(columns, 'trial_expires_at')) {
    whens.push("WHEN trial_expires_at IS NOT NULL AND trial_expires_at > NOW() THEN 'Trial'");
  }
  if (has(columns, 'promo_code_used')) {
    const grace = has(columns, 'promo_grace_expired')
      ? ' AND (promo_grace_expired IS NULL OR promo_grace_expired = false)'
      : '';
    whens.push('WHEN promo_code_used IS NOT NULL' + grace + " THEN 'Promo'");
  }

  const fallback = [];
  if (has(columns, 'pricing_tier')) fallback.push("NULLIF(TRIM(pricing_tier), '')");
  if (has(columns, 'subscription_tier')) fallback.push("NULLIF(TRIM(subscription_tier), '')");
  if (has(columns, 'plan')) fallback.push("NULLIF(TRIM(plan), '')");
  const elseLabel = fallback.length ? 'COALESCE(' + fallback.join(', ') + ", 'Free')" : "'Free'";
  const caseSql = whens.length
    ? 'CASE ' + whens.join(' ') + ' ELSE ' + elseLabel + ' END'
    : elseLabel;

  return 'SELECT ' + caseSql + ' AS tier_label, COUNT(*)::int AS user_count FROM users GROUP BY 1 ORDER BY user_count DESC';
}

function activityDay(columns) {
  if (has(columns, 'event_date')) return 'event_date';
  if (has(columns, 'created_at')) return 'created_at';
  return null;
}

async function safeRows(client, sql, params, label, warnings) {
  try {
    const result = await client.query(sql, params);
    return result.rows || [];
  } catch (err) {
    console.error('[AdminDashboard] ' + label + ':', err.message);
    warnings.push(label);
    return null;
  }
}

async function columnSet(client, tableName, schema) {
  const rows = await safeRows(
    client,
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2`,
    [schema || 'public', tableName],
    'columns:' + tableName,
    []
  );
  return new Set((rows || []).map((row) => row.column_name));
}

async function tableExists(client, tableName, schema) {
  const rows = await safeRows(
    client,
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2`,
    [schema || 'public', tableName],
    'table:' + tableName,
    []
  );
  return !!(rows && rows.length);
}

async function collectAggregateMetrics(client) {
  const warnings = [];
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const payload = emptyAggregate(warnings);

  const userColumns = await columnSet(client, 'users', 'public');
  const creatorFilter = has(userColumns, 'is_creator') ? ' WHERE is_creator IS NOT TRUE' : '';
  const totalRows = await safeRows(
    client,
    'SELECT COUNT(*)::int AS count FROM users' + creatorFilter,
    [],
    'users',
    warnings
  );
  if (totalRows && totalRows[0]) payload.user_counts.total = num(totalRows[0].count);

  const activityColumns = await columnSet(client, 'user_activity_events', 'public');
  const dayColumn = activityDay(activityColumns);
  if (activityColumns.size && !dayColumn) warnings.push('activity');
  if (dayColumn && has(activityColumns, 'user_id')) {
    const seven = await safeRows(
      client,
      'SELECT COUNT(DISTINCT user_id)::int AS count FROM user_activity_events WHERE ' + dayColumn + ' >= $1',
      [sevenDaysAgo],
      'activity',
      warnings
    );
    const thirty = await safeRows(
      client,
      'SELECT COUNT(DISTINCT user_id)::int AS count FROM user_activity_events WHERE ' + dayColumn + ' >= $1',
      [thirtyDaysAgo],
      'activity',
      warnings
    );
    if (seven && seven[0]) payload.user_counts.active_7d = num(seven[0].count);
    if (thirty && thirty[0]) payload.user_counts.active_30d = num(thirty[0].count);

    const dau = await safeRows(
      client,
      'SELECT ' + dayColumn + '::date AS day, COUNT(DISTINCT user_id)::int AS active_users FROM user_activity_events WHERE ' + dayColumn + ' >= $1 GROUP BY 1 ORDER BY 1',
      [thirtyDaysAgo],
      'dau',
      warnings
    );
    if (dau) payload.dau_trend = dau;

    if (has(activityColumns, 'event_type')) {
      const features = await safeRows(
        client,
        'SELECT event_type, COUNT(*)::int AS usage_count, COUNT(DISTINCT user_id)::int AS unique_users FROM user_activity_events WHERE ' + dayColumn + ' >= $1 GROUP BY event_type ORDER BY usage_count DESC LIMIT 20',
        [thirtyDaysAgo],
        'features',
        warnings
      );
      if (features) payload.feature_usage = features;
    }
  }

  if (userColumns.size) {
    const tiers = await safeRows(client, buildTierSql(userColumns), [], 'tiers', warnings);
    if (tiers) payload.tier_distribution = tiers;
    if (has(userColumns, 'created_at')) {
      const regs = await safeRows(
        client,
        'SELECT DATE(created_at) AS day, COUNT(*)::int AS new_users FROM users WHERE created_at >= $1 GROUP BY 1 ORDER BY 1',
        [thirtyDaysAgo],
        'registrations',
        warnings
      );
      if (regs) payload.registration_trend = regs;
    }
  }

  payload.module_adoption = await loadModuleAdoption(client, warnings);
  const money = await loadRevenue(client, userColumns, warnings, thirtyDaysAgo);
  payload.revenue_metrics = money.revenue;
  payload.mrr = money.mrr;
  payload.warnings = warnings;
  payload.degraded = warnings.length > 0;
  return payload;
}

async function loadModuleAdoption(client, warnings) {
  if (await tableExists(client, 'user_module_overrides', 'public')) {
    const columns = await columnSet(client, 'user_module_overrides', 'public');
    if (has(columns, 'module_key') && has(columns, 'user_id')) {
      const enabled = has(columns, 'enabled') ? ' WHERE enabled IS TRUE' : '';
      const rows = await safeRows(
        client,
        'SELECT module_key, COUNT(DISTINCT user_id)::int AS users_with_module FROM user_module_overrides' + enabled + ' GROUP BY module_key ORDER BY users_with_module DESC',
        [],
        'modules',
        warnings
      );
      return rows || [];
    }
  }

  if (await tableExists(client, 'module_flags', 'core')) {
    const rows = await safeRows(
      client,
      `SELECT module_id AS module_key, COUNT(DISTINCT user_id)::int AS users_with_module
         FROM core.module_flags
        WHERE status IN ('enabled', 'active', 'on')
        GROUP BY module_id
        ORDER BY users_with_module DESC`,
      [],
      'modules',
      warnings
    );
    return rows || [];
  }

  return [];
}

async function loadRevenue(client, userColumns, warnings, since) {
  const empty = { revenue: [], mrr: { paid_count: 0, mrr: 0 } };
  if (await tableExists(client, 'subscriptions', 'public')) {
    const columns = await columnSet(client, 'subscriptions', 'public');
    const planExpr = has(columns, 'plan') ? 'plan' : (has(columns, 'plan_type') ? 'plan_type' : "'unknown'");
    const amountExpr = has(columns, 'amount_cents') ? 'amount_cents' : '0';
    const filters = [];
    const params = [];
    if (has(columns, 'status')) filters.push("status IN ('completed', 'active')");
    if (has(columns, 'created_at')) {
      params.push(since);
      filters.push('created_at >= $1');
    }
    const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
    const revenue = await safeRows(
      client,
      'SELECT COALESCE(' + planExpr + ", 'unknown') AS plan_type, COUNT(*)::int AS count, SUM(" + amountExpr + ') / 100.0 AS total_revenue, AVG(' + amountExpr + ') / 100.0 AS avg_amount FROM subscriptions' + where + ' GROUP BY 1 ORDER BY total_revenue DESC NULLS LAST',
      params,
      'revenue',
      warnings
    );

    const mrrFilters = [];
    if (has(columns, 'status')) mrrFilters.push("status IN ('completed', 'active')");
    if (has(columns, 'expires_at')) mrrFilters.push('(expires_at IS NULL OR expires_at > NOW())');
    const mrrWhere = mrrFilters.length ? ' WHERE ' + mrrFilters.join(' AND ') : '';
    const mrrRows = await safeRows(
      client,
      'SELECT COUNT(*)::int AS paid_count, SUM(' + amountExpr + ') / 100.0 AS mrr FROM subscriptions' + mrrWhere,
      [],
      'mrr',
      warnings
    );
    return {
      revenue: revenue || [],
      mrr: {
        paid_count: mrrRows && mrrRows[0] ? num(mrrRows[0].paid_count) : 0,
        mrr: mrrRows && mrrRows[0] ? num(mrrRows[0].mrr) : 0
      }
    };
  }

  if (has(userColumns, 'plan') && has(userColumns, 'paid_until')) {
    const rows = await safeRows(
      client,
      "SELECT COUNT(*)::int AS paid_count FROM users WHERE plan = 'paid' AND paid_until > NOW()",
      [],
      'mrr',
      warnings
    );
    return {
      revenue: [],
      mrr: { paid_count: rows && rows[0] ? num(rows[0].paid_count) : 0, mrr: 0 }
    };
  }

  return empty;
}

module.exports = {
  emptyAggregate,
  buildTierSql,
  activityDay,
  collectAggregateMetrics
};
