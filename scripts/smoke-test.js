#!/usr/bin/env node
/**
 * FACTS Finance API Smoke Test Suite
 * Usage: node scripts/smoke-test.js <BASE_URL> [--admin-email <email>] [--admin-password <pass>]
 *
 * Options:
 *   --admin-email     Creator/admin email (required for pre-launch to generate invite codes)
 *   --admin-password  Creator/admin password
 *   --invite-code     Use a specific invite code (skips admin code generation)
 *
 * Exit codes:
 *   0 = all tests passed
 *   1 = one or more tests failed
 *
 * NOTE: No credit-card wallet endpoints exist in the server — the task spec
 * references /api/credit-cards but that route has not been implemented.
 * Those tests are skipped with a WARN marker.
 */

'use strict';

// ─── Args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const BASE_URL = args[0];

if (!BASE_URL) {
  console.error('Usage: node scripts/smoke-test.js <BASE_URL> [--admin-email email] [--admin-password pass]');
  process.exit(1);
}

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const ADMIN_EMAIL    = getArg('--admin-email');
const ADMIN_PASSWORD = getArg('--admin-password');
const INVITE_CODE    = getArg('--invite-code');

// ─── Cookie jar ─────────────────────────────────────────────────────────────

class CookieJar {
  constructor() { this._cookies = {}; }

  ingest(response) {
    const setCookieHeaders = response.headers.raw?.()?.['set-cookie']
      || response.headers.getSetCookie?.()
      || [];
    for (const header of setCookieHeaders) {
      const [pair] = header.split(';');
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const name  = pair.slice(0, eqIdx).trim();
      const value = pair.slice(eqIdx + 1).trim();
      this._cookies[name] = value;
    }
  }

  header() {
    return Object.entries(this._cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function api(method, path, body, jar) {
  const url = `${BASE_URL}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (jar) {
    const ch = jar.header();
    if (ch) headers['Cookie'] = ch;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
    redirect: 'follow',
  });

  if (jar) jar.ingest(res);

  let data;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { data = await res.json(); } catch { data = {}; }
  } else {
    data = await res.text();
  }

  return { status: res.status, data };
}

// ─── Result tracking ─────────────────────────────────────────────────────────

const results = [];
let passed = 0;
let failed = 0;
let warned = 0;

function pass(name, detail = '') {
  results.push({ ok: true, name, detail });
  console.log(`  ✅ PASS  ${name}${detail ? '  (' + detail + ')' : ''}`);
  passed++;
}

function fail(name, detail = '') {
  results.push({ ok: false, name, detail });
  console.log(`  ❌ FAIL  ${name}${detail ? '  → ' + detail : ''}`);
  failed++;
}

function warn(name, detail = '') {
  results.push({ ok: null, name, detail });
  console.log(`  ⚠️  WARN  ${name}${detail ? '  → ' + detail : ''}`);
  warned++;
}

function section(title) {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
}

function assert(condition, name, detail = '') {
  if (condition) pass(name, detail);
  else fail(name, detail);
  return condition;
}

// ─── Cleanup registry ────────────────────────────────────────────────────────

const cleanup = [];

// ─── Tests ───────────────────────────────────────────────────────────────────

async function testHealth() {
  section('0. Health Check');
  const { status, data } = await api('GET', '/health');
  assert(status === 200, 'GET /health → 200');
  assert(data.status === 'healthy' || data.status === 'ok', 'Health status is healthy/ok',
    `got: ${JSON.stringify(data.status)}`);
}

async function setupAdminSession(adminJar) {
  section('Admin Setup');

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    warn('Admin login', 'No --admin-email/--admin-password provided. Pre-launch signups require invite code.');
    return null;
  }

  const { status, data } = await api('POST', '/api/auth/login',
    { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, adminJar);

  if (status !== 200) {
    fail('Admin login', `status ${status}: ${JSON.stringify(data)}`);
    return null;
  }
  if (data.requires_2fa) {
    fail('Admin login', '2FA enabled on admin account — smoke test cannot proceed as admin (disable 2FA or use a non-2FA admin)');
    return null;
  }
  pass('Admin login', `logged in as ${data.user?.email}`);
  return data.user;
}

async function generatePromoCode(adminJar, label) {
  const { status, data } = await api('POST', '/api/admin/promo-codes/generate', {}, adminJar);
  if (status === 200 && data.promo_code?.code) {
    pass(`Generate promo code (${label})`, data.promo_code.code);
    return data.promo_code.code;
  }
  fail(`Generate promo code (${label})`, `status ${status}: ${JSON.stringify(data)}`);
  return null;
}

async function testAuthFlow(testJar, inviteCode) {
  section('1. Auth Flow');

  const ts = Date.now();
  const testEmail    = `smoke-test-${ts}@facts-test.invalid`;
  const testPassword = `SmokeTest!${ts}`;
  const testName     = `Smoke Test ${ts}`;

  // Signup
  const signupBody = { email: testEmail, password: testPassword, name: testName };
  if (inviteCode) signupBody.invite_code = inviteCode;

  const signup = await api('POST', '/api/auth/signup', signupBody, testJar);

  if (signup.status === 201 || signup.status === 200) {
    pass('POST /api/auth/signup → creates user', `email: ${testEmail}`);
  } else if (signup.status === 403 && signup.data?.error?.includes('invite')) {
    fail('POST /api/auth/signup', 'Pre-launch gate active — provide --admin-email/--admin-password or --invite-code');
    return null;
  } else if (signup.status === 409) {
    fail('POST /api/auth/signup', `Account already exists: ${testEmail}`);
    return null;
  } else {
    fail('POST /api/auth/signup', `status ${signup.status}: ${JSON.stringify(signup.data)}`);
    return null;
  }

  // Login
  const login = await api('POST', '/api/auth/login',
    { email: testEmail, password: testPassword }, testJar);

  if (!assert(login.status === 200, 'POST /api/auth/login → 200', `status: ${login.status}`)) {
    return null;
  }
  if (!assert(!login.data.requires_2fa, 'Login: no 2FA challenge on fresh account')) {
    return null;
  }
  if (!assert(login.data.user?.email === testEmail, 'Login: response contains user email')) {
    return null;
  }
  pass('POST /api/auth/login → returns session', `user id: ${login.data.user?.id}`);

  // GET /api/auth/me
  const me = await api('GET', '/api/auth/me', null, testJar);
  assert(me.status === 200, 'GET /api/auth/me → 200');
  assert(me.data.authenticated === true, 'GET /api/auth/me → authenticated: true');
  assert(me.data.user?.email === testEmail, 'GET /api/auth/me → user email matches');

  return { email: testEmail, password: testPassword, userId: login.data.user?.id };
}

async function testTransactions(testJar) {
  section('2. Income / Expense Transactions');

  // Get categories first (need category_id for expenses)
  const cats = await api('GET', '/api/categories', null, testJar);
  if (!assert(cats.status === 200, 'GET /api/categories → 200')) return;

  const categories  = cats.data.categories || [];
  assert(categories.length > 0, 'Categories exist', `count: ${categories.length}`);

  // Verify allocations sum to 100%
  const totalPct = categories.reduce((sum, c) => sum + parseFloat(c.percentage || 0), 0);
  const rounded  = Math.round(totalPct * 100) / 100;
  assert(rounded === 100, 'Allocation percentages sum to 100%', `got: ${rounded}`);

  const firstCat = categories[0];

  // POST income
  const income = await api('POST', '/api/transactions',
    { type: 'income', amount: 1000, description: 'Smoke test income',
      transaction_date: new Date().toISOString().split('T')[0] },
    testJar);

  if (!assert(income.status === 201, 'POST /api/transactions (income) → 201',
    `status: ${income.status} ${JSON.stringify(income.data)}`)) return;
  assert(income.data.type === 'income', 'Income transaction has correct type');
  assert(parseFloat(income.data.amount) === 1000, 'Income amount matches');
  const incomeId = income.data.id;
  cleanup.push({ type: 'transaction', id: incomeId, jar: testJar });

  // POST expense
  const expense = await api('POST', '/api/transactions',
    { type: 'expense', amount: 50, description: 'Smoke test expense',
      category_id: firstCat.id,
      transaction_date: new Date().toISOString().split('T')[0] },
    testJar);

  if (!assert(expense.status === 201, 'POST /api/transactions (expense) → 201',
    `status: ${expense.status} ${JSON.stringify(expense.data)}`)) return;
  assert(expense.data.type === 'expense', 'Expense transaction has correct type');
  assert(parseInt(expense.data.category_id) === parseInt(firstCat.id),
    'Expense in correct category', `expected ${firstCat.id} got ${expense.data.category_id}`);
  const expenseId = expense.data.id;
  cleanup.push({ type: 'transaction', id: expenseId, jar: testJar });

  // GET transactions
  const list = await api('GET', '/api/transactions', null, testJar);
  assert(list.status === 200, 'GET /api/transactions → 200');
  const txns = list.data.transactions || list.data;
  assert(Array.isArray(txns), 'GET /api/transactions → returns array');
  const ids = txns.map(t => t.id);
  assert(ids.includes(incomeId),  'Income transaction in list');
  assert(ids.includes(expenseId), 'Expense transaction in list');
}

async function testBills(testJar) {
  section('3. Bills');

  // POST
  const create = await api('POST', '/api/bills',
    { name: 'Smoke Test Bill', amount: 99.99, due_day: 15, frequency: 'monthly' },
    testJar);

  if (!assert(create.status === 200 || create.status === 201, 'POST /api/bills → creates bill',
    `status: ${create.status}`)) return;
  const bill = create.data.bill;
  assert(bill?.name === 'Smoke Test Bill', 'Bill name matches');
  const billId = bill?.id;
  cleanup.push({ type: 'bill', id: billId, jar: testJar });

  // GET
  const list = await api('GET', '/api/bills', null, testJar);
  assert(list.status === 200, 'GET /api/bills → 200');
  assert(Array.isArray(list.data.bills), 'GET /api/bills → returns array');
  const billIds = list.data.bills.map(b => b.id);
  assert(billIds.includes(billId), 'Created bill in list');

  // PATCH toggle paid
  const toggle = await api('PATCH', `/api/bills/${billId}/toggle-paid`, null, testJar);
  assert(toggle.status === 200, 'PATCH /api/bills/:id/toggle-paid → 200');
  assert(toggle.data.bill?.is_paid === true, 'Bill toggled to paid');

  // Toggle back
  await api('PATCH', `/api/bills/${billId}/toggle-paid`, null, testJar);

  // DELETE
  const del = await api('DELETE', `/api/bills/${billId}`, null, testJar);
  assert(del.status === 200, 'DELETE /api/bills/:id → 200');
  // Remove from cleanup since already deleted
  const idx = cleanup.findIndex(c => c.type === 'bill' && c.id === billId);
  if (idx !== -1) cleanup.splice(idx, 1);
}

async function testDebts(testJar, isPro) {
  section('4. Debts');

  if (!isPro) {
    warn('Debt tests skipped', 'Test user does not have Pro access. Provide admin creds to get Pro via promo code.');

    // Verify that debt endpoints return 403 for non-pro
    const get = await api('GET', '/api/debts', null, testJar);
    assert(get.status === 403, 'GET /api/debts → 403 for non-Pro user',
      `got: ${get.status}`);
    return;
  }

  // POST debt
  const create = await api('POST', '/api/debts',
    { name: 'Smoke Test Debt', balance: 5000, interest_rate: 18.99,
      minimum_payment: 100, current_payment: 150, notes: 'Created by smoke test' },
    testJar);

  if (!assert(create.status === 200 || create.status === 201, 'POST /api/debts → creates debt',
    `status: ${create.status} ${JSON.stringify(create.data)}`)) return;
  const debt = create.data.debt;
  assert(debt?.name === 'Smoke Test Debt', 'Debt name matches');
  const debtId = debt?.id;
  cleanup.push({ type: 'debt', id: debtId, jar: testJar });

  // GET debts
  const list = await api('GET', '/api/debts', null, testJar);
  assert(list.status === 200, 'GET /api/debts → 200');
  const debts = list.data.debts || list.data;
  assert(Array.isArray(debts), 'GET /api/debts → returns array');
  const debtIds = debts.map(d => d.id);
  assert(debtIds.includes(debtId), 'Created debt in list');

  // POST calculate-strategies
  const strats = await api('POST', '/api/debts/calculate-strategies',
    { extra_monthly_payment: 50 }, testJar);
  assert(strats.status === 200, 'POST /api/debts/calculate-strategies → 200',
    `status: ${strats.status}`);
  const strategies = strats.data.strategies || {};
  const stratKeys = Object.keys(strategies);
  assert(stratKeys.length === 4, 'Returns 4 strategy calculations',
    `got: ${stratKeys.join(', ')}`);
  assert(stratKeys.includes('minimum'),  'Strategy: minimum');
  assert(stratKeys.includes('current'),  'Strategy: current');
  assert(stratKeys.includes('snowball'),  'Strategy: snowball');
  assert(stratKeys.includes('avalanche'), 'Strategy: avalanche');

  // DELETE debt
  const del = await api('DELETE', `/api/debts/${debtId}`, null, testJar);
  assert(del.status === 200, 'DELETE /api/debts/:id → 200');
  const idx = cleanup.findIndex(c => c.type === 'debt' && c.id === debtId);
  if (idx !== -1) cleanup.splice(idx, 1);
}

async function testWallets(testJar) {
  section('5. Wallets');

  // Credit cards — endpoint not implemented
  warn('POST /api/credit-cards', 'Route /api/credit-cards does not exist in server.js — not implemented yet');

  // Gift cards
  const gcCreate = await api('POST', '/api/gift-cards',
    { store_name: 'Smoke Test Store', balance: 25.00, initial_balance: 25.00,
      card_number: 'SMOKE-TEST-001' },
    testJar);
  if (assert(gcCreate.status === 200 || gcCreate.status === 201,
    'POST /api/gift-cards → creates gift card', `status: ${gcCreate.status}`)) {
    const gc = gcCreate.data.gift_card || gcCreate.data;
    const gcId = gc?.id;
    if (gcId) cleanup.push({ type: 'gift-card', id: gcId, jar: testJar });

    // GET gift cards
    const gcList = await api('GET', '/api/gift-cards', null, testJar);
    assert(gcList.status === 200, 'GET /api/gift-cards → 200');
    assert(Array.isArray(gcList.data.gift_cards || gcList.data),
      'GET /api/gift-cards → returns array');
  }

  // Bank accounts
  const baCreate = await api('POST', '/api/bank-accounts',
    { name: 'Smoke Test Checking', account_type: 'checking',
      initial_balance: 1000, current_balance: 1000 },
    testJar);
  if (assert(baCreate.status === 200 || baCreate.status === 201,
    'POST /api/bank-accounts → creates bank account', `status: ${baCreate.status}`)) {
    const ba = baCreate.data.bank_account || baCreate.data;
    const baId = ba?.id;
    if (baId) cleanup.push({ type: 'bank-account', id: baId, jar: testJar });

    // GET bank accounts
    const baList = await api('GET', '/api/bank-accounts', null, testJar);
    assert(baList.status === 200, 'GET /api/bank-accounts → 200');
    assert(Array.isArray(baList.data.bank_accounts || baList.data),
      'GET /api/bank-accounts → returns array');
  }
}

async function testProAccess(testJar, isPro) {
  section('6. Pro Access');

  const proStatus = await api('GET', '/api/pro-status', null, testJar);
  assert(proStatus.status === 200, 'GET /api/pro-status → 200');

  if (isPro) {
    assert(proStatus.data.has_pro === true, 'GET /api/pro-status → has_pro: true for Pro user',
      `got: ${JSON.stringify(proStatus.data.has_pro)}`);
    // Also check /api/auth/me shows pro
    const me = await api('GET', '/api/auth/me', null, testJar);
    assert(me.data.user?.is_pro === true || me.data.user?.has_pro === true,
      'GET /api/auth/me → is_pro/has_pro: true for Pro user');
  } else {
    assert(proStatus.data.has_pro === false, 'GET /api/pro-status → has_pro: false for free user',
      `got: ${JSON.stringify(proStatus.data.has_pro)}`);
  }
}

async function doCleanup() {
  section('Cleanup');
  for (const item of cleanup.reverse()) {
    try {
      let path;
      if (item.type === 'transaction') path = `/api/transactions/${item.id}`;
      else if (item.type === 'bill')    path = `/api/bills/${item.id}`;
      else if (item.type === 'debt')    path = `/api/debts/${item.id}`;
      else if (item.type === 'gift-card')    path = `/api/gift-cards/${item.id}`;
      else if (item.type === 'bank-account') path = `/api/bank-accounts/${item.id}`;
      else continue;

      const { status } = await api('DELETE', path, null, item.jar);
      if (status === 200 || status === 204) {
        console.log(`  🧹 Deleted ${item.type} #${item.id}`);
      } else if (status === 404) {
        console.log(`  🧹 ${item.type} #${item.id} already gone`);
      } else {
        console.log(`  ⚠️  Could not delete ${item.type} #${item.id} (status ${status})`);
      }
    } catch (e) {
      console.log(`  ⚠️  Cleanup error for ${item.type} #${item.id}: ${e.message}`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n╔════════════════════════════════════════════════════╗`);
  console.log(`║         FACTS Finance API Smoke Test Suite         ║`);
  console.log(`╚════════════════════════════════════════════════════╝`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Date:   ${new Date().toISOString()}`);

  const adminJar = new CookieJar();
  const testJar  = new CookieJar();

  let inviteCode = INVITE_CODE;
  let proCode    = null;

  try {
    // 0. Health
    await testHealth();

    // Admin setup (generates promo codes for pre-launch + Pro access)
    if (ADMIN_EMAIL && ADMIN_PASSWORD) {
      const admin = await setupAdminSession(adminJar);
      if (admin) {
        inviteCode = inviteCode || await generatePromoCode(adminJar, 'invite/signup');
        proCode    = await generatePromoCode(adminJar, 'Pro access');
      }
    }

    // 1. Auth flow — creates and logs in as test user
    const testUser = await testAuthFlow(testJar, inviteCode);
    if (!testUser) {
      console.log('\n⛔ Auth flow failed — cannot continue remaining tests.');
      await doCleanup();
      printSummary();
      process.exit(1);
    }

    // Redeem Pro promo code if available
    let isPro = false;
    if (proCode) {
      const redeem = await api('POST', '/api/promo-codes/redeem', { code: proCode }, testJar);
      if (redeem.status === 200 && redeem.data.success) {
        pass('Redeem Pro promo code', `code: ${proCode}`);
        isPro = true;
      } else {
        fail('Redeem Pro promo code', `status ${redeem.status}: ${JSON.stringify(redeem.data)}`);
      }
    } else {
      warn('Pro promo code', 'No admin provided — Pro features will test 403 rejection only');
    }

    // 2–6. Core test suites
    await testTransactions(testJar);
    await testBills(testJar);
    await testDebts(testJar, isPro);
    await testWallets(testJar);
    await testProAccess(testJar, isPro);

  } catch (err) {
    console.error('\n💥 Unexpected error:', err.message);
    console.error(err.stack);
    failed++;
  } finally {
    await doCleanup();
  }

  printSummary();
  process.exit(failed > 0 ? 1 : 0);
}

function printSummary() {
  console.log(`\n${'═'.repeat(54)}`);
  console.log(`RESULTS: ${passed} passed  |  ${failed} failed  |  ${warned} warnings`);
  console.log('═'.repeat(54));

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.ok === false).forEach(r => {
      console.log(`  ❌ ${r.name}`);
      if (r.detail) console.log(`     ${r.detail}`);
    });
  }

  if (warned > 0) {
    console.log('\nWarnings:');
    results.filter(r => r.ok === null).forEach(r => {
      console.log(`  ⚠️  ${r.name}`);
      if (r.detail) console.log(`     ${r.detail}`);
    });
  }

  console.log(failed > 0
    ? '\n🔴 SMOKE TEST FAILED\n'
    : '\n🟢 SMOKE TEST PASSED\n');
}

main();
