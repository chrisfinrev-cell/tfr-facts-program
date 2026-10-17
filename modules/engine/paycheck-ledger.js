'use strict';

function sessionUserId(req) {
  if (!req) return null;
  const session = req.session || {};
  const nested = session.user && typeof session.user === 'object' ? session.user : {};
  const account = req.user && typeof req.user === 'object' ? req.user : {};
  const candidates = [
    session.userId,
    session.user_id,
    req.userId,
    account.id,
    account.userId,
    nested.id,
    nested.userId
  ];
  for (let i = 0; i < candidates.length; i++) {
    const id = Number(candidates[i]);
    if (Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

function isIntegerType(udt) {
  return udt === 'int2' || udt === 'int4' || udt === 'int8';
}

function typesMatch(entryIdType, columnType) {
  if (!entryIdType || !columnType) return false;
  if (entryIdType === 'uuid') return columnType === 'uuid';
  if (isIntegerType(entryIdType)) return isIntegerType(columnType);
  return entryIdType === columnType;
}

/**
 * Which deduction columns can store this paycheck id.
 * columns: [{ name, udt, nullable }]
 */
function deductionLinkPlan(entryIdType, columns) {
  const list = Array.isArray(columns) ? columns : [];
  const matching = list.filter(function (column) {
    return (column.name === 'entry_id' || column.name === 'paycheck_id')
      && typesMatch(entryIdType, column.udt);
  });
  if (matching.length) return matching.map(function (column) { return column.name; });
  const fallback = list.find(function (column) {
    return column.name === 'entry_id' || column.name === 'paycheck_id';
  });
  return fallback ? [fallback.name] : [];
}

async function columnInfo(client, table) {
  const result = await client.query(
    `SELECT column_name, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'mod_income' AND table_name = $1`,
    [table]
  );
  return result.rows.map(function (row) {
    return {
      name: row.column_name,
      udt: row.udt_name,
      nullable: row.is_nullable === 'YES'
    };
  });
}

async function ensurePaycheckLedger(client) {
  await client.query('CREATE SCHEMA IF NOT EXISTS mod_income');
  await client.query(`
    CREATE TABLE IF NOT EXISTS mod_income.paycheck_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_name VARCHAR(255),
      entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
      calculation_mode VARCHAR(8) NOT NULL DEFAULT 'GROSS',
      gross_amount NUMERIC(12, 2) DEFAULT 0.00,
      net_amount NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
      employer_match NUMERIC(12, 2) DEFAULT 0.00,
      employer_match_target VARCHAR(16) DEFAULT 'GROWTH',
      liquid_take_home NUMERIC(12, 2),
      bucket_allocations JSONB,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const entryColumns = [
    'source_name VARCHAR(255)',
    'entry_date DATE DEFAULT CURRENT_DATE',
    'calculation_mode VARCHAR(8) DEFAULT \'GROSS\'',
    'gross_amount NUMERIC(12, 2) DEFAULT 0.00',
    'net_amount NUMERIC(12, 2) DEFAULT 0.00',
    'employer_match NUMERIC(12, 2) DEFAULT 0.00',
    'employer_match_target VARCHAR(16) DEFAULT \'GROWTH\'',
    'liquid_take_home NUMERIC(12, 2)',
    'bucket_allocations JSONB',
    'created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP'
  ];
  for (let i = 0; i < entryColumns.length; i++) {
    await client.query(
      'ALTER TABLE mod_income.paycheck_entries ADD COLUMN IF NOT EXISTS ' + entryColumns[i]
    );
  }

  await client.query(`
    CREATE TABLE IF NOT EXISTS mod_income.income_deductions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entry_id UUID,
      paycheck_id INTEGER,
      label VARCHAR(255) NOT NULL,
      amount NUMERIC(12, 2) NOT NULL,
      target_bucket VARCHAR(16) NOT NULL
    )
  `);
  await client.query('ALTER TABLE mod_income.income_deductions ADD COLUMN IF NOT EXISTS entry_id UUID');
  await client.query('ALTER TABLE mod_income.income_deductions ADD COLUMN IF NOT EXISTS paycheck_id INTEGER');
  await client.query('ALTER TABLE mod_income.income_deductions ADD COLUMN IF NOT EXISTS label VARCHAR(255)');
  await client.query('ALTER TABLE mod_income.income_deductions ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2) DEFAULT 0');
  await client.query('ALTER TABLE mod_income.income_deductions ADD COLUMN IF NOT EXISTS target_bucket VARCHAR(16)');

  const entries = await columnInfo(client, 'paycheck_entries');
  const entryId = entries.find(function (column) { return column.name === 'id'; });
  const entryIdType = entryId ? entryId.udt : null;
  const deductions = await columnInfo(client, 'income_deductions');
  for (let i = 0; i < deductions.length; i++) {
    const column = deductions[i];
    if (column.name !== 'entry_id' && column.name !== 'paycheck_id') continue;
    if (column.nullable || typesMatch(entryIdType, column.udt)) continue;
    await client.query(
      'ALTER TABLE mod_income.income_deductions ALTER COLUMN ' + column.name + ' DROP NOT NULL'
    );
    column.nullable = true;
  }
  return { entryIdType: entryIdType, deductions: deductions };
}

async function insertPaycheckEntry(client, userId, body, result) {
  const summary = (result && result.summary) || {};
  const liquid = summary.net_liquid_take_home != null
    ? summary.net_liquid_take_home
    : summary.liquid_take_home;
  const matchTarget = ['NECESSITIES', 'RESERVE', 'VELOCITY', 'GROWTH', 'LIFESTYLE', 'LEGACY']
    .indexOf(body.employer_match_target) !== -1
    ? body.employer_match_target
    : 'GROWTH';
  const mode = String(body.calculation_mode || 'GROSS').toUpperCase() === 'NET' ? 'NET' : 'GROSS';
  const inserted = await client.query(
    `INSERT INTO mod_income.paycheck_entries (
       user_id, source_name, entry_date, calculation_mode,
       gross_amount, net_amount, employer_match, employer_match_target,
       liquid_take_home, bucket_allocations
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      userId,
      body.source_name || 'Paycheck',
      body.entry_date || new Date(),
      mode,
      Number(body.gross_amount) || 0,
      Number(body.net_amount) || 0,
      Number(body.employer_match) || 0,
      matchTarget,
      liquid != null ? liquid : null,
      JSON.stringify((result && result.bucket_allocations) || {})
    ]
  );
  return inserted.rows[0].id;
}

async function insertDeductions(client, entryId, deductions, ledger) {
  const items = Array.isArray(deductions) ? deductions : [];
  const info = ledger || await ensurePaycheckLedger(client);
  const links = deductionLinkPlan(info.entryIdType, info.deductions);
  const allowed = ['NECESSITIES', 'RESERVE', 'VELOCITY', 'GROWTH', 'LIFESTYLE', 'LEGACY'];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || !item.label || allowed.indexOf(item.target_bucket) === -1) continue;
    const columns = links.concat(['label', 'amount', 'target_bucket']);
    const values = links.map(function () { return entryId; }).concat([
      String(item.label),
      Number(item.amount) || 0,
      item.target_bucket
    ]);
    const placeholders = values.map(function (_, index) { return '$' + (index + 1); });
    await client.query(
      'INSERT INTO mod_income.income_deductions (' + columns.join(', ') + ') VALUES (' + placeholders.join(',') + ')',
      values
    );
  }
}

module.exports = {
  sessionUserId,
  deductionLinkPlan,
  ensurePaycheckLedger,
  insertPaycheckEntry,
  insertDeductions
};
