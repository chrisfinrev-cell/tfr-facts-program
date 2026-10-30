'use strict';

/**
 * mod_plaid — Plaid Foundation (Option A) — READ-ONLY / NON-CUSTODIAL
 *
 * Link Token → Public Token Exchange → transactionsSync → core ledger (display only).
 *
 * REGULATORY POSTURE:
 *   - Read-only scopes only (transactions; balances if supported).
 *   - NEVER requests auth (routing/account numbers), transfer, payment_initiation,
 *     or investments products — FACTS does not initiate ACH, wires, or trades.
 *   - No intermediate holding / escrow of user funds.
 *
 * Routes (mounted at /api/mod_plaid and aliased at /api/plaid):
 *   GET  /health
 *   POST /create-link-token | /create_link_token
 *   POST /exchange-token    | /exchange_public_token
 *   POST /sync-transactions
 *   POST /disconnect
 *   GET  /balances
 *   GET  /connections
 *   GET  /accounts
 *   GET  /transactions
 *   GET  /status
 *
 * Schema: mod_plaid.user_items, account_balances, synced_transactions
 *
 * © T-Dagsis LLC. All rights reserved.
 */

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const { asyncRoute } = require('../../module-error-boundary');

// Read-only educational bank data only.
// Do NOT request auth (routing/account numbers), transfer, payment_initiation,
// or investments products — FACTS never initiates ACH or trades.
// Account balances are read via accountsGet after link (no separate product needed).
const PLAID_PRODUCTS = ['transactions'];
const SYNC_ACCOUNT_TYPES = new Set(['depository', 'credit']);
const SYNC_ACCOUNT_SUBTYPES = new Set(['checking', 'savings', 'credit card', 'paypal']);

// ─── Plaid SDK init ───────────────────────────────────────────────────────────
let plaidClient = null;

function getPlaidClient() {
  if (plaidClient) return plaidClient;

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || 'sandbox';

  if (!clientId || !secret) return null;

  const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
  const config = new Configuration({
    basePath: PlaidEnvironments[env] || PlaidEnvironments.sandbox,
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  });
  plaidClient = new PlaidApi(config);
  return plaidClient;
}

// ─── DB Pool ──────────────────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

// ─── Encryption (AES-256-GCM) ─────────────────────────────────────────────────
function getEncryptionKey() {
  const raw =
    process.env.VAULT_ENCRYPTION_KEY ||
    process.env.SESSION_SECRET ||
    process.env.PLAID_SECRET ||
    'fallback-key-change-me';
  // Accept 64-char hex as raw 32-byte AES key; otherwise SHA-256 derive
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(text) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), encrypted.toString('hex'), authTag.toString('hex')].join(':');
}

function decrypt(payload) {
  const [ivHex, encHex, tagHex] = payload.split(':');
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ─── Tier helpers ─────────────────────────────────────────────────────────────
const PLAID_ALLOWED_TIERS = ['elite', 'business', 'sovereignty'];
const SOVEREIGNTY_TIER = 'sovereignty';

function userTier(user) {
  const tier = (user.subscription_tier || user.plan || '').toLowerCase();
  if (tier === 'sovereignty') return 'sovereignty';
  if (tier === 'business') return 'business';
  if (tier === 'elite') return 'elite';
  if (user.subscription_status === 'active' && user.subscription_plan) return 'elite';
  return 'free';
}

function canAccessPlaid(user) {
  return PLAID_ALLOWED_TIERS.includes(userTier(user));
}

function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

async function loadUser(pool, userId) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  return result.rows[0] || null;
}

async function isPlaidEnabled(pool) {
  const result = await pool.query(
    `SELECT status FROM core.module_flags WHERE module_id = 'mod_plaid' AND user_id IS NULL`
  );
  return result.rows[0]?.status === 'enabled';
}

function plaidRequired(req, res, next) {
  const client = getPlaidClient();
  if (!client) {
    return res.status(503).json({
      error: 'Plaid not configured',
      message: 'Bank connectivity is being set up. Check back shortly.',
      configured: false,
    });
  }
  req.plaidClient = client;
  next();
}

function requirePlaidTier(req, res, next) {
  const user = req.plaidUser;
  if (!canAccessPlaid(user)) {
    return res.status(403).json({
      error: 'Tier required',
      message: 'Plaid bank connectivity requires Elite tier or higher.',
      tier: userTier(user),
      required_tiers: PLAID_ALLOWED_TIERS,
    });
  }
  next();
}

async function loadUserMiddleware(req, res, next) {
  const pool = getPool();
  const user = await loadUser(pool, req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  req.plaidUser = user;
  next();
}

const plaidGuard = [
  requireAuth,
  asyncRoute(loadUserMiddleware),
  plaidRequired,
  requirePlaidTier,
];

// ─── user_items helpers ───────────────────────────────────────────────────────
async function getActiveUserItems(pool, userId) {
  const result = await pool.query(
    `SELECT * FROM mod_plaid.user_items
     WHERE user_id = $1 AND status = 'active'
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function upsertUserItem(pool, {
  userId,
  sessionId,
  itemId,
  accessTokenEncrypted,
  institutionId,
  institutionName,
}) {
  const result = await pool.query(
    `INSERT INTO mod_plaid.user_items
       (user_id, session_id, item_id, access_token_encrypted,
        institution_id, institution_name, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', NOW(), NOW())
     ON CONFLICT (item_id) DO UPDATE SET
       user_id                = EXCLUDED.user_id,
       session_id             = EXCLUDED.session_id,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       institution_id         = COALESCE(EXCLUDED.institution_id, mod_plaid.user_items.institution_id),
       institution_name       = COALESCE(EXCLUDED.institution_name, mod_plaid.user_items.institution_name),
       status                 = 'active',
       updated_at             = NOW()
     RETURNING *`,
    [userId, sessionId || null, itemId, accessTokenEncrypted, institutionId || null, institutionName || null]
  );
  return result.rows[0];
}

function shouldSyncAccount(acct) {
  if (!SYNC_ACCOUNT_TYPES.has(acct.type)) return false;
  const subtype = (acct.subtype || '').toLowerCase();
  return !subtype || SYNC_ACCOUNT_SUBTYPES.has(subtype) || subtype.includes('checking') || subtype.includes('savings') || subtype.includes('credit');
}

async function upsertAccountBalance(pool, userId, userItemId, acct) {
  if (!shouldSyncAccount(acct)) return false;

  await pool.query(
    `INSERT INTO mod_plaid.account_balances
       (user_id, user_item_id, account_id, account_name, official_name,
        account_type, account_subtype, current_balance, available_balance,
        currency_code, last_synced_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
     ON CONFLICT (user_id, account_id) DO UPDATE SET
       user_item_id      = EXCLUDED.user_item_id,
       account_name      = EXCLUDED.account_name,
       official_name     = EXCLUDED.official_name,
       account_type      = EXCLUDED.account_type,
       account_subtype   = EXCLUDED.account_subtype,
       current_balance   = EXCLUDED.current_balance,
       available_balance = EXCLUDED.available_balance,
       currency_code     = EXCLUDED.currency_code,
       last_synced_at    = NOW(),
       updated_at        = NOW()`,
    [
      userId,
      userItemId,
      acct.account_id,
      acct.name || null,
      acct.official_name || null,
      acct.type || null,
      acct.subtype || null,
      acct.balances?.current ?? null,
      acct.balances?.available ?? null,
      acct.balances?.iso_currency_code || 'USD',
    ]
  );
  return true;
}

async function syncBalancesForItem(client, pool, userItem, accessToken) {
  const balanceResp = await client.accountsBalanceGet({ access_token: accessToken });
  let synced = 0;
  for (const acct of balanceResp.data.accounts || []) {
    if (await upsertAccountBalance(pool, userItem.user_id, userItem.id, acct)) synced++;
  }
  return synced;
}

function defaultBucketForAccount(accountMeta) {
  const subtype = (accountMeta?.account_subtype || '').toLowerCase();
  if (subtype.includes('credit')) return 'velocity';
  return 'necessities';
}

async function importTxnToCoreLedger(pool, userId, txn, accountMeta) {
  if (txn.pending) return { ledger_entry_id: null, core_transaction_id: null };

  const amountCents = Math.round(Math.abs(parseFloat(txn.amount) || 0) * 100);
  if (amountCents <= 0) return { ledger_entry_id: null, core_transaction_id: null };

  const merchant = txn.merchant_name || txn.name || 'Plaid Transaction';
  const description = txn.name || merchant;
  const txnDate = txn.date || new Date().toISOString().split('T')[0];
  const bucket = defaultBucketForAccount(accountMeta);
  let ledgerEntryId = null;
  let coreTransactionId = null;

  try {
    const ledgerResult = await pool.query(
      `INSERT INTO mod_ssc.t_dagsis_ledger
         (user_id, merchant, description, transaction_date,
          subtotal_cents, tax_cents, tip_cents, total_cents,
          bucket, allocation_pct)
       SELECT $1, $2, $3, $4, $5, 0, 0, $5, $6, 100
       WHERE NOT EXISTS (
         SELECT 1 FROM mod_plaid.synced_transactions st
         WHERE st.plaid_transaction_id = $7 AND st.ledger_entry_id IS NOT NULL
       )
       RETURNING id`,
      [userId, merchant, description, txnDate, amountCents, bucket, txn.transaction_id]
    );
    ledgerEntryId = ledgerResult.rows[0]?.id || null;
  } catch (err) {
    if (!/does not exist|relation.*t_dagsis_ledger/i.test(err.message)) {
      console.warn('[mod_plaid] SSC ledger import skipped:', err.message);
    }
  }

  try {
    const isExpense = parseFloat(txn.amount) > 0;
    const coreResult = await pool.query(
      `INSERT INTO transactions
         (user_id, amount, type, description, transaction_date, payment_method, created_at, updated_at)
       SELECT $1, $2, $3, $4, $5, 'Plaid Sync', NOW(), NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM mod_plaid.synced_transactions st
         WHERE st.plaid_transaction_id = $6 AND st.core_transaction_id IS NOT NULL
       )
       RETURNING id`,
      [
        userId,
        (amountCents / 100).toFixed(2),
        isExpense ? 'expense' : 'income',
        description,
        txnDate,
        txn.transaction_id,
      ]
    );
    coreTransactionId = coreResult.rows[0]?.id || null;
  } catch (err) {
    if (!/does not exist|relation.*transactions/i.test(err.message)) {
      console.warn('[mod_plaid] Core transactions import skipped:', err.message);
    }
  }

  return { ledger_entry_id: ledgerEntryId, core_transaction_id: coreTransactionId };
}

async function upsertSyncedTransaction(pool, userId, userItemId, txn, accountMeta) {
  const category = txn.personal_finance_category || txn.category || null;
  const importResult = await importTxnToCoreLedger(pool, userId, txn, accountMeta);

  const result = await pool.query(
    `INSERT INTO mod_plaid.synced_transactions
       (user_id, user_item_id, plaid_transaction_id, account_id, amount,
        transaction_date, name, merchant_name, category, pending,
        ledger_entry_id, core_transaction_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (plaid_transaction_id) DO UPDATE SET
       amount               = EXCLUDED.amount,
       transaction_date     = EXCLUDED.transaction_date,
       name                 = EXCLUDED.name,
       merchant_name        = EXCLUDED.merchant_name,
       category             = EXCLUDED.category,
       pending              = EXCLUDED.pending,
       ledger_entry_id      = COALESCE(mod_plaid.synced_transactions.ledger_entry_id, EXCLUDED.ledger_entry_id),
       core_transaction_id  = COALESCE(mod_plaid.synced_transactions.core_transaction_id, EXCLUDED.core_transaction_id),
       updated_at           = NOW()
     RETURNING id, ledger_entry_id, core_transaction_id`,
    [
      userId,
      userItemId,
      txn.transaction_id,
      txn.account_id,
      txn.amount,
      txn.date,
      txn.name || null,
      txn.merchant_name || null,
      category ? JSON.stringify(category) : null,
      txn.pending || false,
      importResult.ledger_entry_id,
      importResult.core_transaction_id,
    ]
  );
  return result.rows[0];
}

async function syncTransactionsForItem(client, pool, userItem, accessToken) {
  let cursor = userItem.transactions_sync_cursor || null;
  let hasMore = true;
  let batchSynced = 0;
  let pages = 0;

  const accountMetaById = {};
  const acctRows = await pool.query(
    `SELECT account_id, account_type, account_subtype
     FROM mod_plaid.account_balances
     WHERE user_item_id = $1`,
    [userItem.id]
  );
  for (const row of acctRows.rows) {
    accountMetaById[row.account_id] = row;
  }

  while (hasMore && pages < 20) {
    const syncParams = { access_token: accessToken };
    if (cursor) syncParams.cursor = cursor;

    const syncResp = await client.transactionsSync(syncParams);
    const data = syncResp.data;

    for (const txn of data.added || []) {
      await upsertSyncedTransaction(pool, userItem.user_id, userItem.id, txn, accountMetaById[txn.account_id]);
      batchSynced++;
    }

    for (const txn of data.modified || []) {
      await upsertSyncedTransaction(pool, userItem.user_id, userItem.id, txn, accountMetaById[txn.account_id]);
    }

    for (const removedTxn of data.removed || []) {
      await pool.query(
        `DELETE FROM mod_plaid.synced_transactions
         WHERE plaid_transaction_id = $1 AND user_id = $2`,
        [removedTxn.transaction_id, userItem.user_id]
      );
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
    pages++;
    if (batchSynced > 2000) break;
  }

  if (cursor) {
    await pool.query(
      `UPDATE mod_plaid.user_items
       SET transactions_sync_cursor = $2, updated_at = NOW()
       WHERE id = $1`,
      [userItem.id, cursor]
    );
  }

  return batchSynced;
}

async function mirrorLegacyConnection(pool, user, itemId, encryptedToken, institutionId, institutionName) {
  try {
    await pool.query(
      `INSERT INTO plaid_connections
         (user_id, institution_id, institution_name, access_token, item_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())
       ON CONFLICT (item_id) DO UPDATE SET
         access_token     = EXCLUDED.access_token,
         institution_id   = COALESCE(EXCLUDED.institution_id, plaid_connections.institution_id),
         institution_name = COALESCE(EXCLUDED.institution_name, plaid_connections.institution_name),
         status           = 'active',
         updated_at       = NOW()`,
      [user.id, institutionId || null, institutionName || null, encryptedToken, itemId]
    );
  } catch (_) {
    // Legacy table optional
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────
async function handleCreateLinkToken(req, res) {
  const user = req.plaidUser;
  const client = req.plaidClient;

  const response = await client.linkTokenCreate({
    user: { client_user_id: String(user.id) },
    client_name: 'Financial Revolution',
    products: PLAID_PRODUCTS,
    country_codes: ['US'],
    language: 'en',
  });

  res.json({
    link_token: response.data.link_token,
    expiration: response.data.expiration,
    read_only: true,
    products: PLAID_PRODUCTS,
  });
}

async function handleExchangePublicToken(req, res) {
  const publicToken = req.body.public_token || req.body.publicToken;
  const { institution_id, institution_name } = req.body;
  if (!publicToken) return res.status(400).json({ error: 'public_token required' });

  const user = req.plaidUser;
  const client = req.plaidClient;
  const pool = getPool();

  const exchangeResponse = await client.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchangeResponse.data.access_token;
  const itemId = exchangeResponse.data.item_id;
  const encryptedToken = encrypt(accessToken);

  const userItem = await upsertUserItem(pool, {
    userId: user.id,
    sessionId: req.sessionID || null,
    itemId,
    accessTokenEncrypted: encryptedToken,
    institutionId: institution_id,
    institutionName: institution_name,
  });

  await mirrorLegacyConnection(pool, user, itemId, encryptedToken, institution_id, institution_name);

  let accountsSynced = 0;
  try {
    accountsSynced = await syncBalancesForItem(client, pool, userItem, accessToken);
    await pool.query(`UPDATE users SET bank_linked = true WHERE id = $1`, [user.id]).catch(() => {});
  } catch (err) {
    console.error('[mod_plaid] Balance pull after exchange failed:', err.message);
  }

  res.json({
    success: true,
    user_item_id: userItem.id,
    item_id: itemId,
    institution_name: userItem.institution_name || institution_name,
    accounts_synced: accountsSynced,
  });
}

async function handleSyncTransactions(req, res) {
  const user = req.plaidUser;
  const client = req.plaidClient;
  const pool = getPool();

  const items = await getActiveUserItems(pool, user.id);
  if (items.length === 0) {
    return res.json({ success: true, synced: 0, balances_updated: 0, message: 'No active Plaid items' });
  }

  let totalSynced = 0;
  let totalBalances = 0;

  for (const userItem of items) {
    let accessToken;
    try {
      accessToken = decrypt(userItem.access_token_encrypted);
    } catch (err) {
      console.error('[mod_plaid] Decrypt failed for user_item', userItem.id, err.message);
      continue;
    }

    try {
      totalBalances += await syncBalancesForItem(client, pool, userItem, accessToken);
    } catch (err) {
      console.error('[mod_plaid] Balance sync failed:', err.message);
    }

    try {
      totalSynced += await syncTransactionsForItem(client, pool, userItem, accessToken);
    } catch (err) {
      console.error('[mod_plaid] Transaction sync failed:', err.message);
    }
  }

  await pool.query(
    `UPDATE bank_accounts SET last_sync_at = NOW(), is_verified = true, updated_at = NOW()
     WHERE user_id = $1 AND is_archived = false`,
    [user.id]
  ).catch(() => {});

  res.json({
    success: true,
    synced: totalSynced,
    balances_updated: totalBalances,
    items: items.length,
  });
}

// ─── Routers ──────────────────────────────────────────────────────────────────
const router = express.Router();
const aliasRouter = express.Router();

function registerPlaidRoutes(target) {
  target.post('/create-link-token', ...plaidGuard, asyncRoute(handleCreateLinkToken));
  target.post('/create_link_token', ...plaidGuard, asyncRoute(handleCreateLinkToken));
  target.post('/exchange-token', ...plaidGuard, asyncRoute(handleExchangePublicToken));
  target.post('/exchange_public_token', ...plaidGuard, asyncRoute(handleExchangePublicToken));
  target.post('/sync-transactions', ...plaidGuard, asyncRoute(handleSyncTransactions));
}

registerPlaidRoutes(router);
registerPlaidRoutes(aliasRouter);

// ─── GET /health ──────────────────────────────────────────────────────────────
router.get('/health', asyncRoute(async (req, res) => {
  const pool = getPool();
  const enabled = await isPlaidEnabled(pool).catch(() => false);
  const configured = !!getPlaidClient();

  let connectionCount = 0;
  let lastSyncAt = null;

  if (req.session?.userId) {
    try {
      const connResult = await pool.query(
        `SELECT COUNT(*) AS cnt FROM mod_plaid.user_items
         WHERE user_id = $1 AND status = 'active'`,
        [req.session.userId]
      );
      connectionCount = parseInt(connResult.rows[0]?.cnt || 0, 10);

      const syncResult = await pool.query(
        `SELECT MAX(last_synced_at) AS last_sync
         FROM mod_plaid.account_balances WHERE user_id = $1`,
        [req.session.userId]
      );
      lastSyncAt = syncResult.rows[0]?.last_sync || null;
    } catch (_) {
      // Schema may not be migrated yet
    }
  }

  res.json({
    status: enabled && configured ? 'operational' : enabled ? 'not_configured' : 'disabled',
    module: 'mod_plaid',
    version: '1.1.0',
    enabled,
    configured,
    plaid_env: process.env.PLAID_ENV || 'sandbox',
    products: PLAID_PRODUCTS,
    active_connections: connectionCount,
    last_sync_at: lastSyncAt,
  });
}));

// ─── POST /disconnect ─────────────────────────────────────────────────────────
router.post('/disconnect', ...plaidGuard, asyncRoute(async (req, res) => {
  const { connection_id, user_item_id, item_id } = req.body;
  const user = req.plaidUser;
  const client = req.plaidClient;
  const pool = getPool();

  let userItem;
  if (user_item_id) {
    const r = await pool.query(
      `SELECT * FROM mod_plaid.user_items WHERE id = $1 AND user_id = $2`,
      [user_item_id, user.id]
    );
    userItem = r.rows[0];
  } else if (item_id) {
    const r = await pool.query(
      `SELECT * FROM mod_plaid.user_items WHERE item_id = $1 AND user_id = $2`,
      [item_id, user.id]
    );
    userItem = r.rows[0];
  } else if (connection_id) {
    const r = await pool.query(
      `SELECT * FROM mod_plaid.user_items WHERE id = $1 AND user_id = $2`,
      [connection_id, user.id]
    );
    userItem = r.rows[0];
  }

  if (!userItem) return res.status(404).json({ error: 'Plaid item not found' });

  try {
    const accessToken = decrypt(userItem.access_token_encrypted);
    await client.itemRemove({ access_token: accessToken });
  } catch (err) {
    console.error('[mod_plaid] itemRemove failed (continuing):', err.message);
  }

  await pool.query(
    `UPDATE mod_plaid.user_items SET status = 'revoked', updated_at = NOW() WHERE id = $1`,
    [userItem.id]
  );

  await pool.query(
    `UPDATE plaid_connections SET status = 'revoked', updated_at = NOW()
     WHERE item_id = $1 AND user_id = $2`,
    [userItem.item_id, user.id]
  ).catch(() => {});

  await pool.query(
    `UPDATE bank_accounts SET is_verified = false WHERE user_id = $1`,
    [user.id]
  ).catch(() => {});

  res.json({ success: true, user_item_id: userItem.id, item_id: userItem.item_id });
}));

// ─── GET /balances ────────────────────────────────────────────────────────────
router.get('/balances', ...plaidGuard, asyncRoute(async (req, res) => {
  const user = req.plaidUser;
  const client = req.plaidClient;
  const pool = getPool();

  const items = await getActiveUserItems(pool, user.id);
  if (items.length === 0) {
    return res.json({ accounts: [], connections: 0, stale: false });
  }

  const allAccounts = [];
  for (const userItem of items) {
    let accessToken;
    try {
      accessToken = decrypt(userItem.access_token_encrypted);
    } catch (err) {
      console.error('[mod_plaid] Decrypt failed for user_item', userItem.id);
      continue;
    }

    await syncBalancesForItem(client, pool, userItem, accessToken);

    const snapshot = await pool.query(
      `SELECT account_id, account_name, official_name, account_type, account_subtype,
              current_balance, available_balance, currency_code, last_synced_at
       FROM mod_plaid.account_balances
       WHERE user_item_id = $1
       ORDER BY account_name`,
      [userItem.id]
    );

    for (const acct of snapshot.rows) {
      allAccounts.push({
        account_id: acct.account_id,
        name: acct.account_name,
        official_name: acct.official_name,
        type: acct.account_type,
        subtype: acct.account_subtype,
        current_balance: acct.current_balance,
        available_balance: acct.available_balance,
        currency_code: acct.currency_code,
        institution_name: userItem.institution_name,
        user_item_id: userItem.id,
        verified: true,
        last_sync_at: acct.last_synced_at,
      });
    }
  }

  res.json({
    accounts: allAccounts,
    connections: items.length,
    stale: false,
  });
}));

// ─── GET /connections ─────────────────────────────────────────────────────────
router.get('/connections', requireAuth, asyncRoute(async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, institution_id, institution_name, item_id, status, session_id,
            transactions_sync_cursor, created_at, updated_at
     FROM mod_plaid.user_items
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [req.session.userId]
  );

  const connections = await Promise.all(result.rows.map(async (conn) => {
    const syncResult = await pool.query(
      `SELECT MAX(last_synced_at) AS last_sync
       FROM mod_plaid.account_balances WHERE user_item_id = $1`,
      [conn.id]
    );
    return {
      ...conn,
      id: conn.id,
      connection_id: conn.id,
      last_sync_at: syncResult.rows[0]?.last_sync || null,
    };
  }));

  res.json({ connections });
}));

// ─── GET /accounts ────────────────────────────────────────────────────────────
router.get('/accounts', requireAuth, asyncRoute(async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT ab.id, ui.institution_id, ui.institution_name, ui.item_id,
            ab.account_id, ab.account_name, ab.account_type, ab.account_subtype,
            ab.available_balance, ab.current_balance, ab.currency_code, ab.last_synced_at
     FROM mod_plaid.account_balances ab
     JOIN mod_plaid.user_items ui ON ui.id = ab.user_item_id
     WHERE ab.user_id = $1
     ORDER BY ui.institution_name, ab.account_name`,
    [req.session.userId]
  );
  res.json({ accounts: result.rows });
}));

// ─── GET /transactions ────────────────────────────────────────────────────────
router.get('/transactions', requireAuth, asyncRoute(async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT st.id, st.plaid_transaction_id, st.account_id, st.amount, st.transaction_date AS date,
            st.name, st.merchant_name, st.category, st.pending,
            st.ledger_entry_id, st.core_transaction_id, st.created_at,
            ab.account_name, ab.account_type, ui.institution_name
     FROM mod_plaid.synced_transactions st
     LEFT JOIN mod_plaid.account_balances ab
       ON ab.account_id = st.account_id AND ab.user_id = st.user_id
     LEFT JOIN mod_plaid.user_items ui ON ui.id = st.user_item_id
     WHERE st.user_id = $1 AND st.pending = false
       AND st.ledger_entry_id IS NULL AND st.core_transaction_id IS NULL
     ORDER BY st.transaction_date DESC, st.id DESC
     LIMIT 100`,
    [req.session.userId]
  );

  const transactions = result.rows.map((row) => ({
    ...row,
    imported_to_facts: !!(row.ledger_entry_id || row.core_transaction_id),
  }));

  res.json({ transactions });
}));

// ─── GET /status ──────────────────────────────────────────────────────────────
router.get('/status', requireAuth, asyncRoute(async (req, res) => {
  const pool = getPool();
  const user = await loadUser(pool, req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const tier = userTier(user);
  const canAccess = canAccessPlaid(user);
  const configured = !!getPlaidClient();

  let activeConnections = 0;
  let lastSyncAt = null;
  let isStale = false;
  let integrityMultiplier = 0.70;

  if (canAccess) {
    try {
      const connResult = await pool.query(
        `SELECT COUNT(*) AS cnt FROM mod_plaid.user_items WHERE user_id = $1 AND status = 'active'`,
        [user.id]
      );
      activeConnections = parseInt(connResult.rows[0]?.cnt || 0, 10);

      if (activeConnections > 0) {
        const syncResult = await pool.query(
          `SELECT MAX(last_synced_at) AS ls FROM mod_plaid.account_balances WHERE user_id = $1`,
          [user.id]
        );
        lastSyncAt = syncResult.rows[0]?.ls || null;
        isStale = lastSyncAt
          ? (Date.now() - new Date(lastSyncAt).getTime()) > 7 * 24 * 60 * 60 * 1000
          : true;
        integrityMultiplier = isStale ? 0.85 : 1.0;
      }
    } catch (_) {}
  }

  res.json({
    tier,
    can_access_plaid: canAccess,
    plaid_configured: configured,
    active_connections: activeConnections,
    last_sync_at: lastSyncAt,
    is_stale: isStale,
    integrity_multiplier: integrityMultiplier,
    is_sovereignty: tier === SOVEREIGNTY_TIER,
    is_elite_or_above: canAccess,
  });
}));

// ─── Health check export ──────────────────────────────────────────────────────
async function healthCheck(pool) {
  const enabled = await isPlaidEnabled(pool).catch(() => false);
  const configured = !!getPlaidClient();

  let activeConnections = 0;
  try {
    const connResult = await pool.query(
      `SELECT COUNT(*) AS cnt FROM mod_plaid.user_items WHERE status = 'active'`
    );
    activeConnections = parseInt(connResult.rows[0]?.cnt || 0, 10);
  } catch (_) {}

  return {
    status: enabled && configured ? 'operational' : enabled ? 'not_configured' : 'disabled',
    version: '1.1.0',
    last_migration: 'mod_plaid_option_a',
    enabled,
    configured,
    plaid_env: process.env.PLAID_ENV || 'unset',
    products: PLAID_PRODUCTS,
    active_connections: activeConnections,
  };
}

module.exports = {
  routes: router,
  aliasRouter,
  healthCheck,
  metadata: {
    name: 'Plaid Foundation',
    version: '1.1.0',
    description: 'Plaid Option A — Link token, item exchange, balance + transaction sync to core ledger',
    defaultEnabled: true,
    requiredCoreVersion: '1.0.0',
    type: 'infrastructure',
  },
};
