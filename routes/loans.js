'use strict';

/**
 * Loans (mortgage/auto/student/personal + escrow) and credit cards.
 * Mount:
 *   app.use('/api/loans', router)
 *   app.use('/api/credit-cards', creditCardsRouter)
 */

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');

const router = express.Router();
const creditCardsRouter = express.Router();

// Get all loans
router.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM loans WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json({ loans: result.rows });
  } catch (err) {
    console.error('GET /api/loans error:', err.message);
    res.status(500).json({ error: 'Failed to fetch loans' });
  }
});

// Create loan
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, institution, loan_type, original_amount, current_balance, interest_rate, monthly_payment, start_date, payoff_date, notes,
            has_escrow, escrow_amount, escrow_taxes, escrow_insurance, escrow_pmi, escrow_balance } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const result = await pool.query(
      `INSERT INTO loans (user_id, name, institution, loan_type, original_amount, current_balance, interest_rate, monthly_payment, start_date, payoff_date, notes,
       has_escrow, escrow_amount, escrow_taxes, escrow_insurance, escrow_pmi, escrow_balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [req.userId, name, institution || null, loan_type || 'personal',
       original_amount || null, current_balance || 0, interest_rate || 0,
       monthly_payment || 0, start_date || null, payoff_date || null, notes || null,
       has_escrow || false, escrow_amount || 0, escrow_taxes || 0, escrow_insurance || 0, escrow_pmi || 0, escrow_balance || 0]
    );
    res.json({ loan: result.rows[0] });
  } catch (err) {
    console.error('POST /api/loans error:', err.message);
    res.status(500).json({ error: 'Failed to create loan' });
  }
});

// Update loan
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, institution, loan_type, original_amount, current_balance, interest_rate, monthly_payment, start_date, payoff_date, notes,
            has_escrow, escrow_amount, escrow_taxes, escrow_insurance, escrow_pmi, escrow_balance } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const result = await pool.query(
      `UPDATE loans SET name=$1, institution=$2, loan_type=$3, original_amount=$4, current_balance=$5,
       interest_rate=$6, monthly_payment=$7, start_date=$8, payoff_date=$9, notes=$10,
       has_escrow=$11, escrow_amount=$12, escrow_taxes=$13, escrow_insurance=$14, escrow_pmi=$15, escrow_balance=$16, updated_at=NOW()
       WHERE id=$17 AND user_id=$18 RETURNING *`,
      [name, institution || null, loan_type || 'personal', original_amount || null,
       current_balance || 0, interest_rate || 0, monthly_payment || 0,
       start_date || null, payoff_date || null, notes || null,
       has_escrow || false, escrow_amount || 0, escrow_taxes || 0, escrow_insurance || 0, escrow_pmi || 0, escrow_balance || 0,
       parseInt(req.params.id), req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Loan not found' });
    res.json({ loan: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/loans/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update loan' });
  }
});

// Delete loan
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM loans WHERE id=$1 AND user_id=$2 RETURNING *',
      [parseInt(req.params.id), req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Loan not found' });
    res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /api/loans/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete loan' });
  }
});

// Get all credit cards
creditCardsRouter.get('/', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM credit_cards WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json({ credit_cards: result.rows });
  } catch (err) {
    console.error('GET /api/credit-cards error:', err.message);
    res.status(500).json({ error: 'Failed to fetch credit cards' });
  }
});

// Create credit card
creditCardsRouter.post('/', requireAuth, async (req, res) => {
  try {
    const { name, institution, credit_limit, current_balance, apr, due_date_day, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const result = await pool.query(
      `INSERT INTO credit_cards (user_id, name, institution, credit_limit, current_balance, apr, due_date_day, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.userId, name, institution || null, credit_limit || 0, current_balance || 0,
       apr || 0, due_date_day || null, notes || null]
    );
    res.json({ credit_card: result.rows[0] });
  } catch (err) {
    console.error('POST /api/credit-cards error:', err.message);
    res.status(500).json({ error: 'Failed to create credit card' });
  }
});

// Update credit card
creditCardsRouter.put('/:id', requireAuth, async (req, res) => {
  try {
    const { name, institution, credit_limit, current_balance, apr, due_date_day, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const result = await pool.query(
      `UPDATE credit_cards SET name=$1, institution=$2, credit_limit=$3, current_balance=$4,
       apr=$5, due_date_day=$6, notes=$7, updated_at=NOW()
       WHERE id=$8 AND user_id=$9 RETURNING *`,
      [name, institution || null, credit_limit || 0, current_balance || 0,
       apr || 0, due_date_day || null, notes || null,
       parseInt(req.params.id), req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Credit card not found' });
    res.json({ credit_card: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/credit-cards/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update credit card' });
  }
});

// Delete credit card
creditCardsRouter.delete('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM credit_cards WHERE id=$1 AND user_id=$2 RETURNING *',
      [parseInt(req.params.id), req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Credit card not found' });
    res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /api/credit-cards/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete credit card' });
  }
});

module.exports = {
  router,
  creditCardsRouter
};
