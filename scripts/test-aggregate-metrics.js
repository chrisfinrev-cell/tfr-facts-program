'use strict';

const assert = require('assert');
const { buildTierSql, activityDay, collectAggregateMetrics } = require('../modules/admin/aggregate-metrics');

function columns(names) {
  return new Set(names);
}

let checks = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(function () {
      checks += 1;
      console.log('PASS  ' + name);
    });
}

function fakeClient(handlers) {
  return {
    query: function (sql, params) {
      const handler = handlers.find(function (item) { return item.match(sql, params || []); });
      if (!handler) return Promise.resolve({ rows: [] });
      return Promise.resolve().then(function () { return handler.run(sql, params || []); });
    }
  };
}

const tests = [
  check('tier SQL skips columns that are not on users', function () {
    const sql = buildTierSql(columns(['id', 'plan', 'pricing_tier']));
    assert.ok(sql.indexOf('paid_until') === -1);
    assert.ok(sql.indexOf('is_creator') === -1);
    assert.ok(sql.indexOf('trial_expires_at') === -1);
    assert.ok(sql.indexOf('pricing_tier') !== -1);
    assert.ok(sql.indexOf('FROM users') !== -1);
  }),

  check('activity day falls back to created_at', function () {
    assert.strictEqual(activityDay(columns(['created_at', 'event_type'])), 'created_at');
    assert.strictEqual(activityDay(columns(['event_date', 'created_at'])), 'event_date');
    assert.strictEqual(activityDay(columns(['event_type'])), null);
  }),

  check('missing activity column and missing module table still return zeros', function () {
    const client = fakeClient([
      {
        match: function (sql) { return sql.indexOf('information_schema.columns') !== -1; },
        run: function (sql, params) {
          const table = params[1];
          const map = {
            users: ['id', 'created_at', 'plan', 'pricing_tier'],
            user_activity_events: ['user_id', 'event_type', 'created_at']
          };
          return { rows: (map[table] || []).map(function (name) { return { column_name: name }; }) };
        }
      },
      {
        match: function (sql) { return sql.indexOf('information_schema.tables') !== -1; },
        run: function (sql, params) {
          if (params[0] === 'core' && params[1] === 'module_flags') return { rows: [{ ok: 1 }] };
          return { rows: [] };
        }
      },
      {
        match: function (sql) { return sql.indexOf('COUNT(*)') !== -1 && sql.indexOf('FROM users') !== -1 && sql.indexOf('tier_label') === -1 && sql.indexOf('paid') === -1; },
        run: function () { return { rows: [{ count: 6 }] }; }
      },
      {
        match: function (sql) { return sql.indexOf('tier_label') !== -1; },
        run: function (sql) {
          if (sql.indexOf('event_date') !== -1 || sql.indexOf('paid_until') !== -1) {
            throw new Error('query used a missing column');
          }
          return { rows: [{ tier_label: 'free', user_count: 6 }] };
        }
      },
      {
        match: function (sql) { return sql.indexOf('user_activity_events') !== -1; },
        run: function (sql) {
          if (sql.indexOf('event_date') !== -1) throw new Error('column event_date does not exist');
          if (sql.indexOf('active_users') !== -1) return { rows: [{ day: '2026-10-01', active_users: 2 }] };
          if (sql.indexOf('event_type') !== -1) return { rows: [] };
          return { rows: [{ count: 2 }] };
        }
      },
      {
        match: function (sql) { return sql.indexOf('core.module_flags') !== -1; },
        run: function () { return { rows: [{ module_key: 'legacy_lens', users_with_module: 3 }] }; }
      },
      {
        match: function (sql) { return sql.indexOf('FROM users') !== -1; },
        run: function () { return { rows: [] }; }
      }
    ]);

    return collectAggregateMetrics(client).then(function (payload) {
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.user_counts.total, 6);
      assert.strictEqual(payload.user_counts.active_7d, 2);
      assert.strictEqual(payload.tier_distribution[0].tier_label, 'free');
      assert.strictEqual(payload.module_adoption[0].module_key, 'legacy_lens');
      assert.strictEqual(payload.mrr.paid_count, 0);
      assert.strictEqual(payload.mrr.mrr, 0);
      assert.ok(payload.warnings.indexOf('activity') === -1);
      assert.ok(payload.warnings.indexOf('tiers') === -1);
    });
  }),

  check('a throwing users count does not reject the dashboard', function () {
    const client = fakeClient([
      {
        match: function () { return true; },
        run: function () { throw new Error('connection reset'); }
      }
    ]);
    return collectAggregateMetrics(client).then(function (payload) {
      assert.strictEqual(payload.success, true);
      assert.strictEqual(payload.user_counts.total, 0);
      assert.deepStrictEqual(payload.tier_distribution, []);
      assert.deepStrictEqual(payload.module_adoption, []);
      assert.strictEqual(payload.mrr.mrr, 0);
    });
  })
];

Promise.all(tests).then(function () {
  console.log('');
  console.log(checks + ' aggregate metric checks passed.');
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
