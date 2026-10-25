'use strict';

let cachedColumns = null;

function sanitizeNumber(val) {
  const parsed = parseFloat(val);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadTransactionColumns(db) {
  if (cachedColumns) return cachedColumns;
  const found = await db.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'transactions'`
  );
  const cols = {};
  found.rows.forEach((row) => { cols[row.column_name] = true; });
  cachedColumns = cols;
  return cols;
}

function finiteSql(expr) {
  return '(CASE WHEN (' + expr + ')::text = \'NaN\' THEN 0 ELSE COALESCE(' + expr + ', 0) END)';
}

function moneyExpression(cols, alias) {
  const prefix = alias ? alias + '.' : '';
  if (cols.amount && cols.amount_cents) {
    return finiteSql('COALESCE(' + prefix + 'amount, ' + prefix + 'amount_cents / 100.0)');
  }
  if (cols.amount) return finiteSql(prefix + 'amount');
  if (cols.amount_cents) return finiteSql(prefix + 'amount_cents / 100.0');
  return '0';
}

module.exports = { sanitizeNumber, loadTransactionColumns, moneyExpression };
