'use strict';

/**
 * Debt reduction: CRUD, Snowball/Avalanche schedules, spending-gap tips.
 * Mount at /api/debts so existing clients keep working
 * (bare /api/debt would break public/app.html).
 */

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');

const router = express.Router();

const runtime = {};
function bindDebtRuntime(helpers) {
  Object.assign(runtime, helpers || {});
}

function hasProAccess(userOrId) {
  if (typeof runtime.hasProAccess === 'function') return runtime.hasProAccess(userOrId);
  return Promise.resolve(false);
}

/**
 * Calculate debt payoff schedule for a given strategy
 * @param {Array} debts - List of debt objects
 * @param {Number} extraPayment - Extra monthly payment to apply
 * @param {String} strategy - 'minimum', 'current', 'snowball', or 'avalanche'
 * @returns {Object} - { months, totalPaid, totalInterest, schedule }
 */
function calculatePayoffSchedule(debts, extraPayment, strategy) {
  // Clone debts to avoid mutation
  let debtList = debts.map(d => ({
    id: d.id,
    name: d.name,
    balance: parseFloat(d.balance),
    rate: parseFloat(d.interest_rate) / 100 / 12, // Monthly rate
    minPayment: parseFloat(d.minimum_payment),
    currentPayment: d.current_payment ? parseFloat(d.current_payment) : parseFloat(d.minimum_payment)
  }));

  // Sort based on strategy
  if (strategy === 'snowball') {
    debtList.sort((a, b) => a.balance - b.balance);
  } else if (strategy === 'avalanche') {
    debtList.sort((a, b) => b.rate - a.rate);
  }

  let month = 0;
  let totalPaid = 0;
  let totalInterest = 0;
  const schedule = [];
  const MAX_MONTHS = 600; // 50 years max to prevent infinite loops

  while (debtList.some(d => d.balance > 0) && month < MAX_MONTHS) {
    month++;
    let monthlyInterest = 0;
    let monthlyPrincipal = 0;

    // Calculate interest for all debts
    debtList.forEach(debt => {
      if (debt.balance > 0) {
        const interest = debt.balance * debt.rate;
        debt.balance += interest;
        monthlyInterest += interest;
      }
    });

    // Determine total payment for this month
    let availablePayment = 0;
    if (strategy === 'minimum') {
      availablePayment = debtList.reduce((sum, d) => sum + (d.balance > 0 ? d.minPayment : 0), 0);
    } else if (strategy === 'current') {
      availablePayment = debtList.reduce((sum, d) => sum + (d.balance > 0 ? d.currentPayment : 0), 0);
    } else {
      // Snowball/avalanche: minimum on all debts + extra on target
      availablePayment = debtList.reduce((sum, d) => sum + (d.balance > 0 ? d.minPayment : 0), 0) + extraPayment;
    }

    // Apply payments
    if (strategy === 'minimum' || strategy === 'current') {
      // Each debt gets its designated payment
      debtList.forEach(debt => {
        if (debt.balance > 0) {
          const payment = strategy === 'minimum' ? debt.minPayment : debt.currentPayment;
          const paid = Math.min(payment, debt.balance);
          debt.balance -= paid;
          monthlyPrincipal += paid;
        }
      });
    } else {
      // Snowball/Avalanche: pay minimums first, then attack target with extra
      debtList.forEach(debt => {
        if (debt.balance > 0) {
          const paid = Math.min(debt.minPayment, debt.balance);
          debt.balance -= paid;
          monthlyPrincipal += paid;
          availablePayment -= paid;
        }
      });

      // Apply extra payment to first debt with balance (already sorted)
      const targetDebt = debtList.find(d => d.balance > 0);
      if (targetDebt && availablePayment > 0) {
        const extraPaid = Math.min(availablePayment, targetDebt.balance);
        targetDebt.balance -= extraPaid;
        monthlyPrincipal += extraPaid;
      }
    }

    totalPaid += monthlyPrincipal + monthlyInterest;
    totalInterest += monthlyInterest;

    // Snapshot for timeline
    if (month % 6 === 0 || !debtList.some(d => d.balance > 0)) {
      schedule.push({
        month,
        totalBalance: debtList.reduce((sum, d) => sum + d.balance, 0),
        totalPaid,
        totalInterest
      });
    }
  }

  // Handle case where debts couldn't be paid off
  if (month >= MAX_MONTHS) {
    return {
      months: MAX_MONTHS,
      totalPaid: totalPaid,
      totalInterest: totalInterest,
      schedule: schedule,
      warning: 'Unable to pay off debt with current payment plan (exceeds 50 years)'
    };
  }

  return {
    months: month,
    totalPaid: Math.round(totalPaid * 100) / 100,
    totalInterest: Math.round(totalInterest * 100) / 100,
    schedule: schedule
  };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    // Check Pro access
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) {
      return res.status(403).json({
        error: 'Debt Reduction Calculator is a paid feature. Please upgrade to access.',
        code: 'PRO_REQUIRED'
      });
    }

    const userId = req.userId;
    const result = await pool.query(`
      SELECT *
      FROM debts
      WHERE user_id = $1
      ORDER BY interest_rate DESC, balance DESC
    `, [userId]);
    res.json({ debts: result.rows });
  } catch (err) {
    console.error('GET /api/debts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch debts' });
  }
});

// Create new debt
router.post('/', requireAuth, async (req, res) => {
  try {
    // Check Pro access
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) {
      return res.status(403).json({
        error: 'Debt Reduction Calculator is a paid feature. Please upgrade to access.',
        code: 'PRO_REQUIRED'
      });
    }

    const userId = req.userId;
    const { name, balance, interest_rate, minimum_payment, current_payment, notes } = req.body;

    if (!name || balance == null || interest_rate == null || minimum_payment == null) {
      return res.status(400).json({ error: 'Missing required fields: name, balance, interest_rate, minimum_payment' });
    }

    if (balance < 0 || interest_rate < 0 || minimum_payment < 0) {
      return res.status(400).json({ error: 'Balance, interest rate, and minimum payment must be non-negative' });
    }

    if (current_payment != null && current_payment < minimum_payment) {
      return res.status(400).json({ error: 'Current payment cannot be less than minimum payment' });
    }

    const result = await pool.query(`
      INSERT INTO debts (user_id, name, balance, interest_rate, minimum_payment, current_payment, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [userId, name, balance, interest_rate, minimum_payment, current_payment || null, notes || null]);

    res.json({ debt: result.rows[0] });
  } catch (err) {
    console.error('POST /api/debts error:', err.message);
    res.status(500).json({ error: 'Failed to create debt' });
  }
});

// Update debt
router.post('/calculate-strategies', requireAuth, async (req, res) => {
  try {
    // Check Pro access
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) {
      return res.status(403).json({
        error: 'Debt Reduction Calculator is a paid feature. Please upgrade to access.',
        code: 'PRO_REQUIRED'
      });
    }

    const userId = req.userId;
    const { extra_monthly_payment } = req.body;

    // Fetch user's debts
    const result = await pool.query(`
      SELECT id, name, balance, interest_rate, minimum_payment, current_payment
      FROM debts
      WHERE user_id = $1 AND balance > 0
      ORDER BY id
    `, [userId]);

    const debts = result.rows;

    if (debts.length === 0) {
      return res.json({
        strategies: {},
        message: 'No debts to calculate'
      });
    }

    const extraPayment = parseFloat(extra_monthly_payment) || 0;

    // Calculate 4 strategies:
    // 1. Minimum payments only
    // 2. Current payments (user's custom payments)
    // 3. Snowball (lowest balance first)
    // 4. Avalanche (highest interest rate first)

    const strategies = {
      minimum: calculatePayoffSchedule(debts, 0, 'minimum'),
      current: calculatePayoffSchedule(debts, 0, 'current'),
      snowball: calculatePayoffSchedule(debts, extraPayment, 'snowball'),
      avalanche: calculatePayoffSchedule(debts, extraPayment, 'avalanche')
    };

    res.json({ strategies });
  } catch (err) {
    console.error('POST /api/debts/calculate-strategies error:', err.message);
    res.status(500).json({ error: 'Failed to calculate strategies' });
  }
});

router.post('/personalized-tips', requireAuth, async (req, res) => {
  try {
    // Check Pro access
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) {
      return res.status(403).json({
        error: 'Debt Reduction Calculator is a paid feature. Please upgrade to access.',
        code: 'PRO_REQUIRED'
      });
    }

    const userId = req.userId;
    const { debts, strategies } = req.body; // Receive debts and calculated strategies from frontend

    // Validate input
    if (!debts || !strategies) {
      return res.status(400).json({ error: 'Missing required data' });
    }

    // If no debts, no tips needed
    if (debts.length === 0) {
      return res.json({ tips: [] });
    }

    const tips = [];

    // 1. INCOME ANALYSIS (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const incomeResult = await pool.query(`
      SELECT SUM(amount) as total_income, COUNT(*) as income_count
      FROM transactions
      WHERE user_id = $1
        AND type = 'income'
        AND transaction_date >= $2
    `, [userId, sixMonthsAgo.toISOString().split('T')[0]]);

    const totalIncome = parseFloat(incomeResult.rows[0]?.total_income || 0);
    const incomeCount = parseInt(incomeResult.rows[0]?.income_count || 0);
    const avgMonthlyIncome = incomeCount > 0 ? totalIncome / 6 : 0;

    // Check for income trend (last 3 months vs previous 3 months)
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
    const recentIncomeResult = await pool.query(`
      SELECT SUM(amount) as recent_income
      FROM transactions
      WHERE user_id = $1
        AND type = 'income'
        AND transaction_date >= $2
    `, [userId, threeMonthsAgo.toISOString().split('T')[0]]);

    const previousIncomeResult = await pool.query(`
      SELECT SUM(amount) as previous_income
      FROM transactions
      WHERE user_id = $1
        AND type = 'income'
        AND transaction_date >= $2
        AND transaction_date < $3
    `, [userId, sixMonthsAgo.toISOString().split('T')[0], threeMonthsAgo.toISOString().split('T')[0]]);

    const recentIncome = parseFloat(recentIncomeResult.rows[0]?.recent_income || 0);
    const previousIncome = parseFloat(previousIncomeResult.rows[0]?.previous_income || 0);

    // 2. SPENDING ANALYSIS BY CATEGORY
    const expenseResult = await pool.query(`
      SELECT c.name as category_name, c.slug, SUM(t.amount) as total_spent
      FROM transactions t
      JOIN categories c ON c.id = t.category_id
      WHERE t.user_id = $1
        AND t.type = 'expense'
        AND t.transaction_date >= $2
      GROUP BY c.id, c.name, c.slug
    `, [userId, sixMonthsAgo.toISOString().split('T')[0]]);

    const totalExpenses = expenseResult.rows.reduce((sum, row) => sum + parseFloat(row.total_spent), 0);

    // 3. GET USER'S ALLOCATION TARGETS
    const allocationsResult = await pool.query(`
      SELECT c.name as category_name, c.slug, ua.percentage
      FROM user_allocations ua
      JOIN categories c ON c.id = ua.category_id
      WHERE ua.user_id = $1
    `, [userId]);

    const userAllocations = {};
    allocationsResult.rows.forEach(row => {
      userAllocations[row.slug] = {
        name: row.category_name,
        target: parseFloat(row.percentage)
      };
    });

    // If user has no allocations set, use defaults
    if (allocationsResult.rows.length === 0) {
      const defaultAllocations = await pool.query(`SELECT name, slug, default_percentage FROM categories`);
      defaultAllocations.rows.forEach(row => {
        userAllocations[row.slug] = {
          name: row.name,
          target: parseFloat(row.default_percentage)
        };
      });
    }

    // 4. CALCULATE ACTUAL SPENDING PERCENTAGES
    const actualSpending = {};
    expenseResult.rows.forEach(row => {
      const percentage = totalExpenses > 0 ? (parseFloat(row.total_spent) / totalExpenses) * 100 : 0;
      actualSpending[row.slug] = {
        name: row.category_name,
        actual: percentage,
        amount: parseFloat(row.total_spent) / 6 // Monthly average
      };
    });

    // 5. GENERATE TIPS BASED ON GAPS

    // Tip: Income increase
    if (previousIncome > 0 && recentIncome > previousIncome) {
      const incomeIncrease = ((recentIncome - previousIncome) / previousIncome) * 100;
      const extraPerMonth = (recentIncome - previousIncome) / 3; // Monthly average increase

      if (extraPerMonth > 50 && debts.length > 0) {
        // Calculate impact of applying this extra income to debt
        const currentMonths = strategies.current?.months || strategies.minimum?.months || 0;
        const avalancheMonths = strategies.avalanche?.months || 0;

        // Estimate new payoff with extra payment (simplified - using avalanche as best case)
        const projectedMonthsSaved = Math.round(currentMonths * 0.1); // Conservative 10% reduction estimate
        const interestSaved = (strategies.current?.totalInterest || 0) - (strategies.avalanche?.totalInterest || 0);

        tips.push({
          type: 'income_increase',
          icon: '📈',
          title: 'Your Income is Growing!',
          message: `Your income increased ${incomeIncrease.toFixed(0)}% over the last 3 months. Applying the extra $${extraPerMonth.toFixed(0)}/mo to your highest-interest debt using avalanche method could save you ${projectedMonthsSaved} months and $${interestSaved.toFixed(0)} in interest.`,
          impact: 'high'
        });
      }
    }

    // Tip: Spending vs allocation gaps
    Object.keys(actualSpending).forEach(slug => {
      const target = userAllocations[slug]?.target || 0;
      const actual = actualSpending[slug].actual;
      const monthlyAmount = actualSpending[slug].amount;
      const gap = actual - target;

      // Only generate tips for categories that are significantly over target (>5 percentage points)
      if (gap > 5 && monthlyAmount > 100) {
        const excessAmount = (gap / 100) * (totalExpenses / 6); // Monthly excess

        // Calculate impact on debt payoff
        const currentMonths = strategies.current?.months || strategies.minimum?.months || 0;
        const currentInterest = strategies.current?.totalInterest || strategies.minimum?.totalInterest || 0;

        // Estimate impact of redirecting half the excess (conservative)
        const redirectAmount = excessAmount / 2;
        const monthsSaved = Math.max(1, Math.round(currentMonths * (redirectAmount / (totalExpenses / 6)) * 0.5)); // Conservative estimate
        const interestSaved = Math.max(50, Math.round(currentInterest * (redirectAmount / (totalExpenses / 6)) * 0.3)); // Conservative estimate

        tips.push({
          type: 'spending_gap',
          icon: '💡',
          title: `${actualSpending[slug].name} Spending Above Target`,
          message: `You're spending ${actual.toFixed(0)}% on ${actualSpending[slug].name} vs your ${target.toFixed(0)}% target. Redirecting half of that excess ($${redirectAmount.toFixed(0)}/mo) to your highest-interest debt could save ${monthsSaved} months and $${interestSaved.toFixed(0)} in interest.`,
          impact: gap > 15 ? 'high' : 'medium'
        });
      }
    });

    // Tip: Strategy comparison (if avalanche is significantly better than current)
    if (strategies.avalanche && strategies.current) {
      const monthsSaved = strategies.current.months - strategies.avalanche.months;
      const interestSaved = strategies.current.totalInterest - strategies.avalanche.totalInterest;

      if (monthsSaved > 6 || interestSaved > 500) {
        tips.push({
          type: 'strategy_optimization',
          icon: '⚡',
          title: 'Optimize Your Debt Strategy',
          message: `Switching from your current payment plan to the avalanche method (paying highest-interest debts first) would save you ${monthsSaved} months and $${interestSaved.toFixed(0)} in interest. No extra money needed—just redirect what you're already paying!`,
          impact: 'high'
        });
      }
    }

    // If no tips generated and user has income/expense data, provide encouragement
    if (tips.length === 0 && (incomeCount > 0 || totalExpenses > 0)) {
      tips.push({
        type: 'encouragement',
        icon: '✅',
        title: 'You\'re On Track!',
        message: 'Your spending aligns well with your allocation targets. Keep up the great work! Continue making your current payments and you\'ll be debt-free on schedule.',
        impact: 'low'
      });
    }

    // If no transaction data at all
    if (incomeCount === 0 && totalExpenses === 0) {
      tips.push({
        type: 'no_data',
        icon: 'ℹ️',
        title: 'Add Transactions for Personalized Tips',
        message: 'Start tracking your income and expenses in the Transactions tab to get personalized debt payoff tips based on your actual spending habits.',
        impact: 'low'
      });
    }

    res.json({ tips });
  } catch (err) {
    console.error('POST /api/debts/personalized-tips error:', err.message);
    res.status(500).json({ error: 'Failed to generate personalized tips' });
  }
});

router.put('/:id', requireAuth, async (req, res) => {
  try {
    // Check Pro access
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) {
      return res.status(403).json({
        error: 'Debt Reduction Calculator is a paid feature. Please upgrade to access.',
        code: 'PRO_REQUIRED'
      });
    }

    const userId = req.userId;
    const { name, balance, interest_rate, minimum_payment, current_payment, notes } = req.body;

    if (!name || balance == null || interest_rate == null || minimum_payment == null) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (balance < 0 || interest_rate < 0 || minimum_payment < 0) {
      return res.status(400).json({ error: 'Values must be non-negative' });
    }

    if (current_payment != null && current_payment < minimum_payment) {
      return res.status(400).json({ error: 'Current payment cannot be less than minimum payment' });
    }

    const result = await pool.query(`
      UPDATE debts
      SET name = $1, balance = $2, interest_rate = $3, minimum_payment = $4,
          current_payment = $5, notes = $6, updated_at = NOW()
      WHERE id = $7 AND user_id = $8
      RETURNING *
    `, [name, balance, interest_rate, minimum_payment, current_payment || null, notes || null,
        parseInt(req.params.id), userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Debt not found' });
    }

    res.json({ debt: result.rows[0] });
  } catch (err) {
    console.error('PUT /api/debts error:', err.message);
    res.status(500).json({ error: 'Failed to update debt' });
  }
});

// Delete debt
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    // Check Pro access
    const hasPro = await hasProAccess(req.userId);
    if (!hasPro) {
      return res.status(403).json({
        error: 'Debt Reduction Calculator is a paid feature. Please upgrade to access.',
        code: 'PRO_REQUIRED'
      });
    }

    const userId = req.userId;
    const result = await pool.query(
      'DELETE FROM debts WHERE id = $1 AND user_id = $2 RETURNING *',
      [parseInt(req.params.id), userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Debt not found' });
    }
    res.json({ deleted: result.rows[0] });
  } catch (err) {
    console.error('DELETE /api/debts error:', err.message);
    res.status(500).json({ error: 'Failed to delete debt' });
  }
});

// Calculate debt payoff strategies
// Get personalized debt adjustment tips
module.exports = {
  router,
  bindDebtRuntime,
  calculatePayoffSchedule
};
