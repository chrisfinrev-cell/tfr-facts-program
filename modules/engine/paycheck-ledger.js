'use strict';

const BUCKETS = Object.freeze([
  'NECESSITIES', 'VELOCITY', 'RESERVE', 'LIFESTYLE', 'GROWTH', 'LEGACY'
]);

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

function finiteNumber(value) {
  if (typeof value === 'string') {
    value = value.trim().replace(/[$,]/g, '');
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function finiteDeductions(deductions) {
  const items = Array.isArray(deductions) ? deductions : [];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    const label = item.label == null ? '' : String(item.label).trim();
    const target = item.target_bucket == null ? '' : String(item.target_bucket).trim().toUpperCase();
    const amount = finiteNumber(item.amount);
    if (!label && amount === 0) continue;
    out.push({ label: label, amount: amount, target_bucket: target });
  }
  return out;
}

function finiteBuckets(allocations) {
  const source = allocations && typeof allocations === 'object' ? allocations : {};
  const out = {};
  for (let i = 0; i < BUCKETS.length; i++) {
    const bucket = BUCKETS[i];
    const raw = source[bucket] !== undefined ? source[bucket] : source[bucket.toLowerCase()];
    out[bucket] = finiteNumber(raw);
  }
  return out;
}

function paycheckEntryColumnDdls() {
  return [
    'source_name VARCHAR(255)',
    'entry_date DATE DEFAULT CURRENT_DATE',
    "calculation_mode VARCHAR(8) DEFAULT 'GROSS'",
    'gross_amount NUMERIC(12, 2) DEFAULT 0.00',
    'net_amount NUMERIC(12, 2) DEFAULT 0.00',
    'employer_match NUMERIC(12, 2) DEFAULT 0.00',
    "employer_match_target VARCHAR(16) DEFAULT 'GROWTH'",
    'total_economic_compensation NUMERIC(12, 2) DEFAULT 0.00',
    "deductions JSONB DEFAULT '[]'::jsonb",
    'liquid_take_home NUMERIC(12, 2) DEFAULT 0.00',
    'net_liquid_take_home NUMERIC(12, 2) DEFAULT 0.00',
    'bucket_allocations JSONB',
    'created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP'
  ];
}

function paycheckAlterStatements() {
  return paycheckEntryColumnDdls().map(function (ddl) {
    return 'ALTER TABLE mod_income.paycheck_entries ADD COLUMN IF NOT EXISTS ' + ddl;
  });
}

function liquidAmount(summary, body) {
  if (summary && summary.net_liquid_take_home != null) return finiteNumber(summary.net_liquid_take_home);
  if (summary && summary.liquid_take_home != null) return finiteNumber(summary.liquid_take_home);
  if (body && body.net_liquid_take_home != null) return finiteNumber(body.net_liquid_take_home);
  if (body && body.liquid_take_home != null) return finiteNumber(body.liquid_take_home);
  return 0;
}

function economicAmount(summary, body) {
  if (summary && summary.total_economic_compensation != null) {
    return finiteNumber(summary.total_economic_compensation);
  }
  if (body && body.total_economic_compensation != null) return finiteNumber(body.total_economic_compensation);
  return 0;
}

function paycheckSaveErrorMessage(error) {
  const raw = error && typeof error.message === 'string' ? error.message : '';
  return raw.trim() ? raw : 'Could not save this paycheck. Try again.';
}

function requireInsertUserId(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('Authentication required to save paycheck entries');
    error.status = 401;
    throw error;
  }
  return id;
}

function buildPaycheckInsert(userId, body, result) {
  const sessionId = requireInsertUserId(userId);
  const source = body || {};
  const summary = (result && result.summary) || {};
  const matchTarget = BUCKETS.indexOf(source.employer_match_target) !== -1
    ? source.employer_match_target
    : 'GROWTH';
  const mode = String(source.calculation_mode || 'GROSS').toUpperCase() === 'NET' ? 'NET' : 'GROSS';
  const deductions = finiteDeductions(source.deductions);
  const buckets = finiteBuckets(result && result.bucket_allocations);
  const liquid = liquidAmount(summary, source);
  const economic = economicAmount(summary, source);
  const values = [
    sessionId,
    source.source_name || 'Paycheck',
    source.entry_date || new Date(),
    mode,
    finiteNumber(source.gross_amount),
    finiteNumber(source.net_amount),
    finiteNumber(source.employer_match),
    matchTarget,
    economic,
    JSON.stringify(deductions),
    liquid,
    liquid,
    JSON.stringify(buckets)
  ];
  const text = `INSERT INTO mod_income.paycheck_entries (
       user_id, source_name, entry_date, calculation_mode,
       gross_amount, net_amount, employer_match, employer_match_target,
       total_economic_compensation, deductions,
       liquid_take_home, net_liquid_take_home, bucket_allocations
     ) VALUES (
       $1,$2,$3,$4,
       $5::numeric,$6::numeric,$7::numeric,$8,
       $9::numeric,$10::jsonb,
       $11::numeric,$12::numeric,$13::jsonb
     )
     RETURNING id`;
  return { text: text, values: values, deductions: deductions, buckets: buckets, liquid: liquid, economic: economic };
}

async function columnInfo(client, table) {
  const result = await client.query(
    `SELECT column_name, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'mod_income' AND table_name = $1
      ORDER BY ordinal_position`,
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
      total_economic_compensation NUMERIC(12, 2) DEFAULT 0.00,
      deductions JSONB DEFAULT '[]'::jsonb,
      liquid_take_home NUMERIC(12, 2) DEFAULT 0.00,
      net_liquid_take_home NUMERIC(12, 2) DEFAULT 0.00,
      bucket_allocations JSONB,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const entryDdls = paycheckEntryColumnDdls();
  for (let i = 0; i < entryDdls.length; i++) {
    await client.query(
      'ALTER TABLE mod_income.paycheck_entries ADD COLUMN IF NOT EXISTS ' + entryDdls[i]
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
  const built = buildPaycheckInsert(userId, body, result);
  const inserted = await client.query(built.text, built.values);
  return inserted.rows[0].id;
}

async function insertDeductions(client, entryId, deductions, ledger) {
  const items = finiteDeductions(deductions);
  const info = ledger || await ensurePaycheckLedger(client);
  const links = deductionLinkPlan(info.entryIdType, info.deductions);
  const allowed = ['NECESSITIES', 'RESERVE', 'VELOCITY', 'GROWTH', 'LIFESTYLE', 'LEGACY'];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || !item.label || allowed.indexOf(item.target_bucket) === -1) continue;
    const columns = links.concat(['label', 'amount', 'target_bucket']);
    const values = links.map(function () { return entryId; }).concat([
      String(item.label),
      item.amount,
      item.target_bucket
    ]);
    const placeholders = values.map(function (_, index) {
      const cast = index === links.length + 1 ? '::numeric' : '';
      return '$' + (index + 1) + cast;
    });
    await client.query(
      'INSERT INTO mod_income.income_deductions (' + columns.join(', ') + ') VALUES (' + placeholders.join(',') + ')',
      values
    );
  }
}

module.exports = {
  BUCKETS,
  sessionUserId,
  paycheckSaveErrorMessage,
  requireInsertUserId,
  deductionLinkPlan,
  finiteNumber,
  finiteDeductions,
  finiteBuckets,
  paycheckEntryColumnDdls,
  paycheckAlterStatements,
  buildPaycheckInsert,
  ensurePaycheckLedger,
  insertPaycheckEntry,
  insertDeductions
};
