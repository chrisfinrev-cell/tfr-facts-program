#!/usr/bin/env node
/**
 * SANDBOX SEED SCRIPT
 * ═══════════════════════════════════════════════════════════════════════════
 * Creates/refreshes the sandbox training account with realistic demo data.
 * Runs automatically during: npm run build (via migrate + seed pipeline)
 *
 * Sandbox credentials:
 *   Email:    sandbox@financial-revolution.app (or SANDBOX_EMAIL)
 *   Password: from SANDBOX_PASSWORD / BETA_SEED_PASSWORD env (never commit secrets)
 *
 * ⚠️  ENGINEER NOTE: When shipping new features that introduce new data
 *     sections or tables, ADD SAMPLE DATA HERE so the sandbox reflects
 *     the latest state of the platform. Search for "SANDBOX_UPDATE_NEEDED"
 *     to find the relevant sections to update.
 *
 * Run manually: node scripts/seed-sandbox.js
 */

// Note: dotenv not needed — Render injects env vars directly in production
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const SANDBOX_EMAIL = process.env.SANDBOX_EMAIL || 'sandbox@financial-revolution.app';
const SANDBOX_PASSWORD =
  process.env.SANDBOX_PASSWORD
  || process.env.BETA_SEED_PASSWORD
  || crypto.randomBytes(16).toString('hex');
const SANDBOX_NAME = process.env.SANDBOX_NAME || 'Alex Rivera (Demo)';
const GENERATED_SANDBOX_PASSWORD = !process.env.SANDBOX_PASSWORD && !process.env.BETA_SEED_PASSWORD;

// Category IDs (from categories table)
const CAT = {
  NECESSITIES: 1,
  EDUCATION: 2,
  GIVE: 3,
  SAVE: 4,
  FUN: 5,
  FINANCIAL_FREEDOM: 6,
};

// Helper: date offset from today
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
}

async function generateReferralCode(client) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = 'DEMO-';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const check = await client.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (check.rows.length === 0) return code;
  }
  return 'DEMO-SANDBOX';
}

async function clearSandboxData(client, userId) {
  console.log('  → Clearing existing sandbox data...');
  // Clear in reverse dependency order
  const tables = [
    'portfolio_transactions', 'portfolio_accounts', 'portfolio_price_snapshots',
    'portfolio_annual_records', 'portfolio_annual_goals',
    'net_worth_entries', 'net_worth_snapshots',
    'gift_card_transactions', 'gift_cards',
    'transactions',
    'recurring_bills',
    'debts',
    'loans',
    'credit_cards',
    'bank_accounts',
    'permanent_allocations',
    'user_allocations',
    'financial_freedom',
    'tfr_user_stats', 'tfr_xp_events',
  ];
  for (const table of tables) {
    try {
      await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [userId]);
    } catch (e) {
      // Table may not have user_id column or may not exist — skip
    }
  }
}

async function seedAllocations(client, userId) {
  console.log('  → Seeding allocations...');
  const allocs = [
    { category_id: CAT.NECESSITIES, percentage: 50 },
    { category_id: CAT.EDUCATION, percentage: 10 },
    { category_id: CAT.GIVE, percentage: 10 },
    { category_id: CAT.SAVE, percentage: 10 },
    { category_id: CAT.FUN, percentage: 10 },
    { category_id: CAT.FINANCIAL_FREEDOM, percentage: 10 },
  ];
  for (const a of allocs) {
    await client.query(
      `INSERT INTO permanent_allocations (user_id, category_id, percentage, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, category_id)
       DO UPDATE SET percentage = $3, updated_at = NOW()`,
      [userId, a.category_id, a.percentage]
    );
  }
}

async function seedTransactions(client, userId) {
  console.log('  → Seeding transactions...');
  // Transactions spanning ~6 months across all categories
  const txns = [
    // ── INCOME ────────────────────────────────────────────────────────────────
    { type: 'income', amount: 5800.00, description: 'Paycheck - Employer', category_id: CAT.NECESSITIES, date: daysAgo(2) },
    { type: 'income', amount: 5800.00, description: 'Paycheck - Employer', category_id: CAT.NECESSITIES, date: daysAgo(17) },
    { type: 'income', amount: 5800.00, description: 'Paycheck - Employer', category_id: CAT.NECESSITIES, date: monthsAgo(1) + '' },
    { type: 'income', amount: 5800.00, description: 'Paycheck - Employer', category_id: CAT.NECESSITIES, date: monthsAgo(1) },
    { type: 'income', amount: 5800.00, description: 'Paycheck - Employer', category_id: CAT.NECESSITIES, date: monthsAgo(2) },
    { type: 'income', amount: 5800.00, description: 'Paycheck - Employer', category_id: CAT.NECESSITIES, date: monthsAgo(2) },
    { type: 'income', amount: 5800.00, description: 'Paycheck - Employer', category_id: CAT.NECESSITIES, date: monthsAgo(3) },
    { type: 'income', amount: 5800.00, description: 'Paycheck - Employer', category_id: CAT.NECESSITIES, date: monthsAgo(3) },
    { type: 'income', amount: 5800.00, description: 'Paycheck - Employer', category_id: CAT.NECESSITIES, date: monthsAgo(4) },
    { type: 'income', amount: 5800.00, description: 'Paycheck - Employer', category_id: CAT.NECESSITIES, date: monthsAgo(4) },
    { type: 'income', amount: 350.00,  description: 'Side hustle - Freelance', category_id: CAT.FINANCIAL_FREEDOM, date: daysAgo(10) },
    { type: 'income', amount: 240.00,  description: 'Dividend - VTSAX', category_id: CAT.FINANCIAL_FREEDOM, date: daysAgo(45) },
    { type: 'income', amount: 125.00,  description: 'Cashback Rewards', category_id: CAT.SAVE, date: daysAgo(30) },
    { type: 'income', amount: 500.00,  description: 'Tax Refund', category_id: CAT.SAVE, date: monthsAgo(3) },

    // ── NECESSITIES ───────────────────────────────────────────────────────────
    { type: 'expense', amount: 1750.00, description: 'Rent', category_id: CAT.NECESSITIES, date: daysAgo(1) },
    { type: 'expense', amount: 1750.00, description: 'Rent', category_id: CAT.NECESSITIES, date: daysAgo(32) },
    { type: 'expense', amount: 1750.00, description: 'Rent', category_id: CAT.NECESSITIES, date: daysAgo(62) },
    { type: 'expense', amount: 1750.00, description: 'Rent', category_id: CAT.NECESSITIES, date: daysAgo(92) },
    { type: 'expense', amount: 1750.00, description: 'Rent', category_id: CAT.NECESSITIES, date: daysAgo(122) },
    { type: 'expense', amount: 95.40,  description: 'Electric & Gas', category_id: CAT.NECESSITIES, date: daysAgo(5) },
    { type: 'expense', amount: 92.15,  description: 'Electric & Gas', category_id: CAT.NECESSITIES, date: daysAgo(35) },
    { type: 'expense', amount: 55.00,  description: 'Internet - Xfinity', category_id: CAT.NECESSITIES, date: daysAgo(6) },
    { type: 'expense', amount: 55.00,  description: 'Internet - Xfinity', category_id: CAT.NECESSITIES, date: daysAgo(36) },
    { type: 'expense', amount: 45.00,  description: 'Cell Phone - T-Mobile', category_id: CAT.NECESSITIES, date: daysAgo(8) },
    { type: 'expense', amount: 45.00,  description: 'Cell Phone - T-Mobile', category_id: CAT.NECESSITIES, date: daysAgo(38) },
    { type: 'expense', amount: 320.00, description: 'Groceries - Trader Joe\'s', category_id: CAT.NECESSITIES, date: daysAgo(3) },
    { type: 'expense', amount: 285.00, description: 'Groceries - Costco', category_id: CAT.NECESSITIES, date: daysAgo(18) },
    { type: 'expense', amount: 310.00, description: 'Groceries - Whole Foods', category_id: CAT.NECESSITIES, date: daysAgo(33) },
    { type: 'expense', amount: 125.00, description: 'Car Insurance - State Farm', category_id: CAT.NECESSITIES, date: daysAgo(4) },
    { type: 'expense', amount: 125.00, description: 'Car Insurance - State Farm', category_id: CAT.NECESSITIES, date: daysAgo(34) },
    { type: 'expense', amount: 210.00, description: 'Health Insurance Premium', category_id: CAT.NECESSITIES, date: daysAgo(7) },
    { type: 'expense', amount: 45.00,  description: 'Gas - Shell', category_id: CAT.NECESSITIES, date: daysAgo(9) },
    { type: 'expense', amount: 52.00,  description: 'Gas - BP', category_id: CAT.NECESSITIES, date: daysAgo(40) },
    { type: 'expense', amount: 380.00, description: 'Car Payment', category_id: CAT.NECESSITIES, date: daysAgo(14) },
    { type: 'expense', amount: 380.00, description: 'Car Payment', category_id: CAT.NECESSITIES, date: daysAgo(44) },

    // ── EDUCATION ─────────────────────────────────────────────────────────────
    { type: 'expense', amount: 29.00,  description: 'Audible Subscription', category_id: CAT.EDUCATION, date: daysAgo(10) },
    { type: 'expense', amount: 120.00, description: 'Online Course - Udemy', category_id: CAT.EDUCATION, date: daysAgo(22) },
    { type: 'expense', amount: 18.99,  description: 'Books - Amazon', category_id: CAT.EDUCATION, date: daysAgo(28) },
    { type: 'expense', amount: 49.00,  description: 'Masterclass Subscription', category_id: CAT.EDUCATION, date: daysAgo(55) },
    { type: 'expense', amount: 35.00,  description: 'Books - Barnes & Noble', category_id: CAT.EDUCATION, date: daysAgo(70) },
    { type: 'expense', amount: 200.00, description: 'Financial Conference Ticket', category_id: CAT.EDUCATION, date: daysAgo(90) },

    // ── GIVE ──────────────────────────────────────────────────────────────────
    { type: 'expense', amount: 150.00, description: 'Church Tithe', category_id: CAT.GIVE, date: daysAgo(6) },
    { type: 'expense', amount: 150.00, description: 'Church Tithe', category_id: CAT.GIVE, date: daysAgo(36) },
    { type: 'expense', amount: 150.00, description: 'Church Tithe', category_id: CAT.GIVE, date: daysAgo(66) },
    { type: 'expense', amount: 50.00,  description: 'Red Cross Donation', category_id: CAT.GIVE, date: daysAgo(20) },
    { type: 'expense', amount: 75.00,  description: 'Birthday Gift - Family', category_id: CAT.GIVE, date: daysAgo(45) },
    { type: 'expense', amount: 25.00,  description: 'GoFundMe Donation', category_id: CAT.GIVE, date: daysAgo(80) },

    // ── SAVE ──────────────────────────────────────────────────────────────────
    { type: 'expense', amount: 500.00, description: 'High Yield Savings Transfer', category_id: CAT.SAVE, date: daysAgo(5) },
    { type: 'expense', amount: 500.00, description: 'High Yield Savings Transfer', category_id: CAT.SAVE, date: daysAgo(35) },
    { type: 'expense', amount: 500.00, description: 'High Yield Savings Transfer', category_id: CAT.SAVE, date: daysAgo(65) },
    { type: 'expense', amount: 200.00, description: 'Emergency Fund Contribution', category_id: CAT.SAVE, date: daysAgo(15) },
    { type: 'expense', amount: 150.00, description: 'Vacation Fund', category_id: CAT.SAVE, date: daysAgo(42) },

    // ── FUN ───────────────────────────────────────────────────────────────────
    { type: 'expense', amount: 85.00,  description: 'Dinner Out - The Capital Grille', category_id: CAT.FUN, date: daysAgo(3) },
    { type: 'expense', amount: 15.99,  description: 'Netflix Subscription', category_id: CAT.FUN, date: daysAgo(8) },
    { type: 'expense', amount: 15.99,  description: 'Netflix Subscription', category_id: CAT.FUN, date: daysAgo(38) },
    { type: 'expense', amount: 13.99,  description: 'Spotify Premium', category_id: CAT.FUN, date: daysAgo(12) },
    { type: 'expense', amount: 65.00,  description: 'Movie Night + Snacks', category_id: CAT.FUN, date: daysAgo(19) },
    { type: 'expense', amount: 110.00, description: 'Hiking Gear - REI', category_id: CAT.FUN, date: daysAgo(50) },
    { type: 'expense', amount: 220.00, description: 'Weekend Trip - Hotel', category_id: CAT.FUN, date: daysAgo(75) },
    { type: 'expense', amount: 45.00,  description: 'Golf - Green Fees', category_id: CAT.FUN, date: daysAgo(25) },

    // ── FINANCIAL FREEDOM ─────────────────────────────────────────────────────
    { type: 'expense', amount: 550.00, description: '401(k) Contribution', category_id: CAT.FINANCIAL_FREEDOM, date: daysAgo(2) },
    { type: 'expense', amount: 550.00, description: '401(k) Contribution', category_id: CAT.FINANCIAL_FREEDOM, date: daysAgo(17) },
    { type: 'expense', amount: 550.00, description: '401(k) Contribution', category_id: CAT.FINANCIAL_FREEDOM, date: daysAgo(32) },
    { type: 'expense', amount: 500.00, description: 'Roth IRA - Fidelity', category_id: CAT.FINANCIAL_FREEDOM, date: daysAgo(10) },
    { type: 'expense', amount: 500.00, description: 'Roth IRA - Fidelity', category_id: CAT.FINANCIAL_FREEDOM, date: daysAgo(40) },
    { type: 'expense', amount: 200.00, description: 'Brokerage - VTSAX Buy', category_id: CAT.FINANCIAL_FREEDOM, date: daysAgo(22) },
    { type: 'expense', amount: 200.00, description: 'Brokerage - VTSAX Buy', category_id: CAT.FINANCIAL_FREEDOM, date: daysAgo(52) },
  ];

  for (const t of txns) {
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [userId, t.type, t.amount, t.description, t.category_id, t.date]
    );
  }
}

async function seedBills(client, userId) {
  console.log('  → Seeding recurring bills...');
  const bills = [
    { name: 'Rent', amount: 1750.00, due_day: 1,  frequency: 'monthly', category_id: CAT.NECESSITIES, is_paid: true },
    { name: 'Electric & Gas - ConEd', amount: 95.00, due_day: 8, frequency: 'monthly', category_id: CAT.NECESSITIES, is_paid: false },
    { name: 'Internet - Xfinity', amount: 55.00, due_day: 15, frequency: 'monthly', category_id: CAT.NECESSITIES, is_paid: true },
    { name: 'Cell Phone - T-Mobile', amount: 45.00, due_day: 12, frequency: 'monthly', category_id: CAT.NECESSITIES, is_paid: false },
    { name: 'Car Insurance - State Farm', amount: 125.00, due_day: 5, frequency: 'monthly', category_id: CAT.NECESSITIES, is_paid: true },
    { name: 'Health Insurance Premium', amount: 210.00, due_day: 1, frequency: 'monthly', category_id: CAT.NECESSITIES, is_paid: true },
    { name: 'Renter\'s Insurance - Lemonade', amount: 18.00, due_day: 20, frequency: 'monthly', category_id: CAT.NECESSITIES, is_paid: false },
    { name: 'Netflix', amount: 15.99, due_day: 18, frequency: 'monthly', category_id: CAT.FUN, is_paid: true },
    { name: 'Spotify Premium', amount: 13.99, due_day: 22, frequency: 'monthly', category_id: CAT.FUN, is_paid: false },
    { name: 'Gym Membership - Planet Fitness', amount: 24.99, due_day: 10, frequency: 'monthly', category_id: CAT.FUN, is_paid: true },
  ];

  for (const b of bills) {
    await client.query(
      `INSERT INTO recurring_bills (user_id, name, amount, due_day, frequency, category_id, is_paid, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
      [userId, b.name, b.amount, b.due_day, b.frequency, b.category_id, b.is_paid]
    );
  }
}

async function seedDebts(client, userId) {
  console.log('  → Seeding debts...');
  const debts = [
    {
      name: 'Chase Sapphire Preferred',
      balance: 4250.00,
      interest_rate: 24.99,
      minimum_payment: 85.00,
      current_payment: 200.00,
      notes: 'Reward card - paying down aggressively',
    },
    {
      name: 'Discover Card',
      balance: 1890.00,
      interest_rate: 21.99,
      minimum_payment: 38.00,
      current_payment: 150.00,
      notes: 'Snowball target - smallest balance first',
    },
    {
      name: 'Student Loan - Sallie Mae',
      balance: 18500.00,
      interest_rate: 5.80,
      minimum_payment: 195.00,
      current_payment: 195.00,
      notes: 'Federal loan, income-driven repayment',
    },
    {
      name: 'Medical Bill - Hospital',
      balance: 620.00,
      interest_rate: 0.00,
      minimum_payment: 50.00,
      current_payment: 100.00,
      notes: 'Payment plan, 0% interest',
    },
  ];

  for (const d of debts) {
    await client.query(
      `INSERT INTO debts (user_id, name, balance, interest_rate, minimum_payment, current_payment, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
      [userId, d.name, d.balance, d.interest_rate, d.minimum_payment, d.current_payment, d.notes]
    );
  }
}

async function seedLoans(client, userId) {
  console.log('  → Seeding loans...');
  const loans = [
    {
      name: 'Toyota Camry Auto Loan',
      institution: 'Toyota Financial Services',
      loan_type: 'auto',
      original_amount: 28000.00,
      current_balance: 19450.00,
      interest_rate: 4.90,
      monthly_payment: 380.00,
      start_date: monthsAgo(18),
      payoff_date: '2030-03-01',
      notes: '48-month loan, on track',
    },
    {
      name: 'Student Loan - Federal Direct',
      institution: 'Dept. of Education - FedLoan',
      loan_type: 'student',
      original_amount: 35000.00,
      current_balance: 22750.00,
      interest_rate: 4.50,
      monthly_payment: 320.00,
      start_date: monthsAgo(48),
      payoff_date: '2033-06-01',
      notes: 'Standard repayment plan',
    },
  ];

  for (const l of loans) {
    await client.query(
      `INSERT INTO loans (user_id, name, institution, loan_type, original_amount, current_balance, interest_rate, monthly_payment, start_date, payoff_date, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
      [userId, l.name, l.institution, l.loan_type, l.original_amount, l.current_balance,
       l.interest_rate, l.monthly_payment, l.start_date, l.payoff_date, l.notes]
    );
  }
}

async function seedCreditCards(client, userId) {
  console.log('  → Seeding credit cards...');
  const cards = [
    {
      name: 'Chase Sapphire Preferred',
      institution: 'Chase',
      credit_limit: 10000.00,
      current_balance: 4250.00,
      apr: 24.99,
      due_date_day: 22,
      notes: 'Points card for travel rewards',
    },
    {
      name: 'Discover it Cash Back',
      institution: 'Discover',
      credit_limit: 5000.00,
      current_balance: 1890.00,
      apr: 21.99,
      due_date_day: 15,
      notes: '5% rotating categories',
    },
  ];

  for (const c of cards) {
    await client.query(
      `INSERT INTO credit_cards (user_id, name, institution, credit_limit, current_balance, apr, due_date_day, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [userId, c.name, c.institution, c.credit_limit, c.current_balance, c.apr, c.due_date_day, c.notes]
    );
  }
}

async function seedBankAccounts(client, userId) {
  console.log('  → Seeding bank accounts...');
  const accounts = [
    {
      name: 'Checking - Chase Total',
      institution_name: 'Chase Bank',
      account_type: 'checking',
      starting_balance: 3200.00,
      current_balance: 3200.00,
      notes: 'Primary checking account',
    },
    {
      name: 'High-Yield Savings - Ally',
      institution_name: 'Ally Bank',
      account_type: 'savings',
      starting_balance: 12500.00,
      current_balance: 12500.00,
      notes: '4.50% APY — Emergency fund + goals',
    },
    {
      name: 'Credit Union Savings',
      institution_name: 'Navy Federal CU',
      account_type: 'savings',
      starting_balance: 2800.00,
      current_balance: 2800.00,
      notes: 'Vacation & car maintenance fund',
    },
  ];

  for (const a of accounts) {
    await client.query(
      `INSERT INTO bank_accounts (user_id, name, institution_name, account_type, starting_balance, current_balance, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
      [userId, a.name, a.institution_name, a.account_type, a.starting_balance, a.current_balance, a.notes]
    );
  }
}

async function seedGiftCards(client, userId) {
  console.log('  → Seeding gift cards...');
  const cards = [
    {
      name: 'Amazon',
      initial_balance: 100.00,
      current_balance: 67.43,
      notes: 'Birthday gift from mom',
    },
    {
      name: 'Starbucks',
      initial_balance: 50.00,
      current_balance: 22.75,
      notes: 'Holiday gift card',
    },
    {
      name: 'Target',
      initial_balance: 75.00,
      current_balance: 75.00,
      notes: 'Unused — received last week',
    },
  ];

  for (const g of cards) {
    const result = await client.query(
      `INSERT INTO gift_cards (user_id, name, initial_balance, current_balance, notes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id`,
      [userId, g.name, g.initial_balance, g.current_balance, g.notes]
    );
    const gcId = result.rows[0].id;

    // Add a spend transaction for non-full cards
    if (g.current_balance < g.initial_balance) {
      const spent = (g.initial_balance - g.current_balance).toFixed(2);
      await client.query(
        `INSERT INTO gift_card_transactions (gift_card_id, user_id, amount, description, transaction_date, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [gcId, userId, parseFloat(spent), `Spent at ${g.name}`, daysAgo(15)]
      );
    }
  }
}

async function seedPortfolio(client, userId) {
  console.log('  → Seeding portfolio accounts & transactions...');

  // Create accounts
  const accounts = [
    { account_type: 'brokerage', display_name: 'Fidelity Brokerage', starting_value: 8500.00, starting_date: monthsAgo(24) },
    { account_type: 'roth_ira', display_name: 'Fidelity Roth IRA', starting_value: 15000.00, starting_date: monthsAgo(36) },
    { account_type: 'ira', display_name: '401(k) - Employer Plan', starting_value: 42000.00, starting_date: monthsAgo(48) },
  ];

  const accountIds = {};
  for (const a of accounts) {
    const result = await client.query(
      `INSERT INTO portfolio_accounts (user_id, account_type, display_name, starting_value, starting_date, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id`,
      [userId, a.account_type, a.display_name, a.starting_value, a.starting_date]
    );
    accountIds[a.account_type] = result.rows[0].id;
  }

  // Portfolio transactions (buys across all accounts)
  const txns = [
    // Brokerage
    { account_type: 'brokerage', ticker: 'VTSAX', type: 'buy', shares: 15.5, price: 115.00, date: monthsAgo(12) },
    { account_type: 'brokerage', ticker: 'VTSAX', type: 'buy', shares: 3.2,  price: 118.50, date: monthsAgo(6) },
    { account_type: 'brokerage', ticker: 'VTSAX', type: 'buy', shares: 1.7,  price: 122.00, date: monthsAgo(2) },
    { account_type: 'brokerage', ticker: 'VOO',   type: 'buy', shares: 5.0,  price: 445.00, date: monthsAgo(8) },
    { account_type: 'brokerage', ticker: 'AAPL',  type: 'buy', shares: 10.0, price: 175.00, date: monthsAgo(10) },
    { account_type: 'brokerage', ticker: 'AAPL',  type: 'buy', shares: 5.0,  price: 188.00, date: monthsAgo(3) },
    // Roth IRA
    { account_type: 'roth_ira', ticker: 'FXAIX', type: 'buy', shares: 20.0, price: 195.00, date: monthsAgo(30) },
    { account_type: 'roth_ira', ticker: 'FXAIX', type: 'buy', shares: 8.5,  price: 205.00, date: monthsAgo(18) },
    { account_type: 'roth_ira', ticker: 'FXAIX', type: 'buy', shares: 4.8,  price: 215.00, date: monthsAgo(6) },
    { account_type: 'roth_ira', ticker: 'VTIAX', type: 'buy', shares: 25.0, price: 32.00,  date: monthsAgo(24) },
    { account_type: 'roth_ira', ticker: 'VTIAX', type: 'buy', shares: 10.0, price: 33.50,  date: monthsAgo(12) },
    // 401k
    { account_type: 'ira', ticker: 'VIIIX', type: 'buy', shares: 50.0, price: 380.00, date: monthsAgo(48) },
    { account_type: 'ira', ticker: 'VIIIX', type: 'buy', shares: 25.0, price: 405.00, date: monthsAgo(36) },
    { account_type: 'ira', ticker: 'VIIIX', type: 'buy', shares: 20.0, price: 420.00, date: monthsAgo(24) },
    { account_type: 'ira', ticker: 'VIIIX', type: 'buy', shares: 15.0, price: 435.00, date: monthsAgo(12) },
    { account_type: 'ira', ticker: 'VIIIX', type: 'buy', shares: 8.0,  price: 450.00, date: monthsAgo(3) },
    { account_type: 'ira', ticker: 'VBTLX', type: 'buy', shares: 30.0, price: 12.00,  date: monthsAgo(36) },
    { account_type: 'ira', ticker: 'VBTLX', type: 'buy', shares: 20.0, price: 11.50,  date: monthsAgo(18) },
  ];

  for (const t of txns) {
    const accountId = accountIds[t.account_type];
    if (!accountId) continue;
    const amount = t.shares * t.price;
    await client.query(
      `INSERT INTO portfolio_transactions (user_id, account_id, ticker, transaction_type, shares, price_per_share, amount, transaction_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      [userId, accountId, t.ticker, t.type, t.shares, t.price, amount, t.date]
    );
  }
}

async function seedNetWorth(client, userId) {
  console.log('  → Seeding net worth entries...');
  const entries = [
    // Assets
    { type: 'asset', name: 'Checking Account - Chase', value: 3200.00, category: 'cash' },
    { type: 'asset', name: 'High-Yield Savings - Ally', value: 12500.00, category: 'cash' },
    { type: 'asset', name: 'Credit Union Savings', value: 2800.00, category: 'cash' },
    { type: 'asset', name: '401(k) - Employer Plan', value: 62400.00, category: 'investment' },
    { type: 'asset', name: 'Roth IRA - Fidelity', value: 19800.00, category: 'investment' },
    { type: 'asset', name: 'Brokerage - Fidelity', value: 11250.00, category: 'investment' },
    { type: 'asset', name: 'Toyota Camry 2021', value: 22000.00, category: 'vehicle' },
    // Liabilities
    { type: 'debt', name: 'Auto Loan - Toyota Financial', value: 19450.00, category: 'loan', interest_rate: 4.90 },
    { type: 'debt', name: 'Student Loan - Federal Direct', value: 22750.00, category: 'loan', interest_rate: 4.50 },
    { type: 'debt', name: 'Student Loan - Sallie Mae', value: 18500.00, category: 'loan', interest_rate: 5.80 },
    { type: 'debt', name: 'Chase Sapphire Balance', value: 4250.00, category: 'credit_card', interest_rate: 24.99 },
    { type: 'debt', name: 'Discover Card Balance', value: 1890.00, category: 'credit_card', interest_rate: 21.99 },
    { type: 'debt', name: 'Medical Bill', value: 620.00, category: 'other' },
  ];

  for (const e of entries) {
    await client.query(
      `INSERT INTO net_worth_entries (user_id, type, name, value, category, interest_rate, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
      [userId, e.type, e.name, e.value, e.category || 'other', e.interest_rate || null]
    );
  }

  // Also seed a net worth snapshot for history
  const totalAssets = entries.filter(e => e.type === 'asset').reduce((s, e) => s + e.value, 0);
  const totalLiabilities = entries.filter(e => e.type === 'liability').reduce((s, e) => s + e.value, 0);
  const netWorth = totalAssets - totalLiabilities;

  // Seed historical snapshots (last 6 months)
  const snapshots = [
    { months: 5, assets: 109200, liabilities: 70000 },
    { months: 4, assets: 112500, liabilities: 69100 },
    { months: 3, assets: 118000, liabilities: 68200 },
    { months: 2, assets: 122400, liabilities: 67400 },
    { months: 1, assets: 128800, liabilities: 66800 },
    { months: 0, assets: totalAssets, liabilities: totalLiabilities },
  ];

  for (const s of snapshots) {
    try {
      await client.query(
        `INSERT INTO net_worth_snapshots (user_id, total_assets, total_debts, net_worth, snapshot_date, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [userId, s.assets, s.liabilities, s.assets - s.liabilities, monthsAgo(s.months)]
      );
    } catch (e) {
      // Skip if table structure differs
    }
  }
}

async function seedFiCalculator(client, userId) {
  console.log('  → Seeding FI Calculator...');
  await client.query(
    `INSERT INTO financial_freedom (user_id, current_age, target_freedom_age, monthly_expenses, current_savings, monthly_savings_rate, expected_return_rate, inflation_rate, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       current_age = $2, target_freedom_age = $3, monthly_expenses = $4,
       current_savings = $5, monthly_savings_rate = $6,
       expected_return_rate = $7, inflation_rate = $8, updated_at = NOW()`,
    [userId, 32, 52, 4800.00, 95950.00, 2250.00, 7.0, 3.0]
  );
  // current_savings = sum of investment accounts (brokerage + roth + 401k) + savings
}

async function main() {
  console.log('\n🧪 SANDBOX SEED SCRIPT');
  console.log('═══════════════════════════════════════');
  console.log(`Email:    ${SANDBOX_EMAIL}`);
  if (GENERATED_SANDBOX_PASSWORD) {
    console.log(`Password: ${SANDBOX_PASSWORD} (generated — store in password manager; set SANDBOX_PASSWORD to pin)`);
  } else {
    console.log('Password: (from SANDBOX_PASSWORD / BETA_SEED_PASSWORD env)');
  }
  console.log('');

  const client = await pool.connect();

  try {
    // ── Step 1: Create or update sandbox user ─────────────────────────────────
    console.log('Step 1: Creating sandbox user...');
    const passwordHash = await bcrypt.hash(SANDBOX_PASSWORD, 10);

    const existing = await client.query(
      'SELECT id FROM users WHERE LOWER(email) = $1',
      [SANDBOX_EMAIL.toLowerCase()]
    );

    let userId;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      await client.query(
        `UPDATE users SET name = $2, password_hash = $3, plan = 'paid', paid_until = '2099-12-31', is_creator = true, updated_at = NOW() WHERE id = $1`,
        [userId, SANDBOX_NAME, passwordHash]
      );
      console.log(`  ✓ Updated existing sandbox user (id=${userId})`);
    } else {
      const refCode = await generateReferralCode(client);
      const result = await client.query(
        `INSERT INTO users (email, name, password_hash, plan, paid_until, is_creator, referral_code, created_at, updated_at)
         VALUES ($1, $2, $3, 'paid', '2099-12-31', true, $4, NOW(), NOW())
         RETURNING id`,
        [SANDBOX_EMAIL, SANDBOX_NAME, passwordHash, refCode]
      );
      userId = result.rows[0].id;
      console.log(`  ✓ Created sandbox user (id=${userId})`);
    }

    // ── Step 2: Clear old data ─────────────────────────────────────────────────
    console.log('Step 2: Clearing old sandbox data...');
    await clearSandboxData(client, userId);

    // ── Step 3: Populate all sections (each wrapped — one failure won't stop others) ──
    console.log('Step 3: Populating all sections...');
    const sections = [
      ['allocations',   () => seedAllocations(client, userId)],
      ['transactions',  () => seedTransactions(client, userId)],
      ['bills',         () => seedBills(client, userId)],
      ['debts',         () => seedDebts(client, userId)],
      ['loans',         () => seedLoans(client, userId)],
      ['credit cards',  () => seedCreditCards(client, userId)],
      ['bank accounts', () => seedBankAccounts(client, userId)],
      ['gift cards',    () => seedGiftCards(client, userId)],
      ['portfolio',     () => seedPortfolio(client, userId)],
      ['net worth',     () => seedNetWorth(client, userId)],
      ['FI calculator', () => seedFiCalculator(client, userId)],
    ];

    const errors = [];
    for (const [name, fn] of sections) {
      try {
        await fn();
      } catch (sectionErr) {
        console.warn(`  ⚠ ${name} seed warning: ${sectionErr.message}`);
        errors.push({ name, error: sectionErr.message });
      }
    }

    console.log('');
    if (errors.length === 0) {
      console.log('✅ SANDBOX SEED COMPLETE — all sections seeded');
    } else {
      console.log(`⚠ SANDBOX SEED PARTIAL — ${errors.length} section(s) had warnings:`);
      errors.forEach(e => console.log(`    - ${e.name}: ${e.error}`));
    }
    console.log('═══════════════════════════════════════');
    console.log(`  Sandbox user ID : ${userId}`);
    console.log(`  Email           : ${SANDBOX_EMAIL}`);
    if (GENERATED_SANDBOX_PASSWORD) {
      console.log(`  Password        : ${SANDBOX_PASSWORD} (generated this run)`);
    } else {
      console.log('  Password        : (from env — not printed)');
    }
    console.log(`  Plan            : Pro (permanent via is_creator=true)`);
    console.log('');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  // IMPORTANT: Never exit(1) — seed failures must not block deploys.
  // The app will still start; sandbox data may be incomplete but the site stays up.
  console.error('⚠ Sandbox seed encountered an error (non-fatal):', err.message);
  console.error(err.stack);
  process.exit(0);
});
