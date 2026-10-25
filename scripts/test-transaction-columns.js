'use strict';

const assert = require('assert');
const { sanitizeNumber, moneyExpression } = require('../lib/transaction-columns');

assert.strictEqual(sanitizeNumber(undefined), 0);
assert.strictEqual(sanitizeNumber(null), 0);
assert.strictEqual(sanitizeNumber('12.5'), 12.5);
assert.strictEqual(sanitizeNumber('nope'), 0);
assert.strictEqual(moneyExpression({ amount: true }, ''), '(CASE WHEN (amount)::text = \'NaN\' THEN 0 ELSE COALESCE(amount, 0) END)');
assert.strictEqual(
  moneyExpression({ amount_cents: true }, 't'),
  '(CASE WHEN (t.amount_cents / 100.0)::text = \'NaN\' THEN 0 ELSE COALESCE(t.amount_cents / 100.0, 0) END)'
);
assert.ok(moneyExpression({ amount: true, amount_cents: true }, '').indexOf('NaN') !== -1);

console.log('transaction column checks passed');
