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

async function ensureBetaInviteTables(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS beta_codes (
      id SERIAL PRIMARY KEY,
      code VARCHAR(50) UNIQUE NOT NULL,
      max_uses INT DEFAULT 5,
      uses_count INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS beta_invites (
      id SERIAL PRIMARY KEY,
      code VARCHAR(50) UNIQUE NOT NULL,
      max_uses INT NOT NULL DEFAULT 1,
      uses_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const columns = [
    'parent_code VARCHAR(50)',
    'sent_to_name VARCHAR(255)',
    'sent_to_email VARCHAR(255)',
    "recipient_metadata JSONB NOT NULL DEFAULT '{}'::jsonb",
    'claimed_by_user_id INTEGER',
    'claimed_at TIMESTAMPTZ',
    'created_by_user_id INTEGER',
    'max_uses INT NOT NULL DEFAULT 1',
    'uses_count INT NOT NULL DEFAULT 0',
    'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    'last_emailed_at TIMESTAMPTZ',
    'last_email_error TEXT'
  ];
  for (const column of columns) {
    await db.query(`ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS ${column}`);
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS beta_referral_signups (
      id SERIAL PRIMARY KEY,
      referrer_user_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

const ADMIN_POOL_SIZE = 100;
const MEMBER_MONTHLY_REFERRALS = 5;

function betaInviteOnly() {
  return String(process.env.BETA_INVITE_ONLY || 'true').toLowerCase() !== 'false';
}

function currentInviteMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

function inviteStatus(row) {
  if (row.claimed_by_user_id || Number(row.uses_count) >= Number(row.max_uses)) return 'signed_up';
  if (row.sent_to_email) return 'assigned';
  return 'available';
}

const POOL_COLUMNS = `bi.id, bi.code, bi.sent_to_name, bi.sent_to_email, bi.recipient_metadata,
  bi.claimed_by_user_id, bi.claimed_at, bi.max_uses, bi.uses_count, bi.created_at,
  bi.last_emailed_at, bi.last_email_error, claimer.email AS claimed_by_email`;

/** Tops the shared admin pool up to ADMIN_POOL_SIZE codes. Returns how many were added. */
async function ensureAdminPool(db, adminUserId) {
  await ensureBetaInviteTables(db);
  const existing = await db.query(
    `SELECT COUNT(*)::int AS n FROM beta_invites WHERE recipient_metadata->>'pool' = 'admin'`
  );
  const missing = ADMIN_POOL_SIZE - existing.rows[0].n;
  if (missing <= 0) return 0;
  const created = await createTargetedInvites(db, {
    count: missing,
    meta: { pool: 'admin' },
    maxUses: 1,
    createdByUserId: adminUserId || null
  });
  return created.length;
}

async function listAdminPool(db) {
  const result = await db.query(
    `SELECT ${POOL_COLUMNS}
     FROM beta_invites bi
     LEFT JOIN users claimer ON claimer.id = bi.claimed_by_user_id
     WHERE bi.recipient_metadata->>'pool' = 'admin'
     ORDER BY bi.id ASC`
  );
  return result.rows.map((row) => ({ ...row, status: inviteStatus(row) }));
}

/**
 * How many people a member's own referral code has brought in this calendar month,
 * and how many it can still bring in. Admin accounts have no monthly limit.
 */
async function memberReferralUsage(db, user) {
  await ensureBetaInviteTables(db);
  const { userIsAdminAccount } = require('../config/adminAccess');
  const used = await db.query(
    `SELECT COUNT(*)::int AS n FROM beta_referral_signups
     WHERE referrer_user_id = $1 AND created_at >= date_trunc('month', NOW())`,
    [user.id]
  );
  const unlimited = userIsAdminAccount(user);
  const usedThisMonth = used.rows[0].n;
  return {
    limit: unlimited ? null : MEMBER_MONTHLY_REFERRALS,
    usedThisMonth,
    remaining: unlimited ? Infinity : Math.max(0, MEMBER_MONTHLY_REFERRALS - usedThisMonth)
  };
}

/** Matches a code against members' own referral codes. Returns null when no member has it. */
async function findMemberReferralInvite(db, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code || !db) return null;
  const found = await db.query(
    `SELECT id, email, is_admin, referral_code FROM users WHERE UPPER(referral_code) = $1 LIMIT 1`,
    [code]
  );
  if (!found.rows[0]) return null;
  const usage = await memberReferralUsage(db, found.rows[0]);
  return { user: found.rows[0], ...usage };
}

/**
 * Puts a name and email on an unused code from the given pool.
 * Picks the next available code when inviteId is not given.
 */
async function assignPoolInvite(db, { pool, ownerUserId, inviteId, name, email }) {
  const params = [pool];
  let where = `recipient_metadata->>'pool' = $1 AND claimed_by_user_id IS NULL AND uses_count < max_uses`;
  if (ownerUserId) {
    params.push(ownerUserId);
    where += ` AND created_by_user_id = $${params.length}`;
  }
  if (inviteId) {
    params.push(inviteId);
    where += ` AND id = $${params.length}`;
  } else {
    where += ' AND sent_to_email IS NULL';
  }
  params.push(name ? String(name).trim() : null, String(email).trim().toLowerCase());
  const nameParam = `$${params.length - 1}`;
  const emailParam = `$${params.length}`;
  const updated = await db.query(
    `UPDATE beta_invites
     SET sent_to_name = ${nameParam}, sent_to_email = ${emailParam}
     WHERE id = (
       SELECT id FROM beta_invites WHERE ${where}
       ORDER BY id ASC LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, code, sent_to_name, sent_to_email`,
    params
  );
  return updated.rows[0] || null;
}

async function recordInviteEmailResult(db, inviteId, result) {
  if (!inviteId) return;
  try {
    await db.query(
      `UPDATE beta_invites
       SET last_emailed_at = CASE WHEN $2::boolean THEN NOW() ELSE last_emailed_at END,
           last_email_error = $3
       WHERE id = $1`,
      [inviteId, !!result.sent, result.sent ? null : (result.error || 'Send failed')]
    );
  } catch (err) {
    console.warn('Could not record beta invite email status:', err.message);
  }
}

module.exports = {
  generateInviteCode,
  parseMeta,
  parseRecipientMetadata,
  csvEscape,
  invitesToCsv,
  createTargetedInvites,
  findActiveBetaInvite,
  ensureBetaInviteTables,
  ADMIN_POOL_SIZE,
  MEMBER_MONTHLY_REFERRALS,
  betaInviteOnly,
  currentInviteMonth,
  inviteStatus,
  ensureAdminPool,
  listAdminPool,
  memberReferralUsage,
  findMemberReferralInvite,
  assignPoolInvite,
  recordInviteEmailResult
};
