'use strict';

/**
 * Credit audit action items: strike-through progress + educational letter drafts.
 * CROA-safe: templates are for user literacy/self-use only. FACTS never sends
 * letters to bureaus or furnishers on the user's behalf.
 */

const crypto = require('crypto');

async function ensureActionItemsSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS credit_audit_items (
      id SERIAL PRIMARY KEY,
      analysis_id INTEGER NOT NULL REFERENCES credit_analyses(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      item_key VARCHAR(64) NOT NULL,
      item_type VARCHAR(32) NOT NULL,
      label TEXT NOT NULL,
      details TEXT,
      bureau VARCHAR(64),
      creditor TEXT,
      amount NUMERIC(12,2),
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at TIMESTAMPTZ,
      letter_type VARCHAR(32),
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (analysis_id, item_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS credit_audit_items_analysis_idx
      ON credit_audit_items (analysis_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS credit_audit_items_user_idx
      ON credit_audit_items (user_id)
  `);
}

function itemKey(parts) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('|')).digest('hex').slice(0, 24);
}

function flattenAnalysisToItems(analysis) {
  const items = [];
  if (!analysis || typeof analysis !== 'object') return items;

  (analysis.address_vulnerabilities || []).forEach((a, idx) => {
    items.push({
      item_key: itemKey(['address', a.address, idx]),
      item_type: 'address',
      label: `Address review: ${a.address || 'Unknown address'}`,
      details: a.forensic_strategy || a.status || 'Stale/duplicate address observation',
      bureau: null,
      creditor: null,
      amount: null,
      letter_type: 'address',
      meta: { address: a.address || null, status: a.status || null, anchored_items: a.anchored_items || [] }
    });
  });

  (analysis.negative_items || []).forEach((n, idx) => {
    const amt = n.amount != null ? Number(n.amount) : null;
    items.push({
      item_key: itemKey(['negative', n.creditor, n.type, n.amount, idx]),
      item_type: 'negative',
      label: `${n.creditor || 'Creditor'}${n.type ? ` (${n.type})` : ''}${amt != null ? ` — $${amt.toLocaleString()}` : ''}`,
      details: [n.recommended_action || n.educational_topic, n.anchor_address ? `Linked address: ${n.anchor_address}` : null]
        .filter(Boolean).join(' · ') || 'Negative item educational review',
      bureau: n.bureau || null,
      creditor: n.creditor || null,
      amount: Number.isFinite(amt) ? amt : null,
      letter_type: 'negative',
      meta: n
    });
  });

  (analysis.hard_inquiries || []).forEach((i, idx) => {
    items.push({
      item_key: itemKey(['inquiry', i.creditor, i.date, idx]),
      item_type: 'inquiry',
      label: `Hard inquiry: ${i.creditor || 'Unknown'}${i.date ? ` (${i.date})` : ''}`,
      details: i.flagged
        ? `Flagged for review · drops off ${i.drop_off_date || '—'}`
        : `Drops off ${i.drop_off_date || '—'}`,
      bureau: i.bureau || null,
      creditor: i.creditor || null,
      amount: null,
      letter_type: 'inquiry',
      meta: i
    });
  });

  (analysis.action_summary || []).forEach((text, idx) => {
    const t = String(text || '').trim();
    if (!t) return;
    items.push({
      item_key: itemKey(['action', t, idx]),
      item_type: 'action',
      label: t,
      details: 'Prioritized educational follow-through step',
      bureau: null,
      creditor: null,
      amount: null,
      letter_type: 'general',
      meta: { action_index: idx }
    });
  });

  return items;
}

async function seedActionItems(pool, { analysisId, userId, analysis }) {
  await ensureActionItemsSchema(pool);
  const items = flattenAnalysisToItems(analysis);
  for (const item of items) {
    await pool.query(
      `INSERT INTO credit_audit_items
         (analysis_id, user_id, item_key, item_type, label, details, bureau, creditor, amount, letter_type, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (analysis_id, item_key) DO NOTHING`,
      [
        analysisId,
        userId || null,
        item.item_key,
        item.item_type,
        item.label,
        item.details,
        item.bureau,
        item.creditor,
        item.amount,
        item.letter_type,
        JSON.stringify(item.meta || {})
      ]
    );
  }
  return items.length;
}

async function listActionItems(pool, analysisId) {
  await ensureActionItemsSchema(pool);
  const { rows } = await pool.query(
    `SELECT id, analysis_id, item_key, item_type, label, details, bureau, creditor, amount,
            resolved, resolved_at, letter_type, meta, created_at, updated_at
     FROM credit_audit_items
     WHERE analysis_id = $1
     ORDER BY
       CASE item_type
         WHEN 'negative' THEN 1
         WHEN 'address' THEN 2
         WHEN 'inquiry' THEN 3
         ELSE 4
       END,
       id ASC`,
    [analysisId]
  );
  return rows;
}

async function setItemResolved(pool, { itemId, userId, resolved }) {
  const { rows } = await pool.query(
    `UPDATE credit_audit_items
     SET resolved = $2,
         resolved_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1
       AND (user_id IS NULL OR user_id = $3 OR $3 IS NULL)
     RETURNING *`,
    [itemId, !!resolved, userId || null]
  );
  return rows[0] || null;
}

function buildEducationalLetter(item, userName) {
  const name = userName || '[Your Full Legal Name]';
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const bureau = item.bureau || '[Equifax / Experian / TransUnion]';
  const account = item.creditor || item.label || '[Account / Item]';
  const amount = item.amount != null ? `$${Number(item.amount).toLocaleString()}` : null;
  const type = item.letter_type || item.item_type || 'general';

  const header =
`${today}

${bureau} Consumer Relations
[Bureau dispute address from your credit report]

Re: Educational self-advocacy letter regarding: ${account}
${amount ? `Reported amount (if applicable): ${amount}\n` : ''}
Dear ${bureau} Consumer Relations,

My name is ${name}. I am writing on my own behalf to request that you investigate the accuracy and completeness of the following information on my consumer credit file.`;

  let body;
  if (type === 'address') {
    body = `
I request a reinvestigation of the following address information, which appears outdated or inaccurate on my file:

${item.label}
${item.details ? `\nNotes: ${item.details}` : ''}

Please verify this information with the furnisher(s) and update or delete any information that cannot be verified as accurate and complete, consistent with the Fair Credit Reporting Act (including 15 U.S.C. § 1681i).`;
  } else if (type === 'inquiry') {
    body = `
I request a reinvestigation of the following hard inquiry appearing on my file:

${item.label}
${item.details ? `\nNotes: ${item.details}` : ''}

Please verify that this inquiry was authorized and properly reported. If it cannot be verified, please update or delete it consistent with the Fair Credit Reporting Act.`;
  } else if (type === 'negative') {
    body = `
I request a reinvestigation of the following tradeline / negative item:

${item.label}
${item.details ? `\nNotes: ${item.details}` : ''}

Please verify the accuracy and completeness of this reporting with the furnisher. If any portion cannot be verified, please update or delete the unverified information consistent with the Fair Credit Reporting Act (including 15 U.S.C. § 1681i).`;
  } else {
    body = `
I request a reinvestigation related to the following educational follow-through item from my credit file review:

${item.label}
${item.details ? `\nNotes: ${item.details}` : ''}

Please verify any related information and correct anything that cannot be verified as accurate and complete under the Fair Credit Reporting Act.`;
  }

  const footer = `

Please send written results of your reinvestigation to my address of record.

Sincerely,

${name}
[Your current mailing address]
[Your phone / email]

---
EDUCATIONAL TEMPLATE ONLY — Generated by FACTS for consumer literacy.
FACTS is not a credit repair organization, does not contact credit bureaus or furnishers for you,
does not guarantee deletion/score changes, and does not provide legal advice.
Review with a licensed professional before sending. You are solely responsible for any letter you send.`;

  return header + body + footer;
}

module.exports = {
  ensureActionItemsSchema,
  flattenAnalysisToItems,
  seedActionItems,
  listActionItems,
  setItemResolved,
  buildEducationalLetter
};
