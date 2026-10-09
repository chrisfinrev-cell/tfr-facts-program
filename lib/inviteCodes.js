'use strict';

const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomSegment(length = 4) {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** Standard clean invite code: FACTS-7K9P-2M4X */
function generateInviteCode(prefix = 'FACTS') {
  return `${String(prefix || 'FACTS').toUpperCase()}-${randomSegment(4)}-${randomSegment(4)}`;
}

/**
 * Normalizes metadata input, handling flat objects, stringified JSON,
 * or nested string representations (e.g. CLI `--meta="{tier:VIP,campaign:cohort_1}"`).
 */
function parseRecipientMetadata(rawMetadata) {
  if (rawMetadata == null || rawMetadata === '') {
    return { tier: null, normalized: {} };
  }

  let parsed = rawMetadata;

  // Handle double-stringified JSON or CLI string inputs
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      // Non-JSON CLI shorthand: "{tier:VIP,campaign:cohort_1}" or bare notes
      const trimmed = String(rawMetadata).trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        parsed = { notes: trimmed };
      } else {
        return { tier: null, normalized: { notes: String(rawMetadata) } };
      }
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { tier: null, normalized: { value: parsed } };
  }

  // Unwrap CLI flags stored inside a "notes" string
  if (parsed.notes && typeof parsed.notes === 'string') {
    try {
      const jsonLike = parsed.notes
        .replace(/([{,])\s*([a-zA-Z0-9_]+)\s*:/g, '$1"$2":') // Quote keys
        .replace(/:\s*([a-zA-Z0-9_.-]+)\s*([,}])/g, ':"$1"$2'); // Quote bare values
      const inner = JSON.parse(jsonLike);
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        parsed = { ...parsed, ...inner };
      }
    } catch {
      // Leave notes as plain text
    }
  }

  const tier = parsed.tier || parsed.affiliate_tier || parsed.cohort || null;
  if (tier && !parsed.tier) parsed.tier = tier;
  if (tier && !parsed.affiliate_tier) parsed.affiliate_tier = tier;

  return {
    tier,
    normalized: parsed
  };
}

/** Normalize CLI/admin meta into a plain object for JSONB storage. */
function parseMeta(raw) {
  return parseRecipientMetadata(raw).normalized;
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function invitesToCsv(rows) {
  const header = ['Code', 'SentToName', 'SentToEmail', 'Metadata', 'CreatedDate'];
  const lines = [header.join(',')];
  for (const row of rows) {
    const meta =
      typeof row.recipient_metadata === 'string'
        ? row.recipient_metadata
        : JSON.stringify(row.recipient_metadata || {});
    lines.push(
      [
        csvEscape(row.code),
        csvEscape(row.sent_to_name || ''),
        csvEscape(row.sent_to_email || ''),
        csvEscape(meta),
        csvEscape(row.created_at ? new Date(row.created_at).toISOString() : '')
      ].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Insert unique beta_invites rows. Retries on unique conflicts.
 */
async function createTargetedInvites(db, options = {}) {
  const count = Math.max(1, Math.min(parseInt(options.count, 10) || 1, 500));
  const sentToName = options.name ? String(options.name).trim() : null;
  const sentToEmail = options.email ? String(options.email).trim().toLowerCase() : null;
  const metadata = parseMeta(options.meta);
  const parentCode = options.parentCode ? String(options.parentCode).trim().toUpperCase() : null;
  const maxUses = Math.max(1, parseInt(options.maxUses, 10) || 1);
  const createdByUserId = options.createdByUserId || null;

  const created = [];
  for (let i = 0; i < count; i++) {
    let inserted = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = generateInviteCode();
      try {
        const result = await db.query(
          `INSERT INTO beta_invites (
              code, parent_code, sent_to_name, sent_to_email, recipient_metadata,
              max_uses, created_by_user_id
            )
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           RETURNING id, code, parent_code, sent_to_name, sent_to_email,
                     recipient_metadata, max_uses, uses_count, created_at,
                     claimed_by_user_id, claimed_at`,
          [
            code,
            parentCode,
            sentToName,
            sentToEmail,
            JSON.stringify(metadata),
            maxUses,
            createdByUserId
          ]
        );
        inserted = result.rows[0];
        break;
      } catch (err) {
        if (err && err.code === '23505') continue;
        throw err;
      }
    }
    if (!inserted) {
      throw new Error('Failed to generate a unique invite code after multiple attempts.');
    }
    created.push(inserted);
  }
  return created;
}

/**
 * Active admin beta code: a targeted beta_invites row, or a master beta_codes row.
 * Returns null when the code is missing, exhausted, or the tables are not migrated.
 */
async function findActiveBetaInvite(db, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code || !db) return null;

  try {
    const inviteRes = await db.query(
      `SELECT *
       FROM beta_invites
       WHERE UPPER(code) = $1
         AND uses_count < max_uses
         AND (claimed_by_user_id IS NULL OR max_uses > 1)
       LIMIT 1`,
      [code]
    );
    if (inviteRes.rows[0]) return { kind: 'invite', row: inviteRes.rows[0] };
  } catch (err) {
    if (!err || err.code !== '42P01') throw err;
  }

  try {
    const masterRes = await db.query(
      `SELECT *
       FROM beta_codes
       WHERE UPPER(code) = $1
         AND uses_count < max_uses
       LIMIT 1`,
      [code]
    );
    if (masterRes.rows[0]) return { kind: 'master', row: masterRes.rows[0] };
  } catch (err) {
    if (!err || err.code !== '42P01') throw err;
  }

  return null;
}

module.exports = {
  generateInviteCode,
  parseMeta,
  parseRecipientMetadata,
  csvEscape,
  invitesToCsv,
  createTargetedInvites,
  findActiveBetaInvite
};
