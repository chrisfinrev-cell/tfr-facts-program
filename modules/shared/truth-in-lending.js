'use strict';

/**
 * Truth in Lending helpers (educational SB 362-style APR summary box).
 * Deterministic math only — not a licensed disclosure product or legal advice.
 */

const DOCUMENT_TYPES = Object.freeze([
  'Promissory_Note_SB362.pdf',
  'SDIRA_Private_Deployment_Agreement.pdf',
  'HELOC_Bridge_Collateral_Pledge.pdf'
]);

const HARD_STOP_TYPE = 'financial_responsibility_hard_stop';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Build SB 362-style APR summary box from amount financed, APR, and term months.
 * Uses simple finance-charge = principal × APR for the educational box
 * (matches FACTS staging fixtures: $25,000 @ 8.5% → $2,125).
 */
function buildAprSummaryBox({
  dealNumber,
  amountFinanced,
  annualPercentageRate,
  termMonths = 12
}) {
  const principal = round2(amountFinanced);
  const apr = Number(annualPercentageRate);
  if (!(principal > 0) || !(apr >= 0) || !(termMonths > 0)) {
    throw new Error('amountFinanced, annualPercentageRate, and termMonths are required');
  }

  const financeCharge = round2(principal * apr);
  const totalOfPayments = round2(principal + financeCharge);
  const monthlyPayment = round2(totalOfPayments / termMonths);
  const aprPct = (apr * 100).toFixed(2) + '%';

  return {
    deal_id: dealNumber || null,
    amount_financed: principal,
    finance_charge: financeCharge,
    total_of_payments: totalOfPayments,
    annual_percentage_rate: aprPct,
    apr_decimal: apr,
    term_months: termMonths,
    monthly_payment: monthlyPayment,
    payment_schedule: termMonths + ' monthly payments of $' + monthlyPayment.toFixed(2),
    format: 'SB362_APR_SUMMARY_BOX',
    educational_only: true
  };
}

function validateAprSummaryBox(box) {
  if (!box || box.format !== 'SB362_APR_SUMMARY_BOX') return false;
  if (typeof box.amount_financed !== 'number' || box.amount_financed <= 0) return false;
  if (typeof box.finance_charge !== 'number' || box.finance_charge < 0) return false;
  if (Math.abs(box.total_of_payments - (box.amount_financed + box.finance_charge)) > 0.02) return false;
  if (!/^\d+\.\d{2}%$/.test(box.annual_percentage_rate || '')) return false;
  if (!box.payment_schedule || !box.payment_schedule.includes('monthly payments')) return false;
  return true;
}

function buildDocumentManifest(dealNumber, types) {
  const list = Array.isArray(types) && types.length ? types : DOCUMENT_TYPES.slice();
  return list.map(function (fileName) {
    return {
      deal_id: dealNumber,
      document_type: fileName.replace(/\.pdf$/i, ''),
      file_name: fileName,
      status: 'READY_FOR_BIOMETRIC_SIGNATURE',
      educational_only: true,
      generated_at: new Date().toISOString()
    };
  });
}

async function ensureTilSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS til_apr_boxes (
      id SERIAL PRIMARY KEY,
      deal_id INTEGER REFERENCES lending_deals(id) ON DELETE SET NULL,
      deal_number VARCHAR(64),
      amount_financed_cents INTEGER NOT NULL,
      finance_charge_cents INTEGER NOT NULL,
      total_of_payments_cents INTEGER NOT NULL,
      apr_bps INTEGER NOT NULL,
      payment_schedule TEXT NOT NULL,
      summary_box JSONB NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS til_documents (
      id SERIAL PRIMARY KEY,
      deal_id INTEGER REFERENCES lending_deals(id) ON DELETE SET NULL,
      deal_number VARCHAR(64),
      document_type VARCHAR(128) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      status VARCHAR(64) NOT NULL DEFAULT 'READY_FOR_BIOMETRIC_SIGNATURE',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_acknowledgments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      disclaimer_type VARCHAR(128) NOT NULL,
      accepted BOOLEAN NOT NULL DEFAULT false,
      deal_id INTEGER REFERENCES lending_deals(id) ON DELETE SET NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS user_acknowledgments_user_type_idx
      ON user_acknowledgments (user_id, disclaimer_type, created_at DESC)
  `);
}

async function persistAprBox(client, { dealId, dealNumber, box }) {
  const { rows } = await client.query(
    `INSERT INTO til_apr_boxes
       (deal_id, deal_number, amount_financed_cents, finance_charge_cents,
        total_of_payments_cents, apr_bps, payment_schedule, summary_box)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
     RETURNING *`,
    [
      dealId || null,
      dealNumber || box.deal_id,
      Math.round(box.amount_financed * 100),
      Math.round(box.finance_charge * 100),
      Math.round(box.total_of_payments * 100),
      Math.round(box.apr_decimal * 10000),
      box.payment_schedule,
      JSON.stringify(box)
    ]
  );

  if (dealId) {
    await client.query(
      `INSERT INTO shield_config (deal_id, custom_config, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (deal_id) DO UPDATE SET
         custom_config = COALESCE(shield_config.custom_config, '{}'::jsonb) || EXCLUDED.custom_config,
         updated_at = NOW()`,
      [dealId, JSON.stringify({ apr_box_generated_at: new Date().toISOString() })]
    ).catch(function () { /* shield_config optional until Step 3 schema exists */ });
  }

  return rows[0];
}

async function persistDocuments(client, { dealId, dealNumber, docs }) {
  const saved = [];
  for (const doc of docs) {
    const { rows } = await client.query(
      `INSERT INTO til_documents
         (deal_id, deal_number, document_type, file_name, status, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       RETURNING id, file_name, status`,
      [
        dealId || null,
        dealNumber || doc.deal_id,
        doc.document_type,
        doc.file_name,
        doc.status,
        JSON.stringify(doc)
      ]
    );
    saved.push(rows[0]);
  }
  return saved;
}

async function persistAcknowledgment(client, { userId, disclaimerType, accepted, dealId, metadata }) {
  const { rows } = await client.query(
    `INSERT INTO user_acknowledgments
       (user_id, disclaimer_type, accepted, deal_id, metadata)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     RETURNING id, user_id, disclaimer_type, accepted, created_at`,
    [
      userId,
      disclaimerType || HARD_STOP_TYPE,
      !!accepted,
      dealId || null,
      JSON.stringify(metadata || {})
    ]
  );
  return rows[0];
}

module.exports = {
  DOCUMENT_TYPES,
  HARD_STOP_TYPE,
  buildAprSummaryBox,
  validateAprSummaryBox,
  buildDocumentManifest,
  ensureTilSchema,
  persistAprBox,
  persistDocuments,
  persistAcknowledgment
};
