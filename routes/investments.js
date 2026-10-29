'use strict';

/**
 * Brokerage holdings, stock quotes, crypto, Project Net Zero tracker.
 * Mounts preserve existing client URLs (not a single /api/investments prefix).
 *   app.use('/api/brokerage-accounts', brokerageAccountsRouter)
 *   app.use('/api/brokerage-holdings', brokerageHoldingsRouter)
 *   app.use('/api/stock-quotes', stockQuotesRouter)
 *   app.use('/api/all-accounts', allAccountsRouter)
 *   app.use('/api/crypto', cryptoRouter)
 *   app.use('/api/brokerage', brokerageTrackerRouter)
 */

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');

const brokerageAccountsRouter = express.Router();
const brokerageHoldingsRouter = express.Router();
const stockQuotesRouter = express.Router();
const allAccountsRouter = express.Router();
const cryptoRouter = express.Router();
const brokerageTrackerRouter = express.Router();

const runtime = {};
function bindInvestmentsRuntime(helpers) {
  Object.assign(runtime, helpers || {});
}

function hasProAccess(userOrId) {
  if (typeof runtime.hasProAccess === 'function') return runtime.hasProAccess(userOrId);
  return Promise.resolve(false);
}

brokerageAccountsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM brokerage_accounts WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json({ brokerage_accounts: result.rows });
  } catch (err) {
    console.error('GET /api/brokerage-accounts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch brokerage accounts' });
  }
});

brokerageAccountsRouter.post('/', requireAuth, async (req, res) => {
  try {
    const { name, institution, account_type, current_balance, account_number_last4, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const result = await pool.query(
      `INSERT INTO brokerage_accounts (user_id, name, institution, account_type, current_balance, account_number_last4, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.userId, name, institution || null, account_type || 'brokerage',
       current_balance || 0, account_number_last4 || null, notes || null]
    );
    res.json({ brokerage_account: result.rows[0] });
  } catch (err) {
    console.error('POST /api/brokerage-accounts error:', err.message);
    res.status(500).json({ error: 'Failed to create brokerage account' });
  }
});

// Update brokerage account
brokerageAccountsRouter.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, institution, account_type, current_balance, account_number_last4, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const result = await pool.query(
      `UPDATE brokerage_accounts SET name=$1, institution=$2, account_type=$3, current_balance=$4,
       account_number_last4=$5, notes=$6, updated_at=NOW()
       WHERE id=$7 AND user_id=$8 RETURNING *`,
      [name, institution || null, account_type || 'brokerage', current_balance || 0,
       account_number_last4 || null, notes || null,
       parseInt(req.params.id), req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Brokerage account not found' });
    res.json({ brokerage_account: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/brokerage-accounts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update brokerage account' });
  }
});

// Delete brokerage account
brokerageAccountsRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM brokerage_accounts WHERE id=$1 AND user_id=$2 RETURNING *',
      [parseInt(req.params.id), req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Brokerage account not found' });
    res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /api/brokerage-accounts/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete brokerage account' });
  }
});

// ─── BROKERAGE HOLDINGS ──────────────────────────────────
// ═══════════════════════════════════════════════════════════

// Get holdings for a brokerage account
brokerageAccountsRouter.get('/:id/holdings', requireAuth, async (req, res) => {
  try {
    const acctCheck = await pool.query(
      'SELECT id FROM brokerage_accounts WHERE id = $1 AND user_id = $2',
      [parseInt(req.params.id), req.userId]
    );
    if (!acctCheck.rows.length) return res.status(404).json({ error: 'Account not found' });
    const result = await pool.query(
      'SELECT * FROM brokerage_holdings WHERE brokerage_account_id = $1 AND user_id = $2 ORDER BY current_value DESC',
      [parseInt(req.params.id), req.userId]
    );
    res.json({ holdings: result.rows });
  } catch (err) {
    console.error('GET /api/brokerage-accounts/:id/holdings error:', err.message);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
});

// Add a holding to a brokerage account
brokerageAccountsRouter.post('/:id/holdings', requireAuth, async (req, res) => {
  try {
    const acctCheck = await pool.query(
      'SELECT id FROM brokerage_accounts WHERE id = $1 AND user_id = $2',
      [parseInt(req.params.id), req.userId]
    );
    if (!acctCheck.rows.length) return res.status(404).json({ error: 'Account not found' });
    const { symbol, name, investment_type, quantity, cost_basis, current_value, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Holding name is required' });
    const result = await pool.query(
      `INSERT INTO brokerage_holdings (user_id, brokerage_account_id, symbol, name, investment_type, quantity, cost_basis, current_value, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.userId, parseInt(req.params.id), symbol || null, name, investment_type || 'Stocks',
       quantity || 0, cost_basis || 0, current_value || 0, notes || null]
    );
    // Update account balance to sum of all holdings
    await pool.query(
      `UPDATE brokerage_accounts SET current_balance = (
        SELECT COALESCE(SUM(current_value), 0) FROM brokerage_holdings WHERE brokerage_account_id = $1
      ), updated_at = NOW() WHERE id = $1`,
      [parseInt(req.params.id)]
    );
    res.json({ holding: result.rows[0] });
  } catch (err) {
    console.error('POST /api/brokerage-accounts/:id/holdings error:', err.message);
    res.status(500).json({ error: 'Failed to add holding' });
  }
});

// Update a holding
brokerageHoldingsRouter.put('/:id', requireAuth, async (req, res) => {
  try {
    const { symbol, name, investment_type, quantity, cost_basis, current_value, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Holding name is required' });
    const result = await pool.query(
      `UPDATE brokerage_holdings SET symbol=$1, name=$2, investment_type=$3, quantity=$4,
       cost_basis=$5, current_value=$6, notes=$7, updated_at=NOW()
       WHERE id=$8 AND user_id=$9 RETURNING *`,
      [symbol || null, name, investment_type || 'Stocks', quantity || 0,
       cost_basis || 0, current_value || 0, notes || null,
       parseInt(req.params.id), req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Holding not found' });
    // Update account balance
    const accountId = result.rows[0].brokerage_account_id;
    await pool.query(
      `UPDATE brokerage_accounts SET current_balance = (
        SELECT COALESCE(SUM(current_value), 0) FROM brokerage_holdings WHERE brokerage_account_id = $1
      ), updated_at = NOW() WHERE id = $1`,
      [accountId]
    );
    res.json({ holding: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/brokerage-holdings/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update holding' });
  }
});

// Delete a holding
brokerageHoldingsRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM brokerage_holdings WHERE id=$1 AND user_id=$2 RETURNING *',
      [parseInt(req.params.id), req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Holding not found' });
    // Update account balance
    const accountId = result.rows[0].brokerage_account_id;
    await pool.query(
      `UPDATE brokerage_accounts SET current_balance = (
        SELECT COALESCE(SUM(current_value), 0) FROM brokerage_holdings WHERE brokerage_account_id = $1
      ), updated_at = NOW() WHERE id = $1`,
      [accountId]
    );
    res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /api/brokerage-holdings/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete holding' });
  }
});

// ─── STOCK QUOTE API (for brokerage holdings ticker prices) ─────────────────
// Fetches real-time stock prices from Yahoo Finance v8 (free, no key)
stockQuotesRouter.get('/', requireAuth, async (req, res) => {
  try {
    const { symbols } = req.query; // comma-separated tickers e.g. "AAPL,VOO,JEPI"
    if (!symbols) return res.status(400).json({ error: 'symbols query parameter required' });
    const tickerList = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);
    if (!tickerList.length) return res.status(400).json({ error: 'No valid symbols provided' });

    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${tickerList.join(',')}&range=1d&interval=1d`;
    const response = await fetch(yahooUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FACTS/1.0)' }
    });

    if (!response.ok) {
      // Fallback: try v7 quote endpoint
      const v7Url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${tickerList.join(',')}`;
      const v7Response = await fetch(v7Url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FACTS/1.0)' }
      });
      if (!v7Response.ok) {
        return res.json({ quotes: {}, source: 'unavailable' });
      }
      const v7Data = await v7Response.json();
      const quotes = {};
      (v7Data.quoteResponse?.result || []).forEach(q => {
        quotes[q.symbol] = {
          symbol: q.symbol,
          price: q.regularMarketPrice || 0,
          change: q.regularMarketChange || 0,
          changePercent: q.regularMarketChangePercent || 0,
          name: q.shortName || q.longName || q.symbol,
          marketState: q.marketState || 'CLOSED'
        };
      });
      return res.json({ quotes, source: 'yahoo_v7' });
    }

    const data = await response.json();
    const quotes = {};
    Object.entries(data || {}).forEach(([symbol, info]) => {
      if (info && info.close && info.close.length > 0) {
        const lastPrice = info.close[info.close.length - 1];
        const prevClose = info.previousClose || info.chartPreviousClose || lastPrice;
        const change = lastPrice - prevClose;
        const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
        quotes[symbol] = {
          symbol,
          price: lastPrice,
          change,
          changePercent: changePct,
          name: symbol,
          marketState: 'REGULAR'
        };
      }
    });
    res.json({ quotes, source: 'yahoo_spark' });
  } catch (err) {
    console.error('GET /api/stock-quotes error:', err.message);
    res.json({ quotes: {}, source: 'error' });
  }
});
brokerageAccountsRouter.get('/:id/transactions', requireAuth, async (req, res) => {
  try {
    const acctCheck = await pool.query(
      'SELECT id, name FROM brokerage_accounts WHERE id = $1 AND user_id = $2',
      [parseInt(req.params.id), req.userId]
    );
    if (!acctCheck.rows.length) return res.status(404).json({ error: 'Account not found' });
    // Look for transactions linked to bank accounts that match this brokerage account name
    // Brokerage transactions are tagged via bank_account_id on the transaction
    const result = await pool.query(
      `SELECT t.* FROM transactions t
       JOIN bank_accounts ba ON ba.id = t.bank_account_id
       WHERE t.user_id = $1 AND ba.name = $2
       ORDER BY t.transaction_date DESC, t.created_at DESC
       LIMIT 50`,
      [req.userId, acctCheck.rows[0].name]
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    console.error('GET /api/brokerage-accounts/:id/transactions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

allAccountsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const [bankResult, brokerageResult] = await Promise.all([
      pool.query(
        `SELECT id, name, institution_name as institution, account_type, current_balance, 'bank' as source
         FROM bank_accounts WHERE user_id = $1 AND (is_archived = FALSE OR is_archived IS NULL)
         ORDER BY name`,
        [req.userId]
      ),
      pool.query(
        `SELECT id, name, institution, account_type, current_balance, 'brokerage' as source
         FROM brokerage_accounts WHERE user_id = $1
         ORDER BY name`,
        [req.userId]
      )
    ]);
    res.json({
      accounts: [
        ...bankResult.rows.map(a => ({ ...a, icon: '🏦' })),
        ...brokerageResult.rows.map(a => ({ ...a, icon: '📈' }))
      ]
    });
  } catch (err) {
    console.error('GET /api/all-accounts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Fetch prices from CoinGecko and update cache in DB
async function refreshCryptoPrices(coinIds) {
  if (!coinIds || coinIds.length === 0) return {};
  const ids = [...new Set(coinIds)].join(',');
  try {
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=250&sparkline=false&price_change_percentage=24h`;
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return {};
    const data = await resp.json();
    const prices = {};
    for (const coin of data) {
      prices[coin.id] = {
        price_usd: coin.current_price || 0,
        price_change_24h: coin.price_change_percentage_24h || 0,
        market_cap_usd: coin.market_cap || 0,
        image_url: coin.image || null,
        coin_symbol: (coin.symbol || '').toUpperCase(),
        coin_name: coin.name || coin.id
      };
      await pool.query(
        `INSERT INTO crypto_price_cache (coin_id, coin_symbol, coin_name, price_usd, price_change_24h, market_cap_usd, image_url, last_updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (coin_id) DO UPDATE SET
           price_usd=$4, price_change_24h=$5, market_cap_usd=$6, image_url=$7, coin_symbol=$2, coin_name=$3, last_updated=NOW()`,
        [coin.id, prices[coin.id].coin_symbol, prices[coin.id].coin_name,
         prices[coin.id].price_usd, prices[coin.id].price_change_24h,
         prices[coin.id].market_cap_usd, prices[coin.id].image_url]
      );
    }
    return prices;
  } catch (err) {
    console.error('[Crypto] CoinGecko fetch error:', err.message);
    return {};
  }
}

// Get prices — from cache if fresh, else fetch from CoinGecko
async function getCryptoPrices(coinIds) {
  if (!coinIds || coinIds.length === 0) return {};
  const uniqueIds = [...new Set(coinIds)];
  const staleThreshold = new Date(Date.now() - PRICE_CACHE_TTL_MS);
  const cached = await pool.query(
    `SELECT * FROM crypto_price_cache WHERE coin_id = ANY($1) AND last_updated > $2`,
    [uniqueIds, staleThreshold]
  );
  const cachedMap = {};
  for (const r of cached.rows) cachedMap[r.coin_id] = r;

  const staleIds = uniqueIds.filter(id => !cachedMap[id]);
  if (staleIds.length > 0) {
    const fresh = await refreshCryptoPrices(staleIds);
    Object.assign(cachedMap, Object.fromEntries(
      Object.entries(fresh).map(([id, v]) => [id, { ...v, coin_id: id }])
    ));
  }
  return cachedMap;
}

// Build enriched holdings array with live prices and gains/losses
async function buildEnrichedHoldings(userId) {
  const rows = await pool.query(
    `SELECT h.*, wc.label AS wallet_label, wc.address AS wallet_address
     FROM crypto_holdings h
     LEFT JOIN crypto_wallet_connections wc ON wc.id = h.wallet_connection_id
     WHERE h.user_id = $1
     ORDER BY h.created_at ASC`,
    [userId]
  );
  if (rows.rows.length === 0) return [];

  const coinIds = rows.rows.map(r => r.coin_id);
  const prices = await getCryptoPrices(coinIds);

  return rows.rows.map(h => {
    const p = prices[h.coin_id] || {};
    const qty = parseFloat(h.quantity) || 0;
    const currentPrice = parseFloat(p.price_usd || 0);
    const purchasePrice = parseFloat(h.purchase_price_usd || 0);
    const currentValue = qty * currentPrice;
    const costBasis = qty * purchasePrice;
    const gainLoss = costBasis > 0 ? currentValue - costBasis : null;
    const gainLossPct = costBasis > 0 ? ((currentValue - costBasis) / costBasis) * 100 : null;

    return {
      id: h.id,
      source: h.source,
      coin_id: h.coin_id,
      coin_symbol: p.coin_symbol || h.coin_symbol,
      coin_name: p.coin_name || h.coin_name,
      quantity: qty,
      purchase_price_usd: purchasePrice,
      purchase_date: h.purchase_date,
      notes: h.notes,
      wallet_label: h.wallet_label || null,
      wallet_address: h.wallet_address || null,
      wallet_connection_id: h.wallet_connection_id,
      current_price_usd: currentPrice,
      price_change_24h: parseFloat(p.price_change_24h || 0),
      image_url: p.image_url || null,
      current_value_usd: currentValue,
      cost_basis_usd: costBasis,
      gain_loss_usd: gainLoss,
      gain_loss_pct: gainLossPct
    };
  });
}

// Read ETH balance from public RPC (no API key needed)
async function fetchEthBalance(address) {
  try {
    const rpc = 'https://eth.llamarpc.com';
    const body = JSON.stringify({
      jsonrpc: '2.0', method: 'eth_getBalance',
      params: [address, 'latest'], id: 1
    });
    const resp = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body
    });
    const json = await resp.json();
    if (json.result) {
      const wei = BigInt(json.result);
      const eth = Number(wei) / 1e18;
      return Math.round(eth * 1e10) / 1e10;
    }
    return 0;
  } catch (err) {
    console.error('[Crypto] ETH balance fetch error:', err.message);
    return 0;
  }
}

// Fetch common ERC-20 token balances via Etherscan (free tier, no key needed for single calls)
async function fetchEthTokenBalances(address) {
  // Common ERC-20 tokens with CoinGecko IDs
  const tokens = [
    { symbol: 'USDT', contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', coinId: 'tether' },
    { symbol: 'USDC', contract: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', coinId: 'usd-coin' },
    { symbol: 'LINK', contract: '0x514910771af9ca656af840dff83e8264ecf986ca', coinId: 'chainlink' },
    { symbol: 'UNI', contract: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', coinId: 'uniswap' },
    { symbol: 'SHIB', contract: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', coinId: 'shiba-inu' },
    { symbol: 'WBTC', contract: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', coinId: 'wrapped-bitcoin' },
  ];

  const results = [];
  const etherscanKey = process.env.ETHERSCAN_API_KEY || 'YourApiKeyToken';
  for (const token of tokens) {
    try {
      const url = `https://api.etherscan.io/api?module=account&action=tokenbalance&contractaddress=${token.contract}&address=${address}&tag=latest&apikey=${etherscanKey}`;
      const resp = await fetch(url);
      const json = await resp.json();
      if (json.status === '1' && json.result && json.result !== '0') {
        // Most ERC-20 use 6 or 18 decimals — we'll check CoinGecko decimals or assume 18
        const decimals = ['USDT','USDC'].includes(token.symbol) ? 6 : 18;
        const balance = Number(BigInt(json.result)) / Math.pow(10, decimals);
        if (balance > 0.0001) {
          results.push({ ...token, balance: Math.round(balance * 1e8) / 1e8 });
        }
      }
    } catch (_) {}
  }
  return results;
}

// ── GET /api/crypto/holdings ──────────────────────────────────────────────────
cryptoRouter.get('/holdings', requireAuth, async (req, res) => {
  if (!await hasProAccess(req.userId)) {
    return res.status(403).json({ success: false, error: 'Crypto Tracker is a paid feature. Upgrade to access it.', code: 'PRO_REQUIRED' });
  }
  try {
    const holdings = await buildEnrichedHoldings(req.userId);
    const totalValue = holdings.reduce((s, h) => s + h.current_value_usd, 0);
    const totalCostBasis = holdings.reduce((s, h) => s + h.cost_basis_usd, 0);
    const totalGainLoss = totalCostBasis > 0 ? totalValue - totalCostBasis : null;
    const totalGainLossPct = totalCostBasis > 0 ? ((totalValue - totalCostBasis) / totalCostBasis) * 100 : null;

    const wallets = await pool.query(
      `SELECT id, wallet_type, address, label, last_synced_at FROM crypto_wallet_connections WHERE user_id=$1 ORDER BY created_at`,
      [req.userId]
    );

    res.json({
      success: true,
      holdings,
      wallets: wallets.rows,
      summary: { totalValue, totalCostBasis, totalGainLoss, totalGainLossPct, count: holdings.length }
    });
  } catch (err) {
    console.error('[Crypto] GET holdings error:', err);
    res.status(500).json({ success: false, error: 'Failed to load holdings' });
  }
});

// ── POST /api/crypto/holdings ─────────────────────────────────────────────────
cryptoRouter.post('/holdings', requireAuth, async (req, res) => {
  if (!await hasProAccess(req.userId)) {
    return res.status(403).json({ success: false, error: 'Paid plan required', code: 'PRO_REQUIRED' });
  }
  const { coin_id, coin_symbol, coin_name, quantity, purchase_price_usd, purchase_date, notes } = req.body;
  if (!coin_id || !coin_symbol || !coin_name || !quantity) {
    return res.status(400).json({ success: false, error: 'coin_id, coin_symbol, coin_name, quantity are required' });
  }
  const qty = parseFloat(quantity);
  if (isNaN(qty) || qty <= 0) return res.status(400).json({ success: false, error: 'quantity must be a positive number' });

  try {
    const result = await pool.query(
      `INSERT INTO crypto_holdings (user_id, source, coin_id, coin_symbol, coin_name, quantity, purchase_price_usd, purchase_date, notes)
       VALUES ($1,'manual',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [req.userId, coin_id.toLowerCase(), coin_symbol.toUpperCase(), coin_name,
       qty, purchase_price_usd || null, purchase_date || null, notes || null]
    );
    // Warm up the price cache
    await getCryptoPrices([coin_id.toLowerCase()]);
    const holdings = await buildEnrichedHoldings(req.userId);
    res.json({ success: true, id: result.rows[0].id, holdings });
  } catch (err) {
    console.error('[Crypto] POST holding error:', err);
    res.status(500).json({ success: false, error: 'Failed to add holding' });
  }
});

// ── PUT /api/crypto/holdings/:id ──────────────────────────────────────────────
cryptoRouter.put('/holdings/:id', requireAuth, async (req, res) => {
  if (!await hasProAccess(req.userId)) {
    return res.status(403).json({ success: false, error: 'Paid plan required', code: 'PRO_REQUIRED' });
  }
  const { id } = req.params;
  const { quantity, purchase_price_usd, purchase_date, notes, coin_id, coin_symbol, coin_name } = req.body;

  try {
    const existing = await pool.query(
      `SELECT * FROM crypto_holdings WHERE id=$1 AND user_id=$2`, [id, req.userId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'Holding not found' });

    const qty = quantity !== undefined ? parseFloat(quantity) : parseFloat(existing.rows[0].quantity);
    await pool.query(
      `UPDATE crypto_holdings SET
         quantity=$1, purchase_price_usd=$2, purchase_date=$3, notes=$4,
         coin_id=COALESCE($5,coin_id), coin_symbol=COALESCE($6,coin_symbol), coin_name=COALESCE($7,coin_name),
         updated_at=NOW()
       WHERE id=$8 AND user_id=$9`,
      [qty, purchase_price_usd !== undefined ? purchase_price_usd : existing.rows[0].purchase_price_usd,
       purchase_date || existing.rows[0].purchase_date,
       notes !== undefined ? notes : existing.rows[0].notes,
       coin_id ? coin_id.toLowerCase() : null,
       coin_symbol ? coin_symbol.toUpperCase() : null,
       coin_name || null,
       id, req.userId]
    );
    const holdings = await buildEnrichedHoldings(req.userId);
    res.json({ success: true, holdings });
  } catch (err) {
    console.error('[Crypto] PUT holding error:', err);
    res.status(500).json({ success: false, error: 'Failed to update holding' });
  }
});

// ── DELETE /api/crypto/holdings/:id ──────────────────────────────────────────
cryptoRouter.delete('/holdings/:id', requireAuth, async (req, res) => {
  if (!await hasProAccess(req.userId)) {
    return res.status(403).json({ success: false, error: 'Paid plan required', code: 'PRO_REQUIRED' });
  }
  try {
    const result = await pool.query(
      `DELETE FROM crypto_holdings WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.id, req.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Holding not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to delete' });
  }
});

// ── GET /api/crypto/search-coins ──────────────────────────────────────────────
cryptoRouter.get('/search-coins', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ success: true, coins: [] });
  try {
    const url = `${COINGECKO_BASE}/search?query=${encodeURIComponent(q)}`;
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return res.json({ success: true, coins: [] });
    const data = await resp.json();
    const coins = (data.coins || []).slice(0, 20).map(c => ({
      id: c.id,
      symbol: (c.symbol || '').toUpperCase(),
      name: c.name,
      thumb: c.thumb
    }));
    res.json({ success: true, coins });
  } catch (err) {
    res.json({ success: true, coins: [] });
  }
});

// ── POST /api/crypto/wallet ───────────────────────────────────────────────────
cryptoRouter.post('/wallet', requireAuth, async (req, res) => {
  if (!await hasProAccess(req.userId)) {
    return res.status(403).json({ success: false, error: 'Paid plan required', code: 'PRO_REQUIRED' });
  }
  const { address, label } = req.body;
  if (!address) return res.status(400).json({ success: false, error: 'Wallet address is required' });

  // Basic EVM address validation
  const cleanAddr = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(cleanAddr)) {
    return res.status(400).json({ success: false, error: 'Invalid EVM wallet address (must be 0x + 40 hex chars)' });
  }

  try {
    // Upsert wallet connection
    const wResult = await pool.query(
      `INSERT INTO crypto_wallet_connections (user_id, wallet_type, address, label)
       VALUES ($1,'evm',$2,$3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [req.userId, cleanAddr, label || `Wallet ${cleanAddr.slice(0, 6)}...${cleanAddr.slice(-4)}`]
    );

    let walletId;
    if (wResult.rows.length > 0) {
      walletId = wResult.rows[0].id;
    } else {
      const existing = await pool.query(
        `SELECT id FROM crypto_wallet_connections WHERE user_id=$1 AND address=$2`, [req.userId, cleanAddr]
      );
      walletId = existing.rows[0]?.id;
    }

    if (!walletId) return res.status(500).json({ success: false, error: 'Failed to save wallet' });

    // Fetch ETH balance
    const ethBalance = await fetchEthBalance(cleanAddr);
    let tokensAdded = 0;

    // Remove old wallet-synced holdings for this wallet
    await pool.query(
      `DELETE FROM crypto_holdings WHERE user_id=$1 AND wallet_connection_id=$2 AND source='wallet'`,
      [req.userId, walletId]
    );

    if (ethBalance > 0) {
      await pool.query(
        `INSERT INTO crypto_holdings (user_id, source, wallet_connection_id, coin_id, coin_symbol, coin_name, quantity)
         VALUES ($1,'wallet',$2,'ethereum','ETH','Ethereum',$3)`,
        [req.userId, walletId, ethBalance]
      );
      tokensAdded++;
    }

    // Try to fetch ERC-20 tokens
    const tokens = await fetchEthTokenBalances(cleanAddr);
    for (const token of tokens) {
      await pool.query(
        `INSERT INTO crypto_holdings (user_id, source, wallet_connection_id, coin_id, coin_symbol, coin_name, quantity)
         VALUES ($1,'wallet',$2,$3,$4,$5,$6)`,
        [req.userId, walletId, token.coinId, token.symbol, token.symbol, token.balance]
      );
      tokensAdded++;
    }

    // Update last_synced_at
    await pool.query(
      `UPDATE crypto_wallet_connections SET last_synced_at=NOW() WHERE id=$1`, [walletId]
    );

    // Fetch updated holdings
    const holdings = await buildEnrichedHoldings(req.userId);
    const wallets = await pool.query(
      `SELECT id, wallet_type, address, label, last_synced_at FROM crypto_wallet_connections WHERE user_id=$1 ORDER BY created_at`,
      [req.userId]
    );

    res.json({
      success: true,
      walletId,
      ethBalance,
      tokensAdded,
      message: tokensAdded > 0 ? `Synced ${tokensAdded} token(s) from wallet` : 'Wallet connected (no balance found)',
      holdings,
      wallets: wallets.rows
    });
  } catch (err) {
    console.error('[Crypto] POST wallet error:', err);
    res.status(500).json({ success: false, error: 'Failed to connect wallet: ' + err.message });
  }
});

// ── POST /api/crypto/wallet/:id/sync ─────────────────────────────────────────
cryptoRouter.post('/wallet/:id/sync', requireAuth, async (req, res) => {
  if (!await hasProAccess(req.userId)) {
    return res.status(403).json({ success: false, error: 'Paid plan required', code: 'PRO_REQUIRED' });
  }
  try {
    const wallet = await pool.query(
      `SELECT * FROM crypto_wallet_connections WHERE id=$1 AND user_id=$2`, [req.params.id, req.userId]
    );
    if (wallet.rows.length === 0) return res.status(404).json({ success: false, error: 'Wallet not found' });

    const { address, id: walletId } = wallet.rows[0];
    const ethBalance = await fetchEthBalance(address);

    await pool.query(
      `DELETE FROM crypto_holdings WHERE user_id=$1 AND wallet_connection_id=$2 AND source='wallet'`,
      [req.userId, walletId]
    );

    if (ethBalance > 0) {
      await pool.query(
        `INSERT INTO crypto_holdings (user_id, source, wallet_connection_id, coin_id, coin_symbol, coin_name, quantity)
         VALUES ($1,'wallet',$2,'ethereum','ETH','Ethereum',$3)`,
        [req.userId, walletId, ethBalance]
      );
    }

    const tokens = await fetchEthTokenBalances(address);
    for (const token of tokens) {
      await pool.query(
        `INSERT INTO crypto_holdings (user_id, source, wallet_connection_id, coin_id, coin_symbol, coin_name, quantity)
         VALUES ($1,'wallet',$2,$3,$4,$5,$6)`,
        [req.userId, walletId, token.coinId, token.symbol, token.symbol, token.balance]
      );
    }

    await pool.query(`UPDATE crypto_wallet_connections SET last_synced_at=NOW() WHERE id=$1`, [walletId]);

    const holdings = await buildEnrichedHoldings(req.userId);
    res.json({ success: true, holdings, message: 'Wallet synced' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Sync failed: ' + err.message });
  }
});

// ── DELETE /api/crypto/wallet/:id ─────────────────────────────────────────────
cryptoRouter.delete('/wallet/:id', requireAuth, async (req, res) => {
  if (!await hasProAccess(req.userId)) {
    return res.status(403).json({ success: false, error: 'Paid plan required', code: 'PRO_REQUIRED' });
  }
  try {
    // Also remove wallet-synced holdings
    await pool.query(
      `DELETE FROM crypto_holdings WHERE user_id=$1 AND wallet_connection_id=$2 AND source='wallet'`,
      [req.userId, req.params.id]
    );
    await pool.query(
      `DELETE FROM crypto_wallet_connections WHERE id=$1 AND user_id=$2`, [req.params.id, req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to remove wallet' });
  }
});

// ── POST /api/crypto/snapshot ─────────────────────────────────────────────────
cryptoRouter.post('/snapshot', requireAuth, async (req, res) => {
  if (!await hasProAccess(req.userId)) {
    return res.status(403).json({ success: false, error: 'Paid plan required', code: 'PRO_REQUIRED' });
  }
  try {
    const holdings = await buildEnrichedHoldings(req.userId);
    const totalValue = holdings.reduce((s, h) => s + h.current_value_usd, 0);
    const totalCostBasis = holdings.reduce((s, h) => s + h.cost_basis_usd, 0);
    const today = new Date().toISOString().split('T')[0];

    await pool.query(
      `INSERT INTO crypto_portfolio_snapshots (user_id, total_value_usd, total_cost_basis_usd, snapshot_date)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
         total_value_usd=$2, total_cost_basis_usd=$3`,
      [req.userId, totalValue, totalCostBasis, today]
    );
    res.json({ success: true, totalValue, totalCostBasis });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Snapshot failed' });
  }
});

// ── GET /api/crypto/portfolio-history ─────────────────────────────────────────
cryptoRouter.get('/portfolio-history', requireAuth, async (req, res) => {
  if (!await hasProAccess(req.userId)) {
    return res.status(403).json({ success: false, error: 'Paid plan required', code: 'PRO_REQUIRED' });
  }
  const days = Math.min(parseInt(req.query.days || '365'), 365);
  try {
    const result = await pool.query(
      `SELECT snapshot_date, total_value_usd, total_cost_basis_usd
       FROM crypto_portfolio_snapshots
       WHERE user_id=$1 AND snapshot_date >= NOW()::date - $2
       ORDER BY snapshot_date ASC`,
      [req.userId, days]
    );
    res.json({ success: true, history: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load history' });
  }
});

// ── GET /api/crypto/net-worth-value ───────────────────────────────────────────
// Called by net-worth.html to include crypto in net worth total
cryptoRouter.get('/net-worth-value', requireAuth, async (req, res) => {
  if (!await hasProAccess(req.userId)) {
    return res.json({ success: true, value: 0 });
  }
  try {
    const holdings = await buildEnrichedHoldings(req.userId);
    const totalValue = holdings.reduce((s, h) => s + h.current_value_usd, 0);
    res.json({ success: true, value: totalValue, count: holdings.length });
  } catch (err) {
    res.json({ success: true, value: 0 });
  }
});

function computeBrokerageMetrics(transactions) {
  const totalBuyCost = transactions
    .filter(t => t.activity_type === 'buy')
    .reduce((s, t) => s + Math.abs(parseFloat(t.cash_flow)), 0);

  const totalRecovered = transactions
    .filter(t => ['sell','dividend','option_premium','lending_fee'].includes(t.activity_type))
    .reduce((s, t) => s + parseFloat(t.cash_flow), 0);

  const totalShares = transactions.reduce((s, t) => {
    if (t.activity_type === 'buy' && t.share_count)  return s + parseFloat(t.share_count);
    if (t.activity_type === 'sell' && t.share_count) return s - Math.abs(parseFloat(t.share_count));
    return s;
  }, 0);

  const netExposure   = totalBuyCost - totalRecovered;
  const infiniteReturn = netExposure <= 0 && totalBuyCost > 0;
  const recoveryPct   = totalBuyCost > 0 ? (totalRecovered / totalBuyCost) * 100 : 0;

  // True cost basis per share
  const dividendTotal = transactions
    .filter(t => ['dividend','option_premium','lending_fee'].includes(t.activity_type))
    .reduce((s, t) => s + parseFloat(t.cash_flow), 0);
  const trueCostBasisPerShare = totalShares > 0
    ? (totalBuyCost - dividendTotal) / totalShares
    : null;

  // Yield on true cost (12-month dividends / net exposure)
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
  const annualDividend = transactions
    .filter(t => t.activity_type === 'dividend' && new Date(t.date) >= twelveMonthsAgo)
    .reduce((s, t) => s + parseFloat(t.cash_flow), 0);

  const yieldOnTrueCost = netExposure <= 0
    ? 'Infinite'
    : netExposure > 0 && annualDividend > 0
      ? ((annualDividend / netExposure) * 100).toFixed(2)
      : '0.00';

  // Average cost per share = total buy cost / total shares (shares sold subtracted from denominator)
  const avgCostPerShare = totalShares > 0
    ? (totalBuyCost / totalShares)
    : null;

  return {
    total_shares: parseFloat(totalShares.toFixed(6)),
    total_buy_cost: parseFloat(totalBuyCost.toFixed(4)),
    total_recovered: parseFloat(totalRecovered.toFixed(4)),
    net_exposure: parseFloat(netExposure.toFixed(4)),
    infinite_return: infiniteReturn,
    recovery_percentage: parseFloat(recoveryPct.toFixed(2)),
    true_cost_basis_per_share: trueCostBasisPerShare !== null ? parseFloat(trueCostBasisPerShare.toFixed(4)) : null,
    average_cost_per_share: avgCostPerShare !== null ? parseFloat(avgCostPerShare.toFixed(4)) : null,
    yield_on_true_cost: yieldOnTrueCost,
    annual_dividend: parseFloat(annualDividend.toFixed(4))
  };
}

async function computeRecoveryVelocity(pool, assetId, userId) {
  // Recovery % today vs 30 days ago — derived purely from transactions
  const [allTx, oldTx] = await Promise.all([
    pool.query(
      `SELECT activity_type, cash_flow, share_count, date FROM brokerage_transactions WHERE asset_id=$1 AND user_id=$2 ORDER BY date`,
      [assetId, userId]
    ),
    pool.query(
      `SELECT activity_type, cash_flow, share_count, date FROM brokerage_transactions WHERE asset_id=$1 AND user_id=$2 AND date <= NOW() - INTERVAL '30 days' ORDER BY date`,
      [assetId, userId]
    )
  ]);
  const today30 = computeBrokerageMetrics(allTx.rows).recovery_percentage;
  const prev30  = computeBrokerageMetrics(oldTx.rows).recovery_percentage;
  return parseFloat(((today30 - prev30) / 30).toFixed(4));
}

// ── Vault-lock middleware (runs on all brokerage routes except discipline) ─────
async function checkVaultLock(req, res, next) {
  const userId = req.userId;
  try {
    const rec = await pool.query(
      `SELECT vault_status, last_entry_date FROM brokerage_discipline WHERE user_id=$1`,
      [userId]
    );
    if (!rec.rows.length) return next(); // no discipline record yet → not locked

    const d = rec.rows[0];
    // Auto-lock if 30+ days since last entry
    if (d.last_entry_date) {
      const daysSince = (Date.now() - new Date(d.last_entry_date).getTime()) / 86400000;
      if (daysSince > 30 && d.vault_status === 'active') {
        await pool.query(
          `UPDATE brokerage_discipline SET vault_status='locked', locked_at=NOW(), updated_at=NOW() WHERE user_id=$1`,
          [userId]
        );
        return res.status(423).json({
          error: 'Your Project Net Zero has been sealed due to 30 days of inactivity. Reactivate to continue.',
          code: 'VAULT_LOCKED'
        });
      }
    }
    if (d.vault_status === 'locked') {
      return res.status(423).json({
        error: 'Your Project Net Zero is locked. Reactivate to view your recovery progress.',
        code: 'VAULT_LOCKED'
      });
    }
    next();
  } catch (err) {
    console.error('[Brokerage] vault check error:', err.message);
    next(); // fail open so lock doesn't break everything
  }
}

// ── Streak helper ──────────────────────────────────────────────────────────────
async function updateDisciplineStreak(pool, userId) {
  // Upsert discipline record
  const rec = await pool.query(`SELECT * FROM brokerage_discipline WHERE user_id=$1`, [userId]);
  const now = new Date();

  if (!rec.rows.length) {
    await pool.query(
      `INSERT INTO brokerage_discipline (user_id, last_entry_date, streak_count, vault_status)
       VALUES ($1, $2, 1, 'active')`,
      [userId, now]
    );
    return;
  }

  const d = rec.rows[0];
  const lastEntry = d.last_entry_date ? new Date(d.last_entry_date) : null;
  let newStreak = d.streak_count;

  if (lastEntry) {
    // Determine ISO week number helper
    const isoWeek = (dt) => {
      const d = new Date(dt);
      d.setHours(0,0,0,0);
      d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
      const week1 = new Date(d.getFullYear(), 0, 4);
      return 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    };
    const currentWeek = isoWeek(now);
    const lastWeek    = isoWeek(lastEntry);
    const weekDiff    = currentWeek - lastWeek + (now.getFullYear() - lastEntry.getFullYear()) * 52;

    if (weekDiff === 0) {
      // same week — no streak change
    } else if (weekDiff === 1) {
      newStreak = d.streak_count + 1;
    } else {
      newStreak = 1; // gap — reset
    }
  } else {
    newStreak = 1;
  }

  await pool.query(
    `UPDATE brokerage_discipline
     SET last_entry_date=$1, streak_count=$2, vault_status='active', updated_at=NOW()
     WHERE user_id=$3`,
    [now, newStreak, userId]
  );
}

// GET /brokerage-tracker page
// page route stays in server.js

// ═══════════════════════════════════════════════════════════
// BROKERAGE ASSETS
// ═══════════════════════════════════════════════════════════

// List all assets with computed FACTS metrics, sorted by recovery velocity
brokerageTrackerRouter.get('/assets', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const userId = req.userId;
    const assetsResult = await pool.query(
      `SELECT * FROM brokerage_assets WHERE user_id=$1 AND is_archived=FALSE ORDER BY created_at`,
      [userId]
    );

    const assets = await Promise.all(assetsResult.rows.map(async (asset) => {
      const txResult = await pool.query(
        `SELECT * FROM brokerage_transactions WHERE asset_id=$1 AND user_id=$2 ORDER BY date`,
        [asset.id, userId]
      );
      const metrics  = computeBrokerageMetrics(txResult.rows);
      const velocity = await computeRecoveryVelocity(pool, asset.id, userId);
      return { ...asset, ...metrics, recovery_velocity: velocity, transactions: txResult.rows };
    }));

    // Sort: infinite_return assets first (gold hall-of-fame), then by recovery_velocity desc
    assets.sort((a, b) => {
      if (a.infinite_return && !b.infinite_return) return -1;
      if (!a.infinite_return && b.infinite_return) return 1;
      return b.recovery_velocity - a.recovery_velocity;
    });

    res.json({ assets });
  } catch (err) {
    console.error('GET /api/brokerage/assets error:', err.message);
    res.status(500).json({ error: 'Failed to fetch assets' });
  }
});

// Create asset
brokerageTrackerRouter.post('/assets', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { ticker_symbol, entity_owner = 'personal', goal_percent } = req.body;

    if (!ticker_symbol || !ticker_symbol.trim()) {
      return res.status(400).json({ error: 'ticker_symbol is required' });
    }

    const result = await pool.query(
      `INSERT INTO brokerage_assets (user_id, ticker_symbol, entity_owner, goal_percent)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, ticker_symbol.trim().toUpperCase(), entity_owner, goal_percent || null]
    );

    // Ensure discipline record exists
    const existing = await pool.query(`SELECT id FROM brokerage_discipline WHERE user_id=$1`, [userId]);
    if (!existing.rows.length) {
      await pool.query(
        `INSERT INTO brokerage_discipline (user_id, vault_status, streak_count) VALUES ($1,'active',0)`,
        [userId]
      );
    }

    res.status(201).json({ asset: { ...result.rows[0], ...computeBrokerageMetrics([]) } });
  } catch (err) {
    console.error('POST /api/brokerage/assets error:', err.message);
    res.status(500).json({ error: 'Failed to create asset' });
  }
});

// Get single asset with full transaction history + current price
brokerageTrackerRouter.get('/assets/:id', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const userId = req.userId;
    const assetId = parseInt(req.params.id);

    const assetResult = await pool.query(
      `SELECT * FROM brokerage_assets WHERE id=$1 AND user_id=$2 AND is_archived=FALSE`,
      [assetId, userId]
    );
    if (!assetResult.rows.length) return res.status(404).json({ error: 'Asset not found' });

    const txResult = await pool.query(
      `SELECT * FROM brokerage_transactions WHERE asset_id=$1 AND user_id=$2 ORDER BY date DESC`,
      [assetId, userId]
    );
    const metrics  = computeBrokerageMetrics(txResult.rows.slice().reverse());
    const velocity = await computeRecoveryVelocity(pool, assetId, userId);

    // Fetch current price from Yahoo Finance
    let currentPrice = null;
    try {
      const ticker = assetResult.rows[0].ticker_symbol;
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${ticker}&range=1d&interval=1d`;
      const priceRes = await fetch(yahooUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FACTS/1.0)' }
      });
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        const spark = priceData.spark?.result?.[0];
        if (spark?.data?.[0]?.meta?.regularMarketPrice) {
          currentPrice = spark.data[0].meta.regularMarketPrice;
        }
      }
      if (!currentPrice) {
        // Fallback to v7 quote endpoint
        const v7Url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;
        const v7Res = await fetch(v7Url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FACTS/1.0)' } });
        if (v7Res.ok) {
          const v7Data = await v7Res.json();
          currentPrice = v7Data.quoteResponse?.result?.[0]?.regularMarketPrice || null;
        }
      }
    } catch (priceErr) {
      console.error('[Brokerage] Price fetch error:', priceErr.message);
    }

    // Running net exposure over time for chart
    const chronoTx = txResult.rows.slice().reverse();
    let running = 0;
    const chartData = chronoTx.map(t => {
      if (t.activity_type === 'buy') running += Math.abs(parseFloat(t.cash_flow));
      else running -= parseFloat(t.cash_flow);
      return { date: t.date, net_exposure: parseFloat(running.toFixed(4)), activity_type: t.activity_type };
    });

    res.json({
      asset: { ...assetResult.rows[0], ...metrics, recovery_velocity: velocity, current_price: currentPrice },
      transactions: txResult.rows,
      chart_data: chartData
    });
  } catch (err) {
    console.error('GET /api/brokerage/assets/:id error:', err.message);
    res.status(500).json({ error: 'Failed to fetch asset' });
  }
});

// Update asset
brokerageTrackerRouter.patch('/assets/:id', requireAuth, async (req, res) => {
  try {
    const userId  = req.userId;
    const assetId = parseInt(req.params.id);
    const { entity_owner, goal_percent, ticker_symbol } = req.body;

    const existing = await pool.query(
      `SELECT id FROM brokerage_assets WHERE id=$1 AND user_id=$2 AND is_archived=FALSE`,
      [assetId, userId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Asset not found' });

    const result = await pool.query(
      `UPDATE brokerage_assets
       SET entity_owner=COALESCE($1,entity_owner),
           goal_percent=COALESCE($2,goal_percent),
           ticker_symbol=COALESCE($3,ticker_symbol),
           updated_at=NOW()
       WHERE id=$4 AND user_id=$5
       RETURNING *`,
      [entity_owner || null, goal_percent || null, ticker_symbol ? ticker_symbol.trim().toUpperCase() : null, assetId, userId]
    );
    res.json({ asset: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/brokerage/assets/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update asset' });
  }
});

// Archive asset (soft delete)
brokerageTrackerRouter.delete('/assets/:id', requireAuth, async (req, res) => {
  try {
    const userId  = req.userId;
    const assetId = parseInt(req.params.id);

    const result = await pool.query(
      `UPDATE brokerage_assets SET is_archived=TRUE, updated_at=NOW()
       WHERE id=$1 AND user_id=$2 RETURNING id`,
      [assetId, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Asset not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/brokerage/assets/:id error:', err.message);
    res.status(500).json({ error: 'Failed to archive asset' });
  }
});

// ═══════════════════════════════════════════════════════════
// BROKERAGE TRANSACTIONS
// ═══════════════════════════════════════════════════════════

// List transactions for an asset
brokerageTrackerRouter.get('/transactions', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const userId  = req.userId;
    const assetId = req.query.assetId ? parseInt(req.query.assetId) : null;

    if (!assetId) return res.status(400).json({ error: 'assetId query param required' });

    const result = await pool.query(
      `SELECT * FROM brokerage_transactions WHERE asset_id=$1 AND user_id=$2 ORDER BY date DESC, created_at DESC`,
      [assetId, userId]
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    console.error('GET /api/brokerage/transactions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// All transactions across all assets
brokerageTrackerRouter.get('/transactions/all', requireAuth, checkVaultLock, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(
      `SELECT bt.*, ba.ticker_symbol FROM brokerage_transactions bt
       JOIN brokerage_assets ba ON bt.asset_id = ba.id
       WHERE bt.user_id=$1 ORDER BY bt.date DESC, bt.created_at DESC`,
      [userId]
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    console.error('GET /api/brokerage/transactions/all error:', err.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Create transaction
brokerageTrackerRouter.post('/transactions', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const {
      asset_id, date, activity_type, cash_flow_input, share_count,
      fee, price_per_share, strike_price, expiry_date, call_put, notes
    } = req.body;

    if (!asset_id || !date || !activity_type || cash_flow_input == null) {
      return res.status(400).json({ error: 'Missing required fields: asset_id, date, activity_type, cash_flow_input' });
    }

    const validTypes = ['buy','sell','dividend','option_premium','lending_fee','options'];
    if (!validTypes.includes(activity_type)) {
      return res.status(400).json({ error: 'Invalid activity_type' });
    }

    // Verify asset belongs to user
    const assetCheck = await pool.query(
      `SELECT id FROM brokerage_assets WHERE id=$1 AND user_id=$2 AND is_archived=FALSE`,
      [asset_id, userId]
    );
    if (!assetCheck.rows.length) return res.status(404).json({ error: 'Asset not found' });

    const absAmt   = Math.abs(parseFloat(cash_flow_input));
    const isOptions = activity_type === 'options';
    const isBuy    = activity_type === 'buy';

    // Auto-sign cash_flow: buys are negative, everything else is positive
    const cashFlow = isBuy ? -absAmt : absAmt;

    // Fee reduces proceeds for sell/options; adds to cost for buy
    const feeAmt = fee ? Math.abs(parseFloat(fee)) : 0;
    // Options share_count is optional but if provided must be valid
    if (isOptions && share_count != null && parseFloat(share_count) <= 0) {
      return res.status(400).json({ error: 'share_count must be positive for options' });
    }
    // For buy/sell, share_count required
    if (['buy','sell'].includes(activity_type) && (share_count == null || parseFloat(share_count) <= 0)) {
      return res.status(400).json({ error: 'share_count is required and must be positive for buy/sell' });
    }

    const result = await pool.query(
      `INSERT INTO brokerage_transactions
        (user_id, asset_id, date, activity_type, cash_flow, share_count, fee, price_per_share,
         strike_price, expiry_date, call_put, is_options, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        userId, asset_id, date, activity_type, cashFlow,
        ['buy','sell','options'].includes(activity_type) ? Math.abs(parseFloat(share_count || 0)) : null,
        feeAmt, price_per_share || null, strike_price || null, expiry_date || null,
        call_put || null, isOptions ? true : false, notes || null
      ]
    );

    // Update discipline streak
    await updateDisciplineStreak(pool, userId);

    res.status(201).json({ transaction: result.rows[0] });
  } catch (err) {
    console.error('POST /api/brokerage/transactions error:', err.message);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

// Update transaction
brokerageTrackerRouter.patch('/transactions/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const txId   = parseInt(req.params.id);
    const { date, activity_type, cash_flow_input, share_count, fee, notes } = req.body;

    const existing = await pool.query(
      `SELECT id FROM brokerage_transactions WHERE id=$1 AND user_id=$2`,
      [txId, userId]
    );
    if (!existing.rows.length) return res.status(404).json({ error: 'Transaction not found' });

    let cashFlow = null;
    if (cash_flow_input != null && activity_type) {
      const absAmt = Math.abs(parseFloat(cash_flow_input));
      cashFlow = activity_type === 'buy' ? -absAmt : absAmt;
    }

    const result = await pool.query(
      `UPDATE brokerage_transactions
       SET date=COALESCE($1,date),
           activity_type=COALESCE($2,activity_type),
           cash_flow=COALESCE($3,cash_flow),
           share_count=COALESCE($4,share_count),
           fee=COALESCE($5,fee),
           notes=COALESCE($6,notes),
           updated_at=NOW()
       WHERE id=$7 AND user_id=$8
       RETURNING *`,
      [
        date || null, activity_type || null, cashFlow,
        share_count ? Math.abs(parseFloat(share_count)) : null,
        fee != null ? Math.abs(parseFloat(fee)) : null,
        notes || null, txId, userId
      ]
    );
    res.json({ transaction: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/brokerage/transactions/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update transaction' });
  }
});

// Delete transaction
brokerageTrackerRouter.delete('/transactions/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const txId   = parseInt(req.params.id);

    const result = await pool.query(
      `DELETE FROM brokerage_transactions WHERE id=$1 AND user_id=$2 RETURNING id`,
      [txId, userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/brokerage/transactions/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

// ═══════════════════════════════════════════════════════════
// BROKERAGE DISCIPLINE
// ═══════════════════════════════════════════════════════════

brokerageTrackerRouter.get('/discipline', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    let rec = await pool.query(`SELECT * FROM brokerage_discipline WHERE user_id=$1`, [userId]);

    if (!rec.rows.length) {
      // No record yet — return safe defaults (not locked)
      return res.json({
        discipline: {
          vault_status: 'active',
          streak_count: 0,
          last_entry_date: null,
          days_until_lock: 30,
          reactivation_count: 0
        }
      });
    }

    const d = rec.rows[0];
    const daysUntilLock = d.last_entry_date
      ? Math.max(0, 30 - Math.floor((Date.now() - new Date(d.last_entry_date).getTime()) / 86400000))
      : 30;

    // Auto-update vault status if needed
    if (daysUntilLock === 0 && d.vault_status === 'active') {
      await pool.query(
        `UPDATE brokerage_discipline SET vault_status='locked', locked_at=NOW(), updated_at=NOW() WHERE user_id=$1`,
        [userId]
      );
      d.vault_status = 'locked';
    }

    res.json({
      discipline: {
        vault_status: d.vault_status,
        streak_count: d.streak_count,
        last_entry_date: d.last_entry_date,
        days_until_lock: daysUntilLock,
        reactivation_count: d.reactivation_count,
        locked_at: d.locked_at
      }
    });
  } catch (err) {
    console.error('GET /api/brokerage/discipline error:', err.message);
    res.status(500).json({ error: 'Failed to fetch discipline data' });
  }
});

// Reactivate locked vault
brokerageTrackerRouter.post('/discipline/reactivate', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const rec = await pool.query(`SELECT * FROM brokerage_discipline WHERE user_id=$1`, [userId]);

    if (!rec.rows.length || rec.rows[0].vault_status !== 'locked') {
      return res.status(400).json({ error: 'Project Net Zero is not locked' });
    }

    await pool.query(
      `UPDATE brokerage_discipline
       SET vault_status='active', streak_count=0, locked_at=NULL,
           reactivation_count=reactivation_count+1, updated_at=NOW()
       WHERE user_id=$1`,
      [userId]
    );

    res.json({ success: true, message: 'Project Net Zero reactivated. Streak reset to 0. Start building your streak again.' });
  } catch (err) {
    console.error('POST /api/brokerage/discipline/reactivate error:', err.message);
    res.status(500).json({ error: 'Failed to reactivate Project Net Zero' });
  }
});

module.exports = {
  brokerageAccountsRouter,
  brokerageHoldingsRouter,
  stockQuotesRouter,
  allAccountsRouter,
  cryptoRouter,
  brokerageTrackerRouter,
  bindInvestmentsRuntime
};
