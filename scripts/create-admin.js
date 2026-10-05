#!/usr/bin/env node
/**
 * Bootstrap admin + excluded personal accounts against a target DATABASE_URL.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require"
 *   $env:ADMIN_BOOTSTRAP_PASSWORD="your-password"
 *   node scripts/create-admin.js
 *
 * Usage (bash):
 *   DATABASE_URL="postgresql://..." ADMIN_BOOTSTRAP_PASSWORD="..." node scripts/create-admin.js
 *
 * Never commit real production credentials. Pass them only via env for the run.
 */

'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD =
  process.env.ADMIN_BOOTSTRAP_PASSWORD ||
  process.env.BOOTSTRAP_PASSWORD ||
  process.env.BETA_SEED_PASSWORD;

const ADMINS = [
  { email: 'wtrchrisparks@gmail.com', name: 'Chris Parks', isCreator: false },
  { email: 'chris.finrev@gmail.com', name: 'Chris FinRev', isCreator: true },
  { email: 'ecci2760@gmail.com', name: 'ECCI Admin', isCreator: false },
  { email: 'admin@factsmoney.com', name: 'FACTS Admin', isCreator: false },
  { email: 'admin@thefinancialrevolution.net', name: 'TFR Admin', isCreator: false }
];

const EXCLUDED = {
  email: 'ecci2760f@gmail.com',
  name: 'Personal Account'
};

function looksLikePlaceholder(url) {
  const u = String(url || '').toLowerCase();
  return (
    !u ||
    u.includes('production_user') ||
    u.includes(':password@') ||
    u.includes('ep-production-instance') ||
    u.includes('example.com') ||
    u.includes('changeme')
  );
}

function referralCode() {
  return 'FACTS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

async function ensureColumns(client) {
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_creator BOOLEAN DEFAULT FALSE`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_beta_tester BOOLEAN DEFAULT TRUE`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20)`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliate_code VARCHAR(50)`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS affiliate_tier VARCHAR(64)`);
  await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS relationship_tag VARCHAR(50) DEFAULT 'STANDARD'`);
  await client.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_affiliate_disabled BOOLEAN NOT NULL DEFAULT FALSE`
  );
  await client.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_invites_remaining INT DEFAULT 5`
  );
}

async function upsertAdmin(client, account, passwordHash) {
  const email = account.email.toLowerCase();
  const existing = await client.query(
    `SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [email]
  );

  if (existing.rows[0]) {
    const r = await client.query(
      `UPDATE users
       SET name = COALESCE(NULLIF($2, ''), name),
           password_hash = $3,
           is_admin = TRUE,
           is_creator = $4,
           is_beta_tester = TRUE,
           relationship_tag = 'STANDARD',
           is_affiliate_disabled = FALSE
       WHERE id = $1
       RETURNING id, email, is_admin, is_creator, affiliate_tier`,
      [existing.rows[0].id, account.name, passwordHash, !!account.isCreator]
    );
    return { action: 'updated', user: r.rows[0] };
  }

  const r = await client.query(
    `INSERT INTO users (
        email, name, password_hash, referral_code, is_admin, is_creator,
        is_beta_tester, relationship_tag, is_affiliate_disabled, monthly_invites_remaining
      )
     VALUES ($1, $2, $3, $4, TRUE, $5, TRUE, 'STANDARD', FALSE, 5)
     RETURNING id, email, is_admin, is_creator, affiliate_tier`,
    [email, account.name, passwordHash, referralCode(), !!account.isCreator]
  );
  return { action: 'created', user: r.rows[0] };
}

async function upsertExcluded(client, passwordHash) {
  const email = EXCLUDED.email.toLowerCase();
  const existing = await client.query(
    `SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [email]
  );

  if (existing.rows[0]) {
    const r = await client.query(
      `UPDATE users
       SET name = COALESCE(NULLIF($2, ''), name),
           password_hash = $3,
           is_admin = FALSE,
           is_creator = FALSE,
           affiliate_tier = 'EXCLUDED',
           relationship_tag = 'STANDARD',
           is_affiliate_disabled = TRUE,
           affiliate_code = NULL,
           referral_code = NULL,
           monthly_invites_remaining = 0
       WHERE id = $1
       RETURNING id, email, is_admin, affiliate_tier, is_affiliate_disabled`,
      [existing.rows[0].id, EXCLUDED.name, passwordHash]
    );
    return { action: 'updated', user: r.rows[0] };
  }

  const r = await client.query(
    `INSERT INTO users (
        email, name, password_hash, referral_code, is_admin, is_creator,
        is_beta_tester, affiliate_tier, relationship_tag, is_affiliate_disabled,
        monthly_invites_remaining
      )
     VALUES ($1, $2, $3, NULL, FALSE, FALSE, TRUE, 'EXCLUDED', 'STANDARD', TRUE, 0)
     RETURNING id, email, is_admin, affiliate_tier, is_affiliate_disabled`,
    [email, EXCLUDED.name, passwordHash]
  );
  return { action: 'created', user: r.rows[0] };
}

async function main() {
  if (looksLikePlaceholder(DATABASE_URL)) {
    console.error(`
Refusing to run: DATABASE_URL looks missing or like a placeholder.

Set the real production Neon connection string, then:

  PowerShell:
    $env:DATABASE_URL="postgresql://USER:PASS@HOST/neondb?sslmode=require"
    $env:ADMIN_BOOTSTRAP_PASSWORD="your-password"
    node scripts/create-admin.js

  bash:
    DATABASE_URL="postgresql://..." ADMIN_BOOTSTRAP_PASSWORD="..." node scripts/create-admin.js
`);
    process.exit(1);
  }

  if (!PASSWORD || String(PASSWORD).length < 8) {
    console.error('ADMIN_BOOTSTRAP_PASSWORD (or BOOTSTRAP_PASSWORD) is required (min 8 chars).');
    process.exit(1);
  }

  const host = (String(DATABASE_URL).match(/@([^/?]+)/) || [])[1] || '(unknown host)';
  console.log('=== Admin bootstrap ===');
  console.log('Target host:', host);

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: String(DATABASE_URL).includes('localhost')
      ? false
      : { rejectUnauthorized: false }
  });

  await client.connect();
  await ensureColumns(client);
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  for (const admin of ADMINS) {
    const result = await upsertAdmin(client, admin, passwordHash);
    console.log(result.action, result.user.email, {
      is_admin: result.user.is_admin,
      is_creator: result.user.is_creator
    });
  }

  const excluded = await upsertExcluded(client, passwordHash);
  console.log(excluded.action, excluded.user.email, {
    is_admin: excluded.user.is_admin,
    affiliate_tier: excluded.user.affiliate_tier,
    is_affiliate_disabled: excluded.user.is_affiliate_disabled
  });

  const verify = await client.query(`
    SELECT email, is_admin, is_creator, affiliate_tier, is_affiliate_disabled,
           (password_hash IS NOT NULL) AS has_password
    FROM users
    WHERE LOWER(email) IN (
      'wtrchrisparks@gmail.com',
      'chris.finrev@gmail.com',
      'ecci2760@gmail.com',
      'admin@factsmoney.com',
      'admin@thefinancialrevolution.net',
      'ecci2760f@gmail.com'
    )
    ORDER BY email
  `);
  console.log('\nVERIFY');
  console.table(verify.rows);

  await client.end();
  console.log('\nDone. Log in on production with those emails + ADMIN_BOOTSTRAP_PASSWORD.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
