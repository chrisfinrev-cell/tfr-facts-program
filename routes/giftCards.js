'use strict';

/**
 * Gift card wallet tracking.
 * Mount: app.use('/api/gift-cards', router)
 */

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');

const router = express.Router();

// ═══════════════════════════════════════════════════════════
// ─── GIFT CARD WALLET ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════

// Get all gift cards for user
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const showArchived = req.query.show_archived === 'true';

    let query = `
      SELECT gc.*,
        COALESCE(
          (SELECT SUM(gct.amount) FROM gift_card_transactions gct WHERE gct.gift_card_id = gc.id),
          0
        ) as total_spent,
        (SELECT COUNT(*) FROM gift_card_transactions gct WHERE gct.gift_card_id = gc.id) as transaction_count
      FROM gift_cards gc
      WHERE gc.user_id = $1
    `;

    if (!showArchived) {
      query += ` AND gc.is_archived = FALSE`;
    }

    query += ` ORDER BY gc.is_archived ASC, gc.created_at DESC`;

    const result = await pool.query(query, [userId]);
    res.json({ gift_cards: result.rows });
  } catch (err) {
    console.error('GET /api/gift-cards error:', err.message);
    res.status(500).json({ error: 'Failed to fetch gift cards' });
  }
});

// Create new gift card
router.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { name, initial_balance, notes } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Gift card name is required' });
    }
    if (!initial_balance || parseFloat(initial_balance) <= 0) {
      return res.status(400).json({ error: 'Initial balance must be positive' });
    }

    const balance = parseFloat(initial_balance);

    const result = await pool.query(`
      INSERT INTO gift_cards (user_id, name, initial_balance, current_balance, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [userId, name.trim(), balance, balance, notes || null]);

    res.json({ gift_card: result.rows[0] });
  } catch (err) {
    console.error('POST /api/gift-cards error:', err.message);
    res.status(500).json({ error: 'Failed to create gift card' });
  }
});

// Update gift card (name, notes only — balance is managed by transactions)
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { name, notes } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Gift card name is required' });
    }

    const result = await pool.query(`
      UPDATE gift_cards
      SET name = $1, notes = $2, updated_at = NOW()
      WHERE id = $3 AND user_id = $4
      RETURNING *
    `, [name.trim(), notes || null, parseInt(req.params.id), userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gift card not found' });
    }

    res.json({ gift_card: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/gift-cards error:', err.message);
    res.status(500).json({ error: 'Failed to update gift card' });
  }
});

// Archive/unarchive gift card
router.patch('/:id/archive', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(`
      UPDATE gift_cards
      SET is_archived = NOT is_archived, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `, [parseInt(req.params.id), userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gift card not found' });
    }

    res.json({ gift_card: result.rows[0] });
  } catch (err) {
    console.error('PATCH /api/gift-cards/:id/archive error:', err.message);
    res.status(500).json({ error: 'Failed to toggle archive status' });
  }
});

// Delete gift card
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;

    // Check if gift card has remaining balance
    const check = await pool.query(
      'SELECT current_balance FROM gift_cards WHERE id = $1 AND user_id = $2',
      [parseInt(req.params.id), userId]
    );

    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Gift card not found' });
    }

    const result = await pool.query(
      'DELETE FROM gift_cards WHERE id = $1 AND user_id = $2 RETURNING *',
      [parseInt(req.params.id), userId]
    );

    res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /api/gift-cards error:', err.message);
    res.status(500).json({ error: 'Failed to delete gift card' });
  }
});

// Spend from gift card — this does NOT create a real expense (prevents double-dip)
router.post('/:id/spend', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userId = req.userId;
    const giftCardId = parseInt(req.params.id);
    const { amount, description, transaction_date } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const spendAmount = parseFloat(amount);

    // Get gift card and verify ownership
    const gcResult = await client.query(
      'SELECT * FROM gift_cards WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [giftCardId, userId]
    );

    if (gcResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Gift card not found' });
    }

    const gc = gcResult.rows[0];

    if (gc.is_archived) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot spend from an archived gift card' });
    }

    if (spendAmount > parseFloat(gc.current_balance)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient balance. Available: $${parseFloat(gc.current_balance).toFixed(2)}`
      });
    }

    // Create gift card transaction (NOT a real expense — the expense was recorded when the card was purchased)
    const gctResult = await client.query(`
      INSERT INTO gift_card_transactions (gift_card_id, user_id, amount, description, transaction_date)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [giftCardId, userId, spendAmount, description || null,
        transaction_date || new Date().toISOString().split('T')[0]]);

    // Deduct from gift card balance
    const newBalance = parseFloat(gc.current_balance) - spendAmount;
    await client.query(`
      UPDATE gift_cards
      SET current_balance = $1, updated_at = NOW()
      WHERE id = $2
    `, [newBalance, giftCardId]);

    await client.query('COMMIT');

    res.json({
      transaction: gctResult.rows[0],
      new_balance: newBalance,
      gift_card_name: gc.name
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /api/gift-cards/:id/spend error:', err.message);
    res.status(500).json({ error: 'Failed to record gift card spending' });
  } finally {
    client.release();
  }
});

// Get spending history for a gift card
router.get('/:id/transactions', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const giftCardId = parseInt(req.params.id);

    // Verify ownership
    const gcCheck = await pool.query(
      'SELECT id FROM gift_cards WHERE id = $1 AND user_id = $2',
      [giftCardId, userId]
    );

    if (gcCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Gift card not found' });
    }

    const result = await pool.query(`
      SELECT * FROM gift_card_transactions
      WHERE gift_card_id = $1 AND user_id = $2
      ORDER BY transaction_date DESC, created_at DESC
    `, [giftCardId, userId]);

    res.json({ transactions: result.rows });
  } catch (err) {
    console.error('GET /api/gift-cards/:id/transactions error:', err.message);
    res.status(500).json({ error: 'Failed to fetch gift card transactions' });
  }
});

// Add balance to gift card (e.g., received as a gift, or reload)
router.post('/:id/add-balance', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const giftCardId = parseInt(req.params.id);
    const { amount } = req.body;

    if (!amount || parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const addAmount = parseFloat(amount);

    const result = await pool.query(`
      UPDATE gift_cards
      SET current_balance = current_balance + $1,
          initial_balance = initial_balance + $1,
          updated_at = NOW()
      WHERE id = $2 AND user_id = $3
      RETURNING *
    `, [addAmount, giftCardId, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Gift card not found' });
    }

    res.json({ gift_card: result.rows[0] });
  } catch (err) {
    console.error('POST /api/gift-cards/:id/add-balance error:', err.message);
    res.status(500).json({ error: 'Failed to add balance' });
  }
});

module.exports = { router };
