#!/usr/bin/env node
/**
 * Generate targeted beta invite codes with recipient identity markers.
 *
 * Usage:
 *   node scripts/generate-invite-codes.js --count=1 --name="Jane Doe" --email="jane@example.com" --meta='{"cohort":"investors"}'
 *   node scripts/generate-invite-codes.js --count=5 --parent=FACTS-ABCD-1234 --csv=./invites.csv
 *   node scripts/generate-invite-codes.js --shared --count=100 --email=admin@factsmoney.com
 *
 * Flags:
 *   --shared           Top up the shared 100-code admin list (FIN-REV-XXXX-XXXX)
 *   --count=N          Number of codes (default 1, max 500)
 *   --name="..."       Recipient full name / organization
 *   --email="..."      Recipient email
 *   --meta='{...}'     JSON metadata (cohort, tier, campaign, notes)
 *   --parent=CODE      Parent / lineage invite or referral code
 *   --max-uses=N       Redemptions allowed per code (default 1)
 *   --csv=path.csv     Write CSV export (Code, SentToName, SentToEmail, Metadata, CreatedDate)
 *   --stdout-csv       Print CSV to stdout instead of table
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const {
  createTargetedInvites,
  invitesToCsv,
  parseMeta,
  ensureSharedInvitePool,
  INVITE_CODE_PREFIX
} = require('../lib/inviteCodes');

function getFlag(name, fallback = null) {
  const argv = process.argv.slice(2);
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = argv.indexOf(`--${name}`);
  if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  if (argv.includes(`--${name}`)) return true;
  return fallback;
}

async function ensureSchema(pool) {
  const sqlPath = path.join(__dirname, '..', 'db', 'beta_invites_migration.sql');
  await pool.query(fs.readFileSync(sqlPath, 'utf8'));
  const inviteSqlPath = path.join(__dirname, '..', 'db', 'invite_codes_migration.sql');
  if (fs.existsSync(inviteSqlPath)) {
    await pool.query(fs.readFileSync(inviteSqlPath, 'utf8'));
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const count = getFlag('count', '1');
  const name = getFlag('name');
  const email = getFlag('email');
  const meta = getFlag('meta', '{}');
  const parentCode = getFlag('parent') || getFlag('parent-code');
  const maxUses = getFlag('max-uses', '1');
  const csvPath = getFlag('csv');
  const stdoutCsv = getFlag('stdout-csv') === true;
  const shared = getFlag('shared') === true;

  if (!shared) parseMeta(meta);

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: String(process.env.DATABASE_URL).includes('localhost')
      ? false
      : { rejectUnauthorized: false }
  });

  try {
    await ensureSchema(pool);
    let created;
    if (shared) {
      const result = await ensureSharedInvitePool(
        pool,
        email || 'cli',
        parseInt(count, 10) || 100
      );
      created = result.created.length ? result.created : result.codes.filter((row) => row.status === 'ACTIVE');
      console.log(
        result.created.length
          ? `Added ${result.created.length} shared ${INVITE_CODE_PREFIX} codes.`
          : `Shared list already has ${created.length} active ${INVITE_CODE_PREFIX} codes.`
      );
    } else {
      created = await createTargetedInvites(pool, {
        count,
        name,
        email,
        meta,
        parentCode,
        maxUses
      });
    }

    const csv = invitesToCsv(created);
    if (csvPath) {
      const abs = path.resolve(String(csvPath));
      fs.writeFileSync(abs, csv, 'utf8');
      console.log(`Wrote CSV: ${abs}`);
    }
    if (stdoutCsv) {
      process.stdout.write(csv);
    } else {
      console.log(`${shared ? 'Shared' : 'Generated'} ${created.length} invite code(s):`);
      for (const row of created) {
        console.log(
          `  ${row.code}  →  ${row.sent_to_name || row.createdBy || '(shared)'} <${row.sent_to_email || row.status || 'n/a'}>`
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Failed to generate invite codes:', err.message || err);
  process.exit(1);
});
