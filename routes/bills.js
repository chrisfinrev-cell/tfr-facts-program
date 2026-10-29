'use strict';

/**
 * Recurring bill tracking.
 * Mount: app.use('/api/bills', router)
 */

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(`
      SELECT
        b.*,
        c.name as category_name,
        c.color as category_color
      FROM recurring_bills b
      LEFT JOIN categories c ON b.category_id = c.id
      WHERE b.user_id = $1
      ORDER BY b.due_day ASC
    `, [userId]);
    res.json({ bills: result.rows });
  } catch (err) {
    console.error('GET /api/bills error:', err.message);
    res.status(500).json({ error: 'Failed to fetch bills' });
  }
});

// Create new recurring bill
router.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { name, amount, due_day, frequency, category_id, account_id, notes } = req.body;

    if (!name || !amount || !due_day || !frequency) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Try with account_id column, fall back without if column doesn't exist yet
    try {
      const result = await pool.query(`
        INSERT INTO recurring_bills (user_id, name, amount, due_day, frequency, category_id, account_id, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [userId, name, amount, due_day, frequency, category_id || null, account_id || null, notes || null]);
      return res.json({ bill: result.rows[0] });
    } catch (colErr) {
      // Column might not exist yet — fall back to original schema
      const result = await pool.query(`
        INSERT INTO recurring_bills (user_id, name, amount, due_day, frequency, category_id, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `, [userId, name, amount, due_day, frequency, category_id || null, notes || null]);
      return res.json({ bill: result.rows[0] });
    }
  } catch (err) {
    console.error('POST /api/bills error:', err.message);
    res.status(500).json({ error: 'Failed to create bill' });
  }
});

// Update recurring bill
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { name, amount, due_day, frequency, category_id, notes } = req.body;

    const result = await pool.query(`
      UPDATE recurring_bills
      SET name = $1, amount = $2, due_day = $3, frequency = $4,
          category_id = $5, notes = $6, updated_at = NOW()
      WHERE id = $7 AND user_id = $8
      RETURNING *
    `, [name, amount, due_day, frequency, category_id || null, notes || null,
        parseInt(req.params.id), userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    res.json({ bill: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/bills error:', err.message);
    res.status(500).json({ error: 'Failed to update bill' });
  }
});

// Toggle paid status — when marking paid, also create an expense transaction
router.patch('/:id/toggle-paid', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(`
      UPDATE recurring_bills
      SET is_paid = NOT is_paid, updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING *
    `, [parseInt(req.params.id), userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }

    const bill = result.rows[0];

    // If bill was just marked as PAID, create an expense transaction
    if (bill.is_paid) {
      try {
        await pool.query(`
          INSERT INTO transactions (user_id, type, amount, description, category_id, date, payment_method, account_id)
          VALUES ($1, 'expense', $2, $3, $4, CURRENT_DATE, 'bill_payment', $5)
        `, [userId, bill.amount, `Bill payment: ${bill.name}`, bill.category_id || null, bill.account_id || null]);
      } catch (txnErr) {
        console.error('Failed to create bill payment transaction:', txnErr.message);
        // Non-fatal: bill status already updated
      }
    }

    res.json({ bill });
  } catch (err) {
    console.error('PATCH /api/bills/:id/toggle-paid error:', err.message);
    res.status(500).json({ error: 'Failed to toggle bill status' });
  }
});

// Delete recurring bill
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const result = await pool.query(
      'DELETE FROM recurring_bills WHERE id = $1 AND user_id = $2 RETURNING *',
      [parseInt(req.params.id), userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Bill not found' });
    }
    res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /api/bills error:', err.message);
    res.status(500).json({ error: 'Failed to delete bill' });
  }
});

module.exports = { router };
