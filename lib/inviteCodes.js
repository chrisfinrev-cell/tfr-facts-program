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
  const createdBy = options.createdBy ? String(options.createdBy) : null;

  const created = [];
  for (let i = 0; i < count; i++) {
    let inserted = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = generateInviteCode();
      try {
        let result;
        try {
          result = await db.query(
            `INSERT INTO beta_invites (
                code, parent_code, sent_to_name, sent_to_email, recipient_metadata,
                max_uses, created_by_user_id, created_by
              )
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
             RETURNING id, code, parent_code, sent_to_name, sent_to_email,
                       recipient_metadata, max_uses, uses_count, created_at,
                       claimed_by_user_id, claimed_at, created_by_user_id, created_by`,
            [
              code,
              parentCode,
              sentToName,
              sentToEmail,
              JSON.stringify(metadata || {}),
              maxUses,
              createdByUserId,
              createdBy
            ]
          );
        } catch (columnErr) {
          if (!columnErr || columnErr.code !== '42703') throw columnErr;
          result = await db.query(
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
              JSON.stringify(metadata || {}),
              maxUses,
              createdByUserId
            ]
          );
        }
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
 * Create or extend a multi-use master beta_codes row.
 * Avoids ON CONFLICT so a missing unique constraint cannot abort the insert.
 */
async function createMasterAdminCode(db, options = {}) {
  await ensureBetaInviteTables(db);
  const rawName = options.code || options.codeName || options.name;
  const formattedCode = String(rawName || '').trim().toUpperCase();
  if (!formattedCode) {
    const err = new Error('Enter a code name (e.g. VIP-FOUNDER-2026).');
    err.status = 400;
    throw err;
  }
  if (formattedCode.length > 64) {
    const err = new Error('Code name must be 64 characters or fewer.');
    err.status = 400;
    throw err;
  }
  const maxUses = Math.max(1, parseInt(options.maxUses, 10) || 5);
  const createdByUserId = options.createdByUserId || null;
  const createdBy = options.createdBy ? String(options.createdBy) : null;

  const existing = await db.query(
    `SELECT id, code, max_uses, uses_count, created_at, created_by
     FROM beta_codes
     WHERE UPPER(code) = $1
     LIMIT 1`,
    [formattedCode]
  );
  if (existing.rows[0]) {
    const updated = await db.query(
      `UPDATE beta_codes
       SET max_uses = beta_codes.max_uses + $2,
           created_by = COALESCE(beta_codes.created_by, $3),
           created_by_user_id = COALESCE(beta_codes.created_by_user_id, $4)
       WHERE id = $1
       RETURNING id, code, max_uses, uses_count, created_at, created_by, created_by_user_id, name`,
      [existing.rows[0].id, maxUses, createdBy, createdByUserId]
    );
    return { ...updated.rows[0], addedUses: maxUses, created: false };
  }

  try {
    const inserted = await db.query(
      `INSERT INTO beta_codes (code, max_uses, uses_count, created_by, created_by_user_id, name)
       VALUES ($1, $2, 0, $3, $4, $5)
       RETURNING id, code, max_uses, uses_count, created_at, created_by, created_by_user_id, name`,
      [formattedCode, maxUses, createdBy, createdByUserId, formattedCode]
    );
    return { ...inserted.rows[0], addedUses: maxUses, created: true };
  } catch (err) {
    if (err && err.code === '42703') {
      const inserted = await db.query(
        `INSERT INTO beta_codes (code, max_uses, uses_count)
         VALUES ($1, $2, 0)
         RETURNING id, code, max_uses, uses_count, created_at`,
        [formattedCode, maxUses]
      );
      return { ...inserted.rows[0], addedUses: maxUses, created: true };
    }
    throw err;
  }
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
    'created_by VARCHAR(255)',
    'max_uses INT NOT NULL DEFAULT 1',
    'uses_count INT NOT NULL DEFAULT 0',
    'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    'last_emailed_at TIMESTAMPTZ',
    'last_email_error TEXT'
  ];
  for (const column of columns) {
    await db.query(`ALTER TABLE beta_invites ADD COLUMN IF NOT EXISTS ${column}`);
  }
  const masterColumns = [
    'max_uses INT DEFAULT 5',
    'uses_count INT DEFAULT 0',
    'created_at TIMESTAMPTZ DEFAULT NOW()',
    'created_by VARCHAR(255)',
    'created_by_user_id INTEGER',
    'name VARCHAR(255)'
  ];
  for (const column of masterColumns) {
    await db.query(`ALTER TABLE beta_codes ADD COLUMN IF NOT EXISTS ${column}`);
  }
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS beta_codes_code_key ON beta_codes (code)`);
  try {
    await db.query(`ALTER TABLE beta_codes ALTER COLUMN code TYPE VARCHAR(64)`);
  } catch (err) {
    console.warn('Could not widen beta_codes.code:', err.message);
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS beta_referral_signups (
      id SERIAL PRIMARY KEY,
      referrer_user_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ensureInviteCodeTable(db);
}

const ADMIN_POOL_SIZE = 100;
const MEMBER_MONTHLY_REFERRALS = 5;
const INVITE_CODE_PREFIX = 'FIN-REV';
const INVITE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  USED: 'USED',
  REVOKED: 'REVOKED'
});
const INVALID_INVITE_ERROR = 'Invalid or already used invite code.';

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

function mapInviteCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    createdBy: row.created_by,
    usedBy: row.used_by,
    createdAt: row.created_at,
    usedAt: row.used_at
  };
}

async function ensureInviteCodeTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      id SERIAL PRIMARY KEY,
      code VARCHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
      created_by VARCHAR(255) NOT NULL,
      used_by VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ,
      CONSTRAINT invite_codes_status_chk CHECK (status IN ('ACTIVE', 'USED', 'REVOKED'))
    )
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS invite_codes_code_uidx
      ON invite_codes (UPPER(code))
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS invite_codes_status_idx
      ON invite_codes (status)
  `);
}

function formatInviteCode(prefix = INVITE_CODE_PREFIX) {
  const safePrefix = String(prefix || INVITE_CODE_PREFIX).toUpperCase();
  return `${safePrefix}-${randomSegment(4)}-${randomSegment(4)}`;
}

/**
 * Generate unique invite codes and save them under the current admin.
 * Format: `${prefix}-XXXX-XXXX` (default FIN-REV-XXXX-XXXX).
 * All administrators share this list; createdBy records who generated the batch.
 */
async function generateInviteCodes(db, count = 100, prefix = INVITE_CODE_PREFIX, createdBy) {
  if (typeof db === 'number') {
    createdBy = prefix;
    prefix = count;
    count = db;
    db = null;
  }
  if (!db || typeof db.query !== 'function') {
    throw new Error('generateInviteCodes requires a database connection.');
  }

  await ensureInviteCodeTable(db);
  const n = Math.max(1, Math.min(parseInt(count, 10) || 100, 500));
  const prefixValue = String(prefix || INVITE_CODE_PREFIX).toUpperCase();
  const createdByValue = createdBy == null || createdBy === '' ? 'admin' : String(createdBy);
  const created = [];
  const inBatch = new Set();

  while (created.length < n) {
    let code = null;
    for (let attempt = 0; attempt < 24; attempt++) {
      const candidate = formatInviteCode(prefixValue);
      if (!inBatch.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      throw new Error('Failed to generate a unique invite code after multiple attempts.');
    }
    inBatch.add(code);
    try {
      const result = await db.query(
        `INSERT INTO invite_codes (code, status, created_by)
         VALUES ($1, 'ACTIVE', $2)
         RETURNING id, code, status, created_by, used_by, created_at, used_at`,
        [code, createdByValue]
      );
      created.push(mapInviteCode(result.rows[0]));
    } catch (err) {
      inBatch.delete(code);
      if (err && err.code === '23505') continue;
      throw err;
    }
  }
  return created;
}

async function findInviteCode(db, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code || !db) return null;
  try {
    const found = await db.query(
      `SELECT id, code, status, created_by, used_by, created_at, used_at
       FROM invite_codes
       WHERE UPPER(code) = $1
       LIMIT 1`,
      [code]
    );
    return mapInviteCode(found.rows[0]);
  } catch (err) {
    if (err && err.code === '42P01') return null;
    throw err;
  }
}

async function findActiveInviteCode(db, rawCode) {
  const row = await findInviteCode(db, rawCode);
  if (!row || row.status !== INVITE_STATUS.ACTIVE) return null;
  return row;
}

async function redeemInviteCode(db, rawCode, usedBy) {
  const code = String(rawCode || '').trim().toUpperCase();
  const usedByValue = usedBy == null ? null : String(usedBy);
  const result = await db.query(
    `UPDATE invite_codes
     SET status = 'USED',
         used_by = $2,
         used_at = NOW()
     WHERE UPPER(code) = $1
       AND status = 'ACTIVE'
     RETURNING id, code, status, created_by, used_by, created_at, used_at`,
    [code, usedByValue]
  );
  return mapInviteCode(result.rows[0]);
}

async function listInviteCodes(db, status) {
  await ensureInviteCodeTable(db);
  const params = [];
  let where = '';
  if (status) {
    params.push(String(status).toUpperCase());
    where = 'WHERE status = $1';
  }
  const result = await db.query(
    `SELECT id, code, status, created_by, used_by, created_at, used_at
     FROM invite_codes
     ${where}
     ORDER BY id ASC`,
    params
  );
  return result.rows.map(mapInviteCode);
}

async function listActiveInviteCodes(db) {
  return listInviteCodes(db, INVITE_STATUS.ACTIVE);
}

/**
 * Keep one shared list of 100 ACTIVE codes for every administrator.
 * Tops up used codes; does not create a second private list per admin.
 */
async function ensureSharedInvitePool(db, createdBy, size = ADMIN_POOL_SIZE) {
  await ensureInviteCodeTable(db);
  const existing = await db.query(
    `SELECT COUNT(*)::int AS n FROM invite_codes WHERE status = 'ACTIVE'`
  );
  const missing = Math.max(0, size - existing.rows[0].n);
  let created = [];
  if (missing > 0) {
    created = await generateInviteCodes(db, missing, INVITE_CODE_PREFIX, createdBy);
  }
  const codes = await listInviteCodes(db);
  return { created, codes };
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
  generateInviteCodes,
  formatInviteCode,
  parseMeta,
  parseRecipientMetadata,
  csvEscape,
  invitesToCsv,
  createTargetedInvites,
  createMasterAdminCode,
  findActiveBetaInvite,
  ensureBetaInviteTables,
  ensureInviteCodeTable,
  findInviteCode,
  findActiveInviteCode,
  redeemInviteCode,
  listInviteCodes,
  listActiveInviteCodes,
  ensureSharedInvitePool,
  mapInviteCode,
  ADMIN_POOL_SIZE,
  MEMBER_MONTHLY_REFERRALS,
  INVITE_CODE_PREFIX,
  INVITE_STATUS,
  INVALID_INVITE_ERROR,
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
