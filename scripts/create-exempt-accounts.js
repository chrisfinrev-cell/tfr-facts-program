#!/usr/bin/env node
/**
 * Create Future Generations accounts with sovereign feature access.
 *
 * Access model (two tiers):
 *   Admin (chris.finrev@gmail.com):  is_creator=true — full admin panel + all features
 *   Future Gen (ecci2760, dianes3cps): is_creator=false — sovereign features via
 *                                       isOwnerEmail() check in hasProAccess(), NO admin panel
 *
 * IMPORTANT: Future Gen accounts do NOT get is_creator=true. Access is granted via
 * the FUTURE_GEN_EMAILS env var in server.js (isOwnerEmail/isFutureGenEmail checks).
 * is_creator=true is reserved for chris.finrev@gmail.com only.
 *
 * Run once: node scripts/create-exempt-accounts.js
 */

require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Future Generations accounts — no admin panel, no affiliate eligibility.
// Access granted via FUTURE_GEN_EMAILS list in server.js (isOwnerEmail check).
const ACCOUNTS = [
  { email: 'ecci2760@gmail.com', name: 'Christopher' },
  { email: 'dianes3cps@gmail.com', name: 'Diane' },
];

// Temporary password — from env, or generated once per run. Users should reset via Forgot Password.
const TEMP_PASSWORD =
  process.env.EXEMPT_ACCOUNT_TEMP_PASSWORD
  || process.env.BETA_SEED_PASSWORD
  || crypto.randomBytes(16).toString('hex');
const GENERATED_TEMP_PASSWORD =
  !process.env.EXEMPT_ACCOUNT_TEMP_PASSWORD && !process.env.BETA_SEED_PASSWORD;

async function generateUniqueReferralCode(client) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = 'FACTS-';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const check = await client.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (check.rows.length === 0) return code;
  }
  throw new Error('Could not generate unique referral code after 20 attempts');
}

async function seedUserAllocations(client, userId) {
  const existing = await client.query('SELECT id FROM allocations WHERE user_id = $1 LIMIT 1', [userId]);
  if (existing.rows.length > 0) return;

  const defaults = [
    ['Necessities', 50], ['Education', 10], ['Give', 10],
    ['Save', 10], ['Fun', 10], ['Financial Freedom', 10]
  ];
  for (const [category, pct] of defaults) {
    await client.query(
      `INSERT INTO allocations (user_id, category, percentage) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, category, pct]
    );
  }
}

async function main() {
  console.log('=== Creating Future Generations Accounts ===\n');
  if (GENERATED_TEMP_PASSWORD) {
    console.log(`Temporary password: ${TEMP_PASSWORD} (generated — store securely; set EXEMPT_ACCOUNT_TEMP_PASSWORD to pin)`);
  } else {
    console.log('Temporary password: (from EXEMPT_ACCOUNT_TEMP_PASSWORD / BETA_SEED_PASSWORD env)');
  }
  console.log('(Users should reset via Forgot Password after first login)\n');

  const passwordHash = await bcrypt.hash(TEMP_PASSWORD, 12);
  const client = await pool.connect();

  try {
    for (const account of ACCOUNTS) {
      const email = account.email.toLowerCase();
      console.log(`Processing: ${email} (${account.name})`);

      const existing = await client.query('SELECT id, is_creator FROM users WHERE LOWER(email) = $1', [email]);

      if (existing.rows.length > 0) {
        const user = existing.rows[0];
        if (user.is_creator) {
          // Only chris.finrev should have is_creator=true — correct for admin account
          console.log(`  → Account exists (id=${user.id}). is_creator=${user.is_creator} — no change needed.`);
        } else {
          console.log(`  → Account exists (id=${user.id}). is_creator=false — correct for Future Gen.`);
        }
        await client.query(
          `UPDATE users SET name = COALESCE(name, $2), updated_at = NOW() WHERE id = $1`,
          [user.id, account.name]
        );
        console.log(`  ✓ Name updated`);
      } else {
        const refCode = await generateUniqueReferralCode(client);

        const result = await client.query(
          `INSERT INTO users (email, password_hash, name, is_creator, plan, created_at, updated_at, referral_code)
           VALUES ($1, $2, $3, false, 'free', NOW(), NOW(), $4)
           RETURNING id`,
          [email, passwordHash, account.name, refCode]
        );
        const userId = result.rows[0].id;
        console.log(`  → Created new account (id=${userId})`);

        try {
          await seedUserAllocations(client, userId);
          console.log(`  ✓ Seeded default allocations`);
        } catch (e) {
          console.log(`  ⚠ Allocation seed skipped: ${e.message}`);
        }

        console.log(`  ✓ Created: is_creator=false, referral_code=${refCode}`);
      }

      const verify = await client.query(
        `SELECT id, email, name, is_creator, plan, paid_until, promo_code_used, referral_code
         FROM users WHERE LOWER(email) = $1`,
        [email]
      );
      const u = verify.rows[0];
      // Pro access comes from isOwnerEmail check (FUTURE_GEN_EMAILS), not is_creator
      const hasPro = u.is_creator || u.promo_code_used || (u.plan === 'paid' && u.paid_until && new Date(u.paid_until) > new Date());
      console.log(`  Verified: id=${u.id}, is_creator=${u.is_creator}, hasPro=${hasPro}, referral_code=${u.referral_code}\n`);
    }

    console.log('=== Done ===');
    console.log('Future Generations accounts have:');
    console.log('  ✓ Sovereign feature access (via FUTURE_GEN_EMAILS in server.js, isOwnerEmail())');
    console.log('  ✓ All paywalls bypassed (Phase Zero, tiers, gamification)');
    console.log('  ✓ Eligible for XP, rewards, Sovereign Credits');
    console.log('  ✗ NO admin panel access');
    console.log('  ✗ NOT eligible for affiliate program (no commissions, no referral payouts)');
    if (GENERATED_TEMP_PASSWORD) {
      console.log(`  ✓ Temporary password (this run only): ${TEMP_PASSWORD}`);
    } else {
      console.log('  ✓ Temporary password sourced from env (not printed again)');
    }
    console.log('     → Share via password manager, or have users use Forgot Password');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
