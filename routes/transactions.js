'use strict';

/**
 * Transaction ledger, CSV export, tagging, and Deposit Directive income.
 * Mount:
 *   app.use('/api/transactions', router)
 *   app.use('/api/income', incomeRouter)
 */

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');
const { sanitizeNumber, loadTransactionColumns } = require('../lib/transaction-columns');

const router = express.Router();
const incomeRouter = express.Router();

const runtime = {};
function bindTransactionsRuntime(helpers) {
  Object.assign(runtime, helpers || {});
}

function hasProAccess(userOrId) {
  if (typeof runtime.hasProAccess === 'function') return runtime.hasProAccess(userOrId);
  return Promise.resolve(false);
}

function ensureFgBalance(userId) {
  if (typeof runtime.ensureFgBalance === 'function') return runtime.ensureFgBalance(userId);
  return Promise.resolve();
}

function tryAutoCompleteChallenge(userId, criteriaKey) {
  if (typeof runtime.tryAutoCompleteChallenge === 'function') {
    return runtime.tryAutoCompleteChallenge(userId, criteriaKey);
  }
  return Promise.resolve(null);
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { type, category_id, limit = 50, offset = 0, start_date, end_date } = req.query;
    let query = `
      SELECT t.*, c.name as category_name, c.slug as category_slug,
             c.color as category_color, c.icon as category_icon,
             COALESCE(ba.name, bra.name) as bank_account_name,
             ba_from.name as transfer_from_name,
             ba_to.name as transfer_to_name,
             EXISTS(SELECT 1 FROM transaction_splits ts WHERE ts.transaction_id = t.id) AS has_member_splits
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN bank_accounts ba ON ba.id = t.bank_account_id
      LEFT JOIN brokerage_accounts bra ON bra.id = t.brokerage_account_id
      LEFT JOIN bank_accounts ba_from ON ba_from.id = t.bank_account_id AND t.type = 'transfer'
      LEFT JOIN bank_accounts ba_to ON ba_to.id = t.transfer_to_account_id AND t.type = 'transfer'
      WHERE t.user_id = $1
    `;
    const params = [userId];
    let paramIdx = 2;

    if (type) {
      query += ` AND t.type = $${paramIdx++}`;
      params.push(type);
    }
    if (category_id) {
      query += ` AND t.category_id = $${paramIdx++}`;
      params.push(parseInt(category_id));
    }
    if (start_date) {
      query += ` AND t.transaction_date >= $${paramIdx++}`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND t.transaction_date <= $${paramIdx++}`;
      params.push(end_date);
    }

    query += ` ORDER BY t.transaction_date DESC, t.created_at DESC`;
    query += ` LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Attach allocation snapshots for income transactions and split expenses
    const allocIds = result.rows.filter(t => t.type === 'income' || t.is_split).map(t => t.id);
    let allocMap = {};
    if (allocIds.length > 0) {
      const allocResult = await pool.query(`
        SELECT ta.transaction_id, ta.percentage, ta.amount,
               c.name as category_name, c.slug as category_slug, c.color as category_color
        FROM transaction_allocations ta
        JOIN categories c ON c.id = ta.category_id
        WHERE ta.transaction_id = ANY($1)
        ORDER BY ta.transaction_id, c.sort_order
      `, [allocIds]);
      for (const row of allocResult.rows) {
        if (!allocMap[row.transaction_id]) allocMap[row.transaction_id] = [];
        allocMap[row.transaction_id].push({
          category_name: row.category_name,
          category_slug: row.category_slug,
          category_color: row.category_color,
          percentage: parseFloat(row.percentage),
          amount: row.amount ? parseFloat(row.amount) : null
        });
      }
    }

    const rows = result.rows.map(t => ({
      ...t,
      // Normalize transaction_date to YYYY-MM-DD string (pg returns Date objects for DATE columns)
      transaction_date: t.transaction_date
        ? (t.transaction_date instanceof Date
            ? t.transaction_date.toISOString().split('T')[0]
            : String(t.transaction_date).split('T')[0])
        : null,
      allocations: (t.type === 'income' || t.is_split) ? (allocMap[t.id] || []) : undefined
    }));

    res.json(rows);
  } catch (err) {
    console.error('GET /api/transactions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

router.post('/', requireAuth, async (req, res) => {
  const userId = req.userId;
  const body = req.body || {};
  const { type, description, category_id, subcategory, payment_method, transaction_date, bank_account_id, splits, brokerage_income } = body;
  const amount = sanitizeNumber(body.amount);

  if (!type || !['income', 'expense'].includes(type)) {
    return res.status(400).json({ success: false, error: 'type must be "income" or "expense"' });
  }
  if (!(amount > 0)) {
    return res.status(400).json({ success: false, error: 'Invalid amount' });
  }

  const isSplit = type === 'expense' && Array.isArray(splits) && splits.length > 1;

  if (type === 'expense' && !isSplit && !category_id) {
    return res.status(400).json({ success: false, error: 'category_id required for expenses' });
  }
  if (isSplit) {
    if (splits.some(s => !s.category_id || !(sanitizeNumber(s.amount) > 0))) {
      return res.status(400).json({ success: false, error: 'Each split must have a valid category_id and amount' });
    }
    const splitTotal = splits.reduce((sum, s) => sum + sanitizeNumber(s.amount), 0);
    if (Math.abs(splitTotal - amount) > 0.01) {
      return res.status(400).json({ success: false, error: `Split amounts ($${splitTotal.toFixed(2)}) must equal total ($${amount.toFixed(2)})` });
    }
  }

  const client = await pool.connect();
  let open = false;
  try {
    await client.query("SET statement_timeout = '8000'");
    await client.query('BEGIN');
    open = true;

    // Validate bank account ownership if provided
    if (bank_account_id) {
      const baCheck = await client.query(
        'SELECT id, is_archived FROM bank_accounts WHERE id = $1 AND user_id = $2',
        [parseInt(bank_account_id), userId]
      );
      if (baCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        open = false;
        return res.status(400).json({ success: false, error: 'Bank account not found' });
      }
      if (baCheck.rows[0].is_archived) {
        await client.query('ROLLBACK');
        open = false;
        return res.status(400).json({ success: false, error: 'Cannot tag to an archived bank account' });
      }
    }

    // Create transaction. Older ledgers store dollars in amount; the book schema stores cents.
    const txnCols = await loadTransactionColumns(client);
    const fields = ['user_id', 'type'];
    const values = [userId, type];
    function addTxnColumn(column, value) {
      if (!txnCols[column]) return;
      fields.push(column);
      values.push(value);
    }
    if (txnCols.amount) addTxnColumn('amount', amount);
    if (txnCols.amount_cents) addTxnColumn('amount_cents', Math.round(amount * 100));
    addTxnColumn('description', description || null);
    addTxnColumn('category_id', isSplit ? null : (category_id || null));
    addTxnColumn('subcategory', subcategory || null);
    addTxnColumn('payment_method', payment_method || null);
    const when = transaction_date || new Date().toISOString().split('T')[0];
    addTxnColumn('transaction_date', when);
    if (!txnCols.transaction_date) addTxnColumn('occurred_at', when);
    addTxnColumn('bank_account_id', bank_account_id ? parseInt(bank_account_id, 10) : null);
    addTxnColumn('is_split', !!isSplit);
    const placeholders = values.map(function (_, index) { return '$' + (index + 1); }).join(', ');
    const result = await client.query(
      `INSERT INTO transactions (${fields.join(', ')}) VALUES (${placeholders}) RETURNING *`,
      values
    );

    const transaction = result.rows[0];

    // Update bank account balance if tagged
    if (bank_account_id) {
      const balanceChange = type === 'income' ? amount : -amount;
      await client.query(
        'UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2',
        [balanceChange, parseInt(bank_account_id)]
      );
    }

    // CRITICAL: Snapshot current allocations for this transaction (forward-only logic)
    // This ensures allocation changes never retroactively affect past transactions
    if (type === 'income') {
      if (brokerage_income) {
        // Brokerage income (dividends, interest, deposits): snapshot as 100% Financial Freedom
        // Money already in a brokerage account is already "invested" — no 6-category split needed
        const ffResult = await client.query(
          `SELECT id FROM categories WHERE slug IN ('growth','ff','financial-freedom') OR name ILIKE '%financial freedom%' LIMIT 1`
        );
        if (ffResult.rows.length > 0) {
          await client.query(
            `INSERT INTO transaction_allocations (transaction_id, category_id, percentage) VALUES ($1, $2, $3)`,
            [transaction.id, ffResult.rows[0].id, 100]
          );
        }
        // Temporary allocations are NOT consumed — they remain for the next non-brokerage income
      } else {
        // Normal income: snapshot current allocations (temporary if active, otherwise permanent)
        const allocations = await client.query(`
          SELECT c.id as category_id,
                 COALESCE(ua.percentage, pa.percentage, ac.percentage) as percentage
          FROM categories c
          JOIN allocation_config ac ON ac.category_id = c.id
          LEFT JOIN permanent_allocations pa ON pa.category_id = c.id AND pa.user_id = $1
          LEFT JOIN user_allocations ua ON ua.category_id = c.id AND ua.user_id = $1 AND ua.is_temporary = TRUE
          ORDER BY c.sort_order
        `, [userId]);

        // Snapshot allocations into transaction_allocations
        for (const alloc of allocations.rows) {
          await client.query(
            `INSERT INTO transaction_allocations (transaction_id, category_id, percentage)
             VALUES ($1, $2, $3)`,
            [transaction.id, alloc.category_id, alloc.percentage]
          );
        }

        // If temporary allocations were used, delete them (revert to permanent)
        await client.query(
          `DELETE FROM user_allocations WHERE user_id = $1 AND is_temporary = TRUE`,
          [userId]
        );
      }
    }

    // For split expenses: record each category split with its dollar amount
    if (isSplit) {
      const totalAmount = amount;
      for (const split of splits) {
        const splitAmount = sanitizeNumber(split.amount);
        const splitPercentage = totalAmount > 0 ? (splitAmount / totalAmount * 100) : 0;
        await client.query(
          `INSERT INTO transaction_allocations (transaction_id, category_id, percentage, amount)
           VALUES ($1, $2, $3, $4)`,
          [transaction.id, parseInt(split.category_id), splitPercentage.toFixed(2), splitAmount]
        );
      }
    }

    await client.query('COMMIT');
    open = false;

    // ── Auto-complete transaction-based challenges (fire-and-forget) ──
    // Don't block the response — run in background
    const txUserId = userId;
    setImmediate(async () => {
      try {
        // "Log a transaction" challenge
        await tryAutoCompleteChallenge(txUserId, 'log_transaction');
        // "Log 3 transactions today" challenge
        await tryAutoCompleteChallenge(txUserId, 'log_3_transactions');
        // "Log a bill payment" challenge (if it was an expense)
        if (type === 'expense') {
          await tryAutoCompleteChallenge(txUserId, 'log_bill');
        }
        // Weekly: "Log 15+ transactions this week"
        await tryAutoCompleteChallenge(txUserId, 'log_15_weekly');
        // Monthly: "Log 50+ transactions"
        await tryAutoCompleteChallenge(txUserId, 'monthly_50_logs');
      } catch (e) { console.error('[AutoComplete] post-transaction error:', e.message); }

      // Award 5 TFR Points per transaction (max 10 transactions/day = 50 pts cap on this action)
      try {
        await ensureFgBalance(txUserId);
        const txToday = new Date().toISOString().split('T')[0];
        const txCurrentMonth = txToday.substring(0, 7);
        const txBal = (await pool.query(
          'SELECT daily_txn_points_date, daily_txn_count, monthly_points_earned, monthly_cap_reset_month FROM fg_points_balances WHERE user_id = $1',
          [txUserId]
        )).rows[0] || {};
        const isSameDay = txBal.daily_txn_points_date &&
          String(txBal.daily_txn_points_date).split('T')[0] === txToday;
        const dailyCount = isSameDay ? (parseInt(txBal.daily_txn_count) || 0) : 0;
        if (dailyCount < 10) {
          const monthEarnedTx = txBal.monthly_cap_reset_month === txCurrentMonth
            ? (parseInt(txBal.monthly_points_earned) || 0) : 0;
          const capRemaining = Math.max(0, 5000 - monthEarnedTx);
          const txPts = Math.min(5, capRemaining);
          if (txPts > 0) {
            await pool.query(
              `UPDATE fg_points_balances
               SET balance = balance + $2,
                   total_earned = total_earned + $2,
                   daily_txn_points_date = $3,
                   daily_txn_count = CASE WHEN daily_txn_points_date = $3::date THEN daily_txn_count + 1 ELSE 1 END,
                   monthly_points_earned = CASE WHEN monthly_cap_reset_month = $4 THEN monthly_points_earned + $2 ELSE $2 END,
                   monthly_cap_reset_month = $4,
                   updated_at = NOW()
               WHERE user_id = $1`,
              [txUserId, txPts, txToday, txCurrentMonth]
            );
            await pool.query(
              `INSERT INTO fg_earning_events (user_id, activity_type, description, points)
               VALUES ($1, 'transaction_logged', 'Transaction logged — 5 FACTS Points', $2)`,
              [txUserId, txPts]
            );
          }
          // First transaction achievement (one-time, 25 pts)
          const existingAch = (await pool.query(
            `SELECT id FROM rewards_achievements WHERE user_id = $1 AND achievement_key = 'first_transaction'`,
            [txUserId]
          )).rows[0];
          if (!existingAch) {
            const achMonthEarned = txBal.monthly_cap_reset_month === txCurrentMonth
              ? (parseInt(txBal.monthly_points_earned) || 0) + txPts : txPts;
            const achCapRemaining = Math.max(0, 5000 - achMonthEarned);
            const achPts = Math.min(25, achCapRemaining);
            if (achPts > 0) {
              await pool.query(
                `UPDATE fg_points_balances
                 SET balance = balance + $2,
                     total_earned = total_earned + $2,
                     monthly_points_earned = CASE WHEN monthly_cap_reset_month = $3 THEN monthly_points_earned + $2 ELSE $2 END,
                     monthly_cap_reset_month = $3,
                     updated_at = NOW()
                 WHERE user_id = $1`,
                [txUserId, achPts, txCurrentMonth]
              );
              await pool.query(
                `INSERT INTO fg_earning_events (user_id, activity_type, description, points)
                 VALUES ($1, 'achievement', 'Achievement: First Transaction Logged — 25 FACTS Points', $2)`,
                [txUserId, achPts]
              );
            }
            await pool.query(
              `INSERT INTO rewards_achievements (user_id, achievement_key, points_awarded)
               VALUES ($1, 'first_transaction', $2) ON CONFLICT DO NOTHING`,
              [txUserId, achPts || 0]
            );
          }
        }
      } catch (rpTxErr) {
        console.error('[Rewards] transaction points error:', rpTxErr.message);
      }
    });

    if (!res.headersSent) {
      return res.status(201).json(Object.assign({}, transaction, { success: true }));
    }
  } catch (error) {
    console.error("Transaction Save Error:", error);
    if (open) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) {
        console.error("Transaction Save Error:", rollbackErr);
      }
      open = false;
    }
    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to create transaction'
      });
    }
  } finally {
    if (client) {
      try { await client.query("RESET statement_timeout"); } catch (resetErr) {
        console.error("Transaction Save Error:", resetErr);
      }
      try { client.release(); } catch (releaseErr) {
        console.error("Transaction Save Error:", releaseErr);
      }
    }
  }
});

router.get('/similar', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { description, category_id, exclude_id } = req.query;
    const orClauses = [];
    const params = [userId];
    let idx = 2;
    // Match by normalized description (first 5 words)
    if (description && description.trim()) {
      const term = description.trim().split(/\s+/).slice(0, 5).join(' ').toLowerCase();
      if (term.length >= 2) {
        orClauses.push(`LOWER(COALESCE(description, '')) LIKE $${idx}`);
        params.push(`%${term}%`);
        idx++;
      }
    }
    // Also match by same category
    if (category_id && parseInt(category_id) > 0) {
      orClauses.push(`category_id = $${idx}`);
      params.push(parseInt(category_id));
      idx++;
    }
    if (orClauses.length === 0) return res.json({ transactions: [] });
    let whereClause = `user_id = $1 AND (${orClauses.join(' OR ')})`;
    if (exclude_id && parseInt(exclude_id) > 0) {
      whereClause += ` AND id != $${idx}`;
      params.push(parseInt(exclude_id));
    }
    const result = await pool.query(
      `SELECT id, description, category_id, amount, transaction_date, type, is_split
       FROM transactions WHERE ${whereClause}
       ORDER BY transaction_date DESC LIMIT 200`,
      params
    );
    res.json({ transactions: result.rows });
  } catch (err) {
    console.error('GET /api/transactions/similar error:', err.message);
    res.status(500).json({ error: 'Failed to find similar transactions' });
  }
});

router.get('/export', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;

    // Check Pro access
    const hasPro = await hasProAccess(userId);
    if (!hasPro) {
      return res.status(403).json({
        error: 'CSV export is a paid feature. Please upgrade to access.',
        code: 'PRO_REQUIRED'
      });
    }

    // Parse date filters from query params
    const { start_date, end_date } = req.query;

    // Build query with date filters
    let query = `
      SELECT
        t.transaction_date,
        t.type,
        c.name as category,
        t.subcategory,
        t.amount,
        t.description
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.user_id = $1
    `;

    const params = [userId];

    if (start_date) {
      params.push(start_date);
      query += ` AND t.transaction_date >= $${params.length}`;
    }

    if (end_date) {
      params.push(end_date);
      query += ` AND t.transaction_date <= $${params.length}`;
    }

    query += ` ORDER BY t.transaction_date DESC`;

    const result = await pool.query(query, params);

    // Convert to CSV format
    const csvRows = [];

    // Header row
    csvRows.push('Date,Type,Category,Subcategory,Amount,Description');

    // Data rows
    for (const row of result.rows) {
      const date = row.transaction_date ? new Date(row.transaction_date).toISOString().split('T')[0] : '';
      const type = row.type || '';
      const category = row.category || '';
      const subcategory = row.subcategory || '';
      const amount = row.amount || '0.00';
      // Escape description: wrap in quotes and escape internal quotes
      const description = row.description ? `"${row.description.replace(/"/g, '""')}"` : '';

      csvRows.push(`${date},${type},${category},${subcategory},${amount},${description}`);
    }

    const csvContent = csvRows.join('\n');

    // Set headers for file download
    const filename = `transactions_${new Date().toISOString().split('T')[0]}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    res.send(csvContent);
  } catch (err) {
    console.error('GET /api/transactions/export error:', err.message);
    res.status(500).json({ error: 'Failed to export transactions' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.userId;
    const result = await client.query(
      'DELETE FROM transactions WHERE id = $1 AND user_id = $2 RETURNING *',
      [parseInt(req.params.id), userId]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const deleted = result.rows[0];

    // Reverse bank account balance if transaction was tagged
    if (deleted.bank_account_id) {
      const reversal = deleted.type === 'income' ? -parseFloat(deleted.amount) : parseFloat(deleted.amount);
      await client.query(
        'UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2',
        [reversal, deleted.bank_account_id]
      );
    }

    await client.query('COMMIT');
    res.json({ deleted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE /api/transactions error:', err.message);
    res.status(500).json({ error: 'Failed to delete transaction' });
  } finally {
    client.release();
  }
});

// ─── BULK EDIT TRANSACTIONS (full parity with individual edit) ───
router.put('/bulk', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.userId;
    const { ids, changes } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'ids array required' });
    }
    if (!changes || typeof changes !== 'object') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'changes object required' });
    }
    const idInts = ids.map(Number).filter(n => n > 0 && Number.isInteger(n));
    if (idInts.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No valid transaction IDs provided' });
    }

    // Fetch all transactions with ownership + row lock
    const txnResult = await client.query(
      'SELECT * FROM transactions WHERE id = ANY($1) AND user_id = $2 FOR UPDATE',
      [idInts, userId]
    );
    if (txnResult.rows.length !== idInts.length) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'One or more transactions not found' });
    }
    const transactions = txnResult.rows;

    const INVESTMENT_TYPES = new Set([
      'Investment / Brokerage', 'Retirement – 401(k)', 'Retirement – IRA',
      'Retirement – Roth IRA', 'Retirement – 403(b)', 'Retirement – 457',
      'Crypto – Exchange', 'Crypto – Hot Wallet', 'Crypto – Cold Wallet', 'Crypto – DeFi / On-chain'
    ]);

    // Detect complex changes that require per-transaction processing
    const hasTypeChange = Object.prototype.hasOwnProperty.call(changes, 'type');
    const hasBankChange = Object.prototype.hasOwnProperty.call(changes, 'bank_account_id');
    const hasSplitChange = Array.isArray(changes.split_percentages) && changes.split_percentages.length > 1;
    const isTransfer = hasTypeChange && changes.type === 'transfer';

    // Helper to parse "bank_5" / "brokerage_3" values
    function parseTfVal(val) {
      if (!val) return null;
      const parts = val.split('_');
      return { source: parts[0], id: parseInt(parts.slice(1).join('_')) };
    }

    // Validate transfer accounts upfront
    let tfFrom = null, tfTo = null, tfFromIsInvestment = false, tfToIsInvestment = false;
    if (isTransfer) {
      if (!changes.transfer_from || !changes.transfer_to) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Both source and destination accounts are required for transfers' });
      }
      tfFrom = parseTfVal(changes.transfer_from);
      tfTo = parseTfVal(changes.transfer_to);
      if (!tfFrom || !tfTo) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid transfer account format' });
      }
      if (tfFrom.source === tfTo.source && tfFrom.id === tfTo.id) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot transfer to the same account' });
      }
      const fromTbl = tfFrom.source === 'brokerage' ? 'brokerage_accounts' : 'bank_accounts';
      const toTbl = tfTo.source === 'brokerage' ? 'brokerage_accounts' : 'bank_accounts';
      const fromChk = await client.query(`SELECT id, account_type FROM ${fromTbl} WHERE id = $1 AND user_id = $2`, [tfFrom.id, userId]);
      const toChk = await client.query(`SELECT id, account_type FROM ${toTbl} WHERE id = $1 AND user_id = $2`, [tfTo.id, userId]);
      if (fromChk.rows.length === 0 || toChk.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'One or both transfer accounts not found' });
      }
      tfFromIsInvestment = tfFrom.source === 'brokerage' || INVESTMENT_TYPES.has(fromChk.rows[0].account_type || '');
      tfToIsInvestment = tfTo.source === 'brokerage' || INVESTMENT_TYPES.has(toChk.rows[0].account_type || '');
    }

    // Validate bank account if changing
    if (hasBankChange && changes.bank_account_id) {
      const baId = parseInt(changes.bank_account_id);
      const baChk = await client.query('SELECT id, is_archived FROM bank_accounts WHERE id = $1 AND user_id = $2', [baId, userId]);
      if (baChk.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Bank account not found' }); }
      if (baChk.rows[0].is_archived) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Cannot tag to an archived bank account' }); }
    }

    // Validate split percentages
    if (hasSplitChange) {
      const totalPct = changes.split_percentages.reduce((s, sp) => s + parseFloat(sp.percentage || 0), 0);
      if (Math.abs(totalPct - 100) > 0.01) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Split percentages must total 100%' }); }
      if (changes.split_percentages.some(sp => !sp.category_id || !sp.percentage || parseFloat(sp.percentage) <= 0)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Each split must have category_id and positive percentage' });
      }
    }

    const needsPerTxn = hasTypeChange || hasBankChange || hasSplitChange;

    if (!needsPerTxn) {
      // ─── SIMPLE BATCH UPDATE (category, subcategory, description, payment_method, date) ───
      const allowed = ['category_id', 'subcategory', 'description', 'payment_method', 'transaction_date'];
      const sets = [];
      const params = [];
      let pIdx = 1;
      for (const field of allowed) {
        if (Object.prototype.hasOwnProperty.call(changes, field)) {
          sets.push(`${field} = $${pIdx}`);
          const val = changes[field];
          params.push((val === '' || val === undefined) ? null : val);
          pIdx++;
        }
      }
      if (sets.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      sets.push(`updated_at = NOW()`);
      params.push(idInts);
      params.push(userId);
      await client.query(
        `UPDATE transactions SET ${sets.join(', ')} WHERE id = ANY($${pIdx}) AND user_id = $${pIdx + 1}`,
        params
      );
    } else {
      // ─── PER-TRANSACTION PROCESSING (type/bank/transfer/split changes) ───
      // Pre-fetch allocation config once (for income/investment transfers)
      let allocConfig = null;

      for (const old of transactions) {
        const txnId = old.id;
        const oldAmount = parseFloat(old.amount);
        const newType = hasTypeChange ? changes.type : old.type;

        // Helper: get old date as string
        const oldDateStr = old.transaction_date instanceof Date
          ? old.transaction_date.toISOString().split('T')[0]
          : String(old.transaction_date).split('T')[0];

        // Resolve simple fields (apply changes or keep old)
        const newDate = Object.prototype.hasOwnProperty.call(changes, 'transaction_date') ? changes.transaction_date : oldDateStr;
        const newDesc = Object.prototype.hasOwnProperty.call(changes, 'description') ? (changes.description || null) : old.description;
        const newSub = Object.prototype.hasOwnProperty.call(changes, 'subcategory') ? (changes.subcategory || null) : old.subcategory;
        const newPay = Object.prototype.hasOwnProperty.call(changes, 'payment_method') ? (changes.payment_method || null) : old.payment_method;

        // ── Reverse old balance impact ──
        if (old.bank_account_id && old.type !== 'transfer') {
          const reversal = old.type === 'income' ? -oldAmount : oldAmount;
          await client.query('UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2', [reversal, old.bank_account_id]);
        }
        if (old.type === 'transfer' && old.bank_account_id) {
          await client.query('UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2', [oldAmount, old.bank_account_id]);
          if (old.transfer_to_account_id) {
            await client.query('UPDATE bank_accounts SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2', [oldAmount, old.transfer_to_account_id]);
          }
        }

        if (newType === 'transfer' && isTransfer) {
          // ── TRANSFER ──
          const fromTbl = tfFrom.source === 'brokerage' ? 'brokerage_accounts' : 'bank_accounts';
          const toTbl = tfTo.source === 'brokerage' ? 'brokerage_accounts' : 'bank_accounts';
          const fromBankId = tfFrom.source === 'bank' ? tfFrom.id : null;
          const toBankId = tfTo.source === 'bank' ? tfTo.id : null;

          await client.query(
            `UPDATE transactions SET type = 'transfer', description = $1, category_id = NULL, subcategory = NULL,
             payment_method = NULL, transaction_date = $2, bank_account_id = $3, transfer_to_account_id = $4,
             is_split = FALSE, updated_at = NOW() WHERE id = $5 AND user_id = $6`,
            [newDesc, newDate, fromBankId, toBankId, txnId, userId]
          );

          // Apply transfer balances
          await client.query(`UPDATE ${fromTbl} SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2`, [oldAmount, tfFrom.id]);
          await client.query(`UPDATE ${toTbl} SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2`, [oldAmount, tfTo.id]);

          // Allocations
          await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [txnId]);
          if (tfFromIsInvestment && tfToIsInvestment) {
            const ffCat = await client.query("SELECT id FROM categories WHERE slug IN ('growth','ff','financial-freedom') OR name ILIKE '%financial freedom%' LIMIT 1");
            if (ffCat.rows.length > 0) {
              await client.query('INSERT INTO transaction_allocations (transaction_id, category_id, percentage, amount) VALUES ($1, $2, 100, $3)', [txnId, ffCat.rows[0].id, oldAmount]);
            }
          } else if (tfFromIsInvestment && !tfToIsInvestment) {
            if (!allocConfig) {
              allocConfig = (await client.query(`
                SELECT c.id as category_id, COALESCE(ua.percentage, pa.percentage, ac.percentage) as percentage
                FROM categories c JOIN allocation_config ac ON ac.category_id = c.id
                LEFT JOIN permanent_allocations pa ON pa.category_id = c.id AND pa.user_id = $1
                LEFT JOIN user_allocations ua ON ua.category_id = c.id AND ua.user_id = $1 AND ua.is_temporary = TRUE
                ORDER BY c.sort_order
              `, [userId])).rows;
            }
            for (const alloc of allocConfig) {
              await client.query('INSERT INTO transaction_allocations (transaction_id, category_id, percentage) VALUES ($1, $2, $3)', [txnId, alloc.category_id, alloc.percentage]);
            }
          }

          // Account transfer record
          await client.query(`
            INSERT INTO account_transfers (user_id, from_account_id, to_account_id, amount, description, transfer_date)
            VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING
          `, [userId, tfFrom.id, tfTo.id, oldAmount, newDesc, newDate || new Date().toISOString().split('T')[0]]);

        } else {
          // ── EXPENSE / INCOME ──
          const isSplit = hasSplitChange && newType === 'expense';
          const newCatId = isSplit ? null : (Object.prototype.hasOwnProperty.call(changes, 'category_id') ? (changes.category_id || null) : old.category_id);
          const newBankId = hasBankChange ? (changes.bank_account_id ? parseInt(changes.bank_account_id) : null) : old.bank_account_id;

          await client.query(
            `UPDATE transactions SET type = $1, description = $2, category_id = $3, subcategory = $4,
             payment_method = $5, transaction_date = $6, bank_account_id = $7, is_split = $8,
             transfer_to_account_id = NULL, updated_at = NOW() WHERE id = $9 AND user_id = $10`,
            [newType, newDesc, newCatId, newSub, newPay, newDate, newBankId, isSplit, txnId, userId]
          );

          // Apply new bank balance
          if (newBankId) {
            const balChg = newType === 'income' ? oldAmount : -oldAmount;
            await client.query('UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2', [balChg, newBankId]);
          }

          // Allocation handling
          if (hasTypeChange && newType === 'income' && old.type !== 'income') {
            if (!allocConfig) {
              allocConfig = (await client.query(`
                SELECT c.id as category_id, COALESCE(ua.percentage, pa.percentage, ac.percentage) as percentage
                FROM categories c JOIN allocation_config ac ON ac.category_id = c.id
                LEFT JOIN permanent_allocations pa ON pa.category_id = c.id AND pa.user_id = $1
                LEFT JOIN user_allocations ua ON ua.category_id = c.id AND ua.user_id = $1 AND ua.is_temporary = TRUE
                ORDER BY c.sort_order
              `, [userId])).rows;
            }
            await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [txnId]);
            for (const alloc of allocConfig) {
              await client.query('INSERT INTO transaction_allocations (transaction_id, category_id, percentage) VALUES ($1, $2, $3)', [txnId, alloc.category_id, alloc.percentage]);
            }
          } else if (isSplit) {
            await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [txnId]);
            for (const sp of changes.split_percentages) {
              const spAmt = (oldAmount * parseFloat(sp.percentage) / 100);
              await client.query(
                'INSERT INTO transaction_allocations (transaction_id, category_id, percentage, amount) VALUES ($1, $2, $3, $4)',
                [txnId, parseInt(sp.category_id), parseFloat(sp.percentage), spAmt.toFixed(2)]
              );
            }
          } else if ((hasTypeChange && newType === 'expense' && (old.type === 'income' || old.is_split || old.type === 'transfer'))) {
            await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [txnId]);
          }
        }
      }
    }

    await client.query('COMMIT');
    res.json({ success: true, updated: idInts.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/transactions/bulk error:', err.message);
    res.status(500).json({ error: 'Failed to bulk update transactions' });
  } finally {
    client.release();
  }
});

// ─── EDIT TRANSACTION ───────────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.userId;
    const txnId = parseInt(req.params.id);

    // Fetch existing transaction
    const existing = await client.query(
      'SELECT * FROM transactions WHERE id = $1 AND user_id = $2',
      [txnId, userId]
    );
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found' });
    }
    const old = existing.rows[0];

    const { type, amount, description, category_id, subcategory, payment_method, transaction_date, bank_account_id, brokerage_account_id, splits, transfer_from_account_id, transfer_to_account_id, transfer_from_source, transfer_to_source } = req.body;

    const newType = type !== undefined ? type : old.type;
    if (!['income', 'expense', 'transfer'].includes(newType)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'type must be "income", "expense", or "transfer"' });
    }

    const newAmount = amount !== undefined ? parseFloat(amount) : parseFloat(old.amount);
    if (!newAmount || newAmount <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'amount must be positive' });
    }

    const isSplit = newType === 'expense' && Array.isArray(splits) && splits.length > 1;
    const wasSplit = old.is_split;

    // For split: validate split amounts sum to total
    if (isSplit) {
      if (splits.some(s => !s.category_id || !s.amount || parseFloat(s.amount) <= 0)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Each split must have a valid category_id and amount' });
      }
      const splitTotal = splits.reduce((sum, s) => sum + parseFloat(s.amount), 0);
      if (Math.abs(splitTotal - newAmount) > 0.01) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Split amounts ($${splitTotal.toFixed(2)}) must equal total ($${newAmount.toFixed(2)})` });
      }
    }

    // ─── TRANSFER TYPE HANDLING ─────────────────────────────
    if (newType === 'transfer') {
      const fromAcctId = transfer_from_account_id ? parseInt(transfer_from_account_id) : null;
      const toAcctId = transfer_to_account_id ? parseInt(transfer_to_account_id) : null;
      const fromSrc = transfer_from_source || 'bank';
      const toSrc = transfer_to_source || 'bank';

      if (!fromAcctId || !toAcctId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Both source and destination accounts are required for transfers' });
      }
      if (fromSrc === toSrc && fromAcctId === toAcctId) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot transfer to the same account' });
      }

      const fromTable = fromSrc === 'brokerage' ? 'brokerage_accounts' : 'bank_accounts';
      const toTable = toSrc === 'brokerage' ? 'brokerage_accounts' : 'bank_accounts';

      // Verify both accounts belong to user
      const fromCheck = await client.query(
        `SELECT id, ${fromSrc === 'bank' ? 'is_archived,' : ''} account_type FROM ${fromTable} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [fromAcctId, userId]
      );
      const toCheck = await client.query(
        `SELECT id, ${toSrc === 'bank' ? 'is_archived,' : ''} account_type FROM ${toTable} WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [toAcctId, userId]
      );

      if (fromCheck.rows.length === 0 || toCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'One or both accounts not found' });
      }
      if (fromSrc === 'bank' && fromCheck.rows[0].is_archived) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot transfer from an archived account' });
      }
      if (toSrc === 'bank' && toCheck.rows[0].is_archived) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot transfer to an archived account' });
      }

      const fromAccountType = fromCheck.rows[0].account_type || '';
      const toAccountType = toCheck.rows[0].account_type || '';

      // Investment account types (must match client-side INVESTMENT_ACCOUNT_TYPES)
      const INVESTMENT_TYPES = new Set([
        'Investment / Brokerage', 'Retirement – 401(k)', 'Retirement – IRA',
        'Retirement – Roth IRA', 'Retirement – 403(b)', 'Retirement – 457',
        'Crypto – Exchange', 'Crypto – Hot Wallet', 'Crypto – Cold Wallet', 'Crypto – DeFi / On-chain'
      ]);
      const fromIsInvestment = fromSrc === 'brokerage' || INVESTMENT_TYPES.has(fromAccountType);
      const toIsInvestment = toSrc === 'brokerage' || INVESTMENT_TYPES.has(toAccountType);

      // Reverse old bank account balance impact (if this was previously an expense/income)
      if (old.bank_account_id && old.type !== 'transfer') {
        const reversal = old.type === 'income' ? -parseFloat(old.amount) : parseFloat(old.amount);
        await client.query(
          'UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2',
          [reversal, old.bank_account_id]
        );
      }
      // If old type was transfer, reverse old transfer balance changes
      if (old.type === 'transfer' && old.bank_account_id) {
        await client.query(
          'UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2',
          [parseFloat(old.amount), old.bank_account_id]
        );
        if (old.transfer_to_account_id) {
          await client.query(
            'UPDATE bank_accounts SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2',
            [parseFloat(old.amount), old.transfer_to_account_id]
          );
        }
      }

      // Update transaction record for transfer
      // Only set bank_account_id and transfer_to_account_id if they're bank accounts (FK constraint)
      const fromBankId = fromSrc === 'bank' ? fromAcctId : null;
      const toBankId = toSrc === 'bank' ? toAcctId : null;

      const newDate = transaction_date !== undefined ? transaction_date : (
        old.transaction_date instanceof Date
          ? old.transaction_date.toISOString().split('T')[0]
          : String(old.transaction_date).split('T')[0]
      );
      const result = await client.query(
        `UPDATE transactions
         SET type = 'transfer', amount = $1, description = $2, category_id = NULL, subcategory = NULL,
             payment_method = NULL, transaction_date = $3, bank_account_id = $4, transfer_to_account_id = $5,
             is_split = FALSE, updated_at = NOW()
         WHERE id = $6 AND user_id = $7
         RETURNING *`,
        [newAmount, description !== undefined ? (description || null) : old.description,
         newDate, fromBankId, toBankId, txnId, userId]
      );

      // Apply transfer balance changes: deduct from source, add to destination
      await client.query(
        `UPDATE ${fromTable} SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2`,
        [newAmount, fromAcctId]
      );
      await client.query(
        `UPDATE ${toTable} SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2`,
        [newAmount, toAcctId]
      );

      // Handle allocations based on brokerage transfer rules
      await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [txnId]);

      if (fromIsInvestment && toIsInvestment) {
        // Investment → Investment: auto-categorize as Financial Freedom (100%)
        const ffCat = await client.query("SELECT id FROM categories WHERE slug IN ('growth','ff','financial-freedom') OR name ILIKE '%financial freedom%' LIMIT 1");
        if (ffCat.rows.length > 0) {
          await client.query(
            `INSERT INTO transaction_allocations (transaction_id, category_id, percentage, amount) VALUES ($1, $2, 100, $3)`,
            [txnId, ffCat.rows[0].id, newAmount]
          );
        }
      } else if (fromIsInvestment && !toIsInvestment) {
        // Investment → Non-Investment (withdrawal): triggers 6-category allocation
        const allocations = await client.query(`
          SELECT c.id as category_id,
                 COALESCE(ua.percentage, pa.percentage, ac.percentage) as percentage
          FROM categories c
          JOIN allocation_config ac ON ac.category_id = c.id
          LEFT JOIN permanent_allocations pa ON pa.category_id = c.id AND pa.user_id = $1
          LEFT JOIN user_allocations ua ON ua.category_id = c.id AND ua.user_id = $1 AND ua.is_temporary = TRUE
          ORDER BY c.sort_order
        `, [userId]);
        for (const alloc of allocations.rows) {
          await client.query(
            `INSERT INTO transaction_allocations (transaction_id, category_id, percentage) VALUES ($1, $2, $3)`,
            [txnId, alloc.category_id, alloc.percentage]
          );
        }
      }
      // Non-investment transfers: no allocations needed (they're just account movements)

      // Also create an account_transfers record for history
      const newTransferDate = newDate || new Date().toISOString().split('T')[0];
      await client.query(`
        INSERT INTO account_transfers (user_id, from_account_id, to_account_id, amount, description, transfer_date)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT DO NOTHING
      `, [userId, fromAcctId, toAcctId, newAmount,
          description !== undefined ? (description || null) : old.description, newTransferDate]);

      await client.query('COMMIT');
      return res.json(result.rows[0]);
    }

    // ─── EXPENSE / INCOME HANDLING (existing logic) ─────────

    // Category required for regular expense
    const newCategoryId = isSplit ? null : (category_id !== undefined ? (category_id || null) : old.category_id);
    if (newType === 'expense' && !isSplit && !newCategoryId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'category_id required for expenses' });
    }

    // Resolve new bank account id
    const newBankAccountId = bank_account_id !== undefined
      ? (bank_account_id ? parseInt(bank_account_id) : null)
      : old.bank_account_id;

    // Resolve new brokerage account id
    const newBrokerageAccountId = brokerage_account_id !== undefined
      ? (brokerage_account_id ? parseInt(brokerage_account_id) : null)
      : old.brokerage_account_id;

    // If switching to a brokerage account, clear bank_account_id (and vice versa)
    const finalBankAccountId = newBrokerageAccountId ? null : newBankAccountId;
    const finalBrokerageAccountId = newBankAccountId ? null : newBrokerageAccountId;

    if (finalBankAccountId) {
      const baCheck = await client.query(
        'SELECT id, is_archived FROM bank_accounts WHERE id = $1 AND user_id = $2',
        [finalBankAccountId, userId]
      );
      if (baCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Bank account not found' });
      }
      if (baCheck.rows[0].is_archived) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot tag to an archived bank account' });
      }
    }

    if (finalBrokerageAccountId) {
      const braCheck = await client.query(
        'SELECT id FROM brokerage_accounts WHERE id = $1 AND user_id = $2',
        [finalBrokerageAccountId, userId]
      );
      if (braCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Brokerage account not found' });
      }
    }

    // Reverse old bank account balance impact
    if (old.bank_account_id && old.type !== 'transfer') {
      const reversal = old.type === 'income' ? -parseFloat(old.amount) : parseFloat(old.amount);
      await client.query(
        'UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2',
        [reversal, old.bank_account_id]
      );
    }
    // Reverse old brokerage account balance impact
    if (old.brokerage_account_id && old.type !== 'transfer') {
      const reversal = old.type === 'income' ? -parseFloat(old.amount) : parseFloat(old.amount);
      await client.query(
        'UPDATE brokerage_accounts SET current_balance = current_balance + $1 WHERE id = $2',
        [reversal, old.brokerage_account_id]
      );
    }
    // If old type was transfer, reverse the transfer balance changes
    if (old.type === 'transfer' && old.bank_account_id) {
      await client.query(
        'UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2',
        [parseFloat(old.amount), old.bank_account_id]
      );
      if (old.transfer_to_account_id) {
        await client.query(
          'UPDATE bank_accounts SET current_balance = current_balance - $1, updated_at = NOW() WHERE id = $2',
          [parseFloat(old.amount), old.transfer_to_account_id]
        );
      }
    }

    // Update transaction record
    const newDate = transaction_date !== undefined ? transaction_date : (
      old.transaction_date instanceof Date
        ? old.transaction_date.toISOString().split('T')[0]
        : String(old.transaction_date).split('T')[0]
    );
    const result = await client.query(
      `UPDATE transactions
       SET type = $1, amount = $2, description = $3, category_id = $4, subcategory = $5,
           payment_method = $6, transaction_date = $7, bank_account_id = $8, is_split = $9,
           transfer_to_account_id = NULL, brokerage_account_id = $10, updated_at = NOW()
       WHERE id = $11 AND user_id = $12
       RETURNING *`,
      [
        newType, newAmount,
        description !== undefined ? (description || null) : old.description,
        newCategoryId,
        subcategory !== undefined ? (subcategory || null) : old.subcategory,
        payment_method !== undefined ? (payment_method || null) : old.payment_method,
        newDate, finalBankAccountId, isSplit,
        finalBrokerageAccountId, txnId, userId
      ]
    );

    // Apply new bank account balance impact
    if (finalBankAccountId) {
      const balanceChange = newType === 'income' ? newAmount : -newAmount;
      await client.query(
        'UPDATE bank_accounts SET current_balance = current_balance + $1, updated_at = NOW() WHERE id = $2',
        [balanceChange, finalBankAccountId]
      );
    }
    // Apply new brokerage account balance impact
    if (finalBrokerageAccountId) {
      const balanceChange = newType === 'income' ? newAmount : -newAmount;
      await client.query(
        'UPDATE brokerage_accounts SET current_balance = current_balance + $1 WHERE id = $2',
        [balanceChange, finalBrokerageAccountId]
      );
    }

    // Handle transaction_allocations based on type changes
    if (newType === 'income' && old.type !== 'income') {
      // Changed to income: create fresh allocation snapshot
      const allocations = await client.query(`
        SELECT c.id as category_id,
               COALESCE(ua.percentage, pa.percentage, ac.percentage) as percentage
        FROM categories c
        JOIN allocation_config ac ON ac.category_id = c.id
        LEFT JOIN permanent_allocations pa ON pa.category_id = c.id AND pa.user_id = $1
        LEFT JOIN user_allocations ua ON ua.category_id = c.id AND ua.user_id = $1 AND ua.is_temporary = TRUE
        ORDER BY c.sort_order
      `, [userId]);
      await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [txnId]);
      for (const alloc of allocations.rows) {
        await client.query(
          `INSERT INTO transaction_allocations (transaction_id, category_id, percentage) VALUES ($1, $2, $3)`,
          [txnId, alloc.category_id, alloc.percentage]
        );
      }
    } else if ((newType === 'expense' && !isSplit && (old.type === 'income' || wasSplit)) || old.type === 'transfer') {
      // Changed away from income, split, or transfer → plain expense: remove allocations
      await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [txnId]);
    } else if (isSplit) {
      // Re-write split allocations
      await client.query('DELETE FROM transaction_allocations WHERE transaction_id = $1', [txnId]);
      const totalAmount = newAmount;
      for (const split of splits) {
        const splitAmount = parseFloat(split.amount);
        const splitPercentage = (splitAmount / totalAmount * 100);
        await client.query(
          `INSERT INTO transaction_allocations (transaction_id, category_id, percentage, amount) VALUES ($1, $2, $3, $4)`,
          [txnId, parseInt(split.category_id), splitPercentage.toFixed(2), splitAmount]
        );
      }
    }
    // If income stays income: allocation snapshot percentages unchanged (they auto-scale with new amount)

    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/transactions error:', err.message);
    res.status(500).json({ error: 'Failed to update transaction' });
  } finally {
    client.release();
  }
});

// ─── FIND SIMILAR TRANSACTIONS ──────────────────────────────
// ─── CSV EXPORT (Pro feature) ───────────────────────────────
// POST /api/transactions/:id/tag — update Mine/Theirs/Ours tag
router.post('/:id/tag', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { tag, tagged_member_id } = req.body;

    if (!['mine', 'theirs', 'ours'].includes(tag)) {
      return res.status(400).json({ error: 'tag must be mine, theirs, or ours' });
    }

    // Verify transaction belongs to user
    const txnCheck = await pool.query('SELECT id FROM transactions WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (txnCheck.rows.length === 0) return res.status(403).json({ error: 'Transaction not found or not yours' });

    const memberId = tag === 'theirs' ? (tagged_member_id || null) : null;
    const result = await pool.query(
      'UPDATE transactions SET txn_tag = $1, tagged_member_id = $2 WHERE id = $3 AND user_id = $4 RETURNING *',
      [tag, memberId, id, req.userId]
    );
    res.json({ success: true, transaction: result.rows[0] });
  } catch (err) {
    console.error('POST /api/transactions/:id/tag error:', err.message);
    res.status(500).json({ error: 'Failed to tag transaction' });
  }
});

const INCOME_SOURCES = ['Salary', 'Bonus', 'Dividends', 'Interest', 'Gifts', 'Side Hustle', 'Other'];

// GET /api/income — list income entries for user
incomeRouter.get('/', requireAuth, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const entries = await pool.query(
      `SELECT ie.*,
              json_agg(json_build_object(
                'category_id', ia.category_id,
                'category_name', c.name,
                'category_slug', c.slug,
                'category_color', c.color,
                'amount', ia.amount,
                'percentage', ia.percentage_used
              ) ORDER BY c.sort_order) FILTER (WHERE ia.id IS NOT NULL) as allocations
       FROM income_entries ie
       LEFT JOIN income_allocations ia ON ia.income_entry_id = ie.id
       LEFT JOIN categories c ON c.id = ia.category_id
       WHERE ie.user_id=$1
       GROUP BY ie.id
       ORDER BY ie.entry_date DESC, ie.created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.userId, parseInt(limit), parseInt(offset)]
    );
    res.json({ entries: entries.rows, sources: INCOME_SOURCES });
  } catch (err) {
    console.error('GET /api/income error:', err.message);
    res.status(500).json({ error: 'Failed to fetch income entries' });
  }
});

// POST /api/income/preview — calculate split without saving (for confirmation screen)
incomeRouter.post('/preview', requireAuth, async (req, res) => {
  try {
    const { amount, source = 'Other', date, note } = req.body;
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    const incomeAmt = parseFloat(parseFloat(amount).toFixed(2));

    // Get active allocations for this user
    const allocResult = await pool.query(
      `SELECT c.id, c.name, c.slug, c.color, c.icon, c.sort_order,
              COALESCE(pa.percentage, ac.percentage) as percentage
       FROM categories c
       JOIN allocation_config ac ON ac.category_id = c.id
       LEFT JOIN permanent_allocations pa ON pa.category_id = c.id AND pa.user_id = $1
       WHERE c.is_active IS DISTINCT FROM FALSE
       ORDER BY c.sort_order`,
      [req.userId]
    );

    const splits = allocResult.rows.map(cat => {
      const pct = parseFloat(cat.percentage) || 0;
      return {
        category_id: cat.id,
        category_name: cat.name,
        category_slug: cat.slug,
        category_color: cat.color,
        category_icon: cat.icon,
        percentage: pct,
        amount: parseFloat((incomeAmt * pct / 100).toFixed(2))
      };
    });

    // Ensure splits sum to total (handle rounding by adjusting largest bucket)
    const splitTotal = splits.reduce((s, x) => s + x.amount, 0);
    if (splits.length > 0 && Math.abs(splitTotal - incomeAmt) > 0.001) {
      const maxIdx = splits.reduce((mi, x, i) => x.amount > splits[mi].amount ? i : mi, 0);
      splits[maxIdx].amount = parseFloat((incomeAmt - (splitTotal - splits[maxIdx].amount)).toFixed(2));
    }

    res.json({
      amount: incomeAmt,
      source,
      date: date || new Date().toISOString().split('T')[0],
      note,
      splits,
      total_allocated: splits.reduce((s, x) => s + x.amount, 0)
    });
  } catch (err) {
    console.error('POST /api/income/preview error:', err.message);
    res.status(500).json({ error: 'Failed to calculate income split' });
  }
});

// POST /api/income — confirm and save income entry + all allocations
incomeRouter.post('/', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { amount, source = 'Other', date, note, splits } = req.body;
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    if (!Array.isArray(splits) || splits.length === 0) {
      return res.status(400).json({ error: 'splits array required (use /api/income/preview to generate)' });
    }

    const incomeAmt = parseFloat(parseFloat(amount).toFixed(2));
    const entryDate = date || new Date().toISOString().split('T')[0];
    const validSource = INCOME_SOURCES.includes(source) ? source : 'Other';

    // Validate splits sum
    const splitTotal = splits.reduce((s, x) => s + parseFloat(x.amount), 0);
    if (Math.abs(splitTotal - incomeAmt) > 0.05) {
      return res.status(400).json({ error: `Splits total ${splitTotal.toFixed(2)} doesn't match income ${incomeAmt}` });
    }

    await client.query('BEGIN');

    // Create income_entries record
    const entryRes = await client.query(
      `INSERT INTO income_entries (user_id, amount, source, note, entry_date)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.userId, incomeAmt, validSource, note || null, entryDate]
    );
    const entryId = entryRes.rows[0].id;

    // Create income_allocations + one transaction per bucket
    const savedAllocations = [];
    for (const split of splits) {
      if (!split.category_id || parseFloat(split.amount) <= 0) continue;

      const splitAmt = parseFloat(parseFloat(split.amount).toFixed(2));
      const splitPct = parseFloat(split.percentage) || 0;

      // income_allocations record
      await client.query(
        `INSERT INTO income_allocations (income_entry_id, category_id, amount, percentage_used)
         VALUES ($1, $2, $3, $4)`,
        [entryId, split.category_id, splitAmt, splitPct]
      );


      // Transaction record per bucket (maintains existing balance system)
      const txnRes = await client.query(
        `INSERT INTO transactions (user_id, type, amount, description, category_id, transaction_date, payment_method)
         VALUES ($1, 'income', $2, $3, $4, $5, 'Deposit Directive')
         RETURNING id`,
        [req.userId, splitAmt, `${validSource} - ${split.category_name || 'Bucket'} allocation`, split.category_id, entryDate]
      );

      savedAllocations.push({ category_id: split.category_id, amount: splitAmt, percentage: splitPct });

      // Frozen allocation snapshot for SSC/sweep capacity tracking
      await client.query(
        `INSERT INTO transaction_allocations (transaction_id, category_id, percentage, amount)
         VALUES ($1, $2, $3, $4)`,
        [txnRes.rows[0].id, split.category_id, splitPct, splitAmt]
      );
    }

    // Also record a single summary transaction for reporting
    await client.query(
      `UPDATE users SET updated_at=NOW() WHERE id=$1`,
      [req.userId]
    ).catch(() => {});

    await client.query('COMMIT');

    res.json({
      success: true,
      entry_id: entryId,
      amount: incomeAmt,
      source: validSource,
      date: entryDate,
      allocations: savedAllocations,
      message: `$${incomeAmt.toFixed(2)} split across ${savedAllocations.length} buckets`
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/income error:', err.message);
    res.status(500).json({ error: 'Failed to save income entry' });
  } finally {
    client.release();
  }
});

module.exports = {
  router,
  incomeRouter,
  bindTransactionsRuntime
};
