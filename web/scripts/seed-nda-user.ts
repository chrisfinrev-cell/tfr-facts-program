import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, '..');
const repoRoot = resolve(webRoot, '..');

const SEED_EMAIL = (process.env.NDA_SEED_EMAIL || 'nda-pdf-seed@facts.local').toLowerCase();
const SEED_NAME = process.env.NDA_SEED_NAME || 'Sovereign Beta Tester';
const SEED_SIGNATURE = process.env.NDA_SEED_SIGNATURE || SEED_NAME;
const SEED_PASSWORD = process.env.NDA_SEED_PASSWORD || 'NdaPdfSeed2026!';
const SEED_VERSION = process.env.NDA_SEED_VERSION || 'v1.0-BETA';
const SEED_IP = process.env.NDA_SEED_IP || '203.0.113.42';
const SEED_UA =
  process.env.NDA_SEED_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FACTS-NDA-Seed';

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function loadEnv() {
  for (const filePath of [
    resolve(repoRoot, '.env'),
    resolve(repoRoot, '.env.local'),
    resolve(webRoot, '.env'),
    resolve(webRoot, '.env.local')
  ]) {
    loadEnvFile(filePath);
  }
}

async function hashPassword(plain: string): Promise<string | null> {
  const require = createRequire(import.meta.url);
  const candidates = [
    resolve(repoRoot, 'node_modules/bcrypt'),
    resolve(webRoot, 'node_modules/bcrypt'),
    'bcrypt'
  ];
  for (const candidate of candidates) {
    try {
      const bcrypt = require(candidate) as { hash: (p: string, r: number) => Promise<string> };
      return bcrypt.hash(plain, 10);
    } catch {
      // try next resolver
    }
  }
  return null;
}

async function main() {
  loadEnv();

  const connectionString = process.env.DATABASE_URL || '';
  if (!connectionString) {
    throw new Error('DATABASE_URL is missing. Set it in .env or web/.env.local');
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  const passwordHash = await hashPassword(SEED_PASSWORD);

  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_beta_tester BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nda_accepted_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nda_version VARCHAR(20);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nda_typed_signature TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nda_user_agent TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS nda_signed_ip VARCHAR(64);
    CREATE TABLE IF NOT EXISTS nda_acceptances (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nda_version VARCHAR(64) NOT NULL,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address VARCHAR(64),
      UNIQUE (user_id, nda_version)
    );
  `);

  const existing = await pool.query(
    'SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1',
    [SEED_EMAIL]
  );

  let userId: number;
  if (existing.rows[0]) {
    userId = existing.rows[0].id;
    await pool.query(
      `UPDATE users
       SET name = COALESCE(NULLIF(name, ''), $2),
           nda_accepted_at = COALESCE(nda_accepted_at, NOW()),
           nda_version = $3,
           nda_typed_signature = $4,
           nda_user_agent = $5,
           nda_signed_ip = $6,
           updated_at = NOW()
       WHERE id = $1`,
      [userId, SEED_NAME, SEED_VERSION, SEED_SIGNATURE, SEED_UA, SEED_IP]
    );
  } else {
    const referralCode = `NDA${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const inserted = await pool.query(
      `INSERT INTO users (
          email, name, password_hash, is_beta_tester, referral_code,
          nda_accepted_at, nda_version, nda_typed_signature, nda_user_agent, nda_signed_ip
        )
       VALUES ($1, $2, $3, TRUE, $4, NOW(), $5, $6, $7, $8)
       RETURNING id`,
      [
        SEED_EMAIL,
        SEED_NAME,
        passwordHash,
        referralCode,
        SEED_VERSION,
        SEED_SIGNATURE,
        SEED_UA,
        SEED_IP
      ]
    );
    userId = inserted.rows[0].id;
  }

  await pool.query(
    `INSERT INTO user_profiles (user_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = NOW()`,
    [userId, SEED_NAME]
  ).catch(() => undefined);

  await pool.query(
    `INSERT INTO nda_acceptances (user_id, accepted_at, nda_version, ip_address)
     VALUES ($1, NOW(), $2, $3)
     ON CONFLICT (user_id, nda_version) DO UPDATE
       SET accepted_at = NOW(), ip_address = EXCLUDED.ip_address`,
    [userId, 'v1', SEED_IP]
  ).catch(async () => {
    await pool.query(
      `INSERT INTO nda_acceptances (user_id, accepted_at, nda_version, ip_address)
       VALUES ($1, NOW(), $2, $3)`,
      [userId, SEED_VERSION, SEED_IP]
    ).catch(() => undefined);
  });

  const verify = await pool.query(
    `SELECT id, email, name, nda_accepted_at, nda_version, nda_typed_signature, nda_signed_ip
     FROM users WHERE id = $1`,
    [userId]
  );

  await pool.end();

  const row = verify.rows[0];
  console.log('Seeded NDA user');
  console.log(`  id:        ${row.id}`);
  console.log(`  email:     ${row.email}`);
  console.log(`  name:      ${row.name}`);
  console.log(`  signedAt:  ${row.nda_accepted_at}`);
  console.log(`  version:   ${row.nda_version}`);
  console.log(`  signature: ${row.nda_typed_signature}`);
  console.log(`  ip:        ${row.nda_signed_ip}`);
  console.log(`  download:  http://localhost:3001/api/v1/nda/download-pdf?userId=${row.id}`);
  if (!existing.rows[0] && passwordHash) {
    console.log(`  password:  ${SEED_PASSWORD}`);
  }
}

main().catch((error) => {
  console.error('Failed to seed NDA user:', error instanceof Error ? error.message : error);
  process.exit(1);
});
