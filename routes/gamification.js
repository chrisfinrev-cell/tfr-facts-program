'use strict';

/**
 * TFR Points, engagement streaks/challenges, rewards, Future Generations points.
 * Mount (URL-preserving):
 *   app.use('/api/tfr', tfrRouter)
 *   app.use('/api/engagement', engagementRouter)
 *   app.use('/api/rewards', rewardsRouter)
 *   app.use('/api/future-generations', futureGenerationsRouter)
 *   app.use(pageRouter)  // /sovereign, /rewards, /future-generations, etc.
 */

const express = require('express');
const path = require('path');
const { pool } = require('../db/pool');
const { requireAuth, optionalAuth } = require('./auth');

const tfrRouter = express.Router();
const engagementRouter = express.Router();
const rewardsRouter = express.Router();
const futureGenerationsRouter = express.Router();
const pageRouter = express.Router();

const runtime = {};
function bindGamificationRuntime(helpers) {
  Object.assign(runtime, helpers || {});
}

function hasProAccess(userOrId) {
  if (typeof runtime.hasProAccess === 'function') return runtime.hasProAccess(userOrId);
  return Promise.resolve(false);
}
function hasBusinessAccess(userOrId) {
  if (typeof runtime.hasBusinessAccess === 'function') return runtime.hasBusinessAccess(userOrId);
  return Promise.resolve(false);
}
function getUserProductTier(userOrId) {
  if (typeof runtime.getUserProductTier === 'function') return runtime.getUserProductTier(userOrId);
  return Promise.resolve('free');
}
function checkCreditGate(userId) {
  if (typeof runtime.checkCreditGate === 'function') return runtime.checkCreditGate(userId);
  return Promise.resolve({ satisfied: true });
}
function ensureFgBalance(userId) {
  if (typeof runtime.ensureFgBalance === 'function') return runtime.ensureFgBalance(userId);
  return Promise.resolve();
}
function tfrEnsureStats(userId, client) {
  if (typeof runtime.tfrEnsureStats === 'function') return runtime.tfrEnsureStats(userId, client);
  return Promise.resolve(null);
}
function tfrAwardXp(userId, source, description, baseXp, client) {
  if (typeof runtime.tfrAwardXp === 'function') return runtime.tfrAwardXp(userId, source, description, baseXp, client);
  return Promise.resolve(null);
}
function tfrCalcLevel(xp) {
  if (typeof runtime.tfrCalcLevel === 'function') return runtime.tfrCalcLevel(xp);
  return 1;
}
function tfrXpToNext(xp, level) {
  if (typeof runtime.tfrXpToNext === 'function') return runtime.tfrXpToNext(xp, level);
  return 0;
}
function getUserLocalDate(tz) {
  if (typeof runtime.getUserLocalDate === 'function') return runtime.getUserLocalDate(tz);
  return new Date().toISOString().slice(0, 10);
}
function getUserLocalYesterday(tz) {
  if (typeof runtime.getUserLocalYesterday === 'function') return runtime.getUserLocalYesterday(tz);
  return getUserLocalDate(tz);
}
function isValidTimezone(tz) {
  if (typeof runtime.isValidTimezone === 'function') return runtime.isValidTimezone(tz);
  return true;
}
function getTfrRanks() { return runtime.TFR_RANKS || []; }
function getTfrPhaseNames() { return runtime.TFR_PHASE_NAMES || {}; }
function getTfrPhaseThemes() { return runtime.TFR_PHASE_THEMES || {}; }
const TFR_RANKS = new Proxy([], { get(_t, prop) { const ranks = getTfrRanks(); return ranks[prop]; } });
const TFR_PHASE_NAMES = new Proxy({}, { get(_t, prop) { return getTfrPhaseNames()[prop]; } });
const TFR_PHASE_THEMES = new Proxy({}, { get(_t, prop) { return getTfrPhaseThemes()[prop]; } });

// ── Future Generations points API + pages ──
const PUBLIC = path.join(__dirname, '..', 'public');

// GET /future-generations — Info landing page
pageRouter.get('/future-generations', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'future-generations.html'));
});

// GET /future-generations/dashboard — Points dashboard
pageRouter.get('/future-generations/dashboard', (req, res) => {
  res.sendFile(path.join(PUBLIC, 'future-generations-dashboard.html'));
});

// GET /sovereign-dashboard — Sovereign Command Center (affiliate 4x5 map, wallets, compliance)
pageRouter.get('/sovereign-dashboard', optionalAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC, 'sovereign-dashboard.html'));
});

// GET /future-generations/sovereign — alias
pageRouter.get('/future-generations/sovereign', optionalAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC, 'sovereign-dashboard.html'));
});

// GET /api/future-generations/status — Auth + Pro status for the current user
futureGenerationsRouter.get('/status', optionalAuth, async (req, res) => {
  try {
    if (!req.userId) {
      return res.json({ authenticated: false, has_access: false, is_affiliate: false });
    }
    const hasPro = await hasProAccess(req.userId);
    // Check affiliate enrollment
    let isAffiliate = false;
    try {
      const affRes = await pool.query(
        "SELECT id FROM affiliates WHERE user_id = $1 AND status != 'revoked'",
        [req.userId]
      );
      isAffiliate = affRes.rows.length > 0;
    } catch (e) { /* non-fatal */ }
    return res.json({ authenticated: true, has_access: hasPro, is_affiliate: isAffiliate });
  } catch (err) {
    console.error('[FutureGen] /status error:', err.message);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

// GET /api/future-generations/points — Points summary (all authenticated users; cashout requires Pro)
futureGenerationsRouter.get('/points', requireAuth, async (req, res) => {
  try {
    const hasPro = await hasProAccess(req.userId);
    await ensureFgBalance(req.userId);
    const result = await pool.query(
      'SELECT balance, total_earned, total_redeemed, last_daily_points_date, updated_at FROM fg_points_balances WHERE user_id = $1',
      [req.userId]
    );
    const row = result.rows[0] || { balance: 0, total_earned: 0, total_redeemed: 0 };
    const today = new Date().toISOString().split('T')[0];
    const earnedTodayAlready = row.last_daily_points_date
      ? row.last_daily_points_date.toISOString().split('T')[0] === today
      : false;
    res.json({
      success: true,
      balance: parseInt(row.balance),
      total_earned: parseInt(row.total_earned),
      total_redeemed: parseInt(row.total_redeemed),
      can_cashout: hasPro,           // Free users can earn but not cash out
      earned_today: earnedTodayAlready
    });
  } catch (err) {
    console.error('[FutureGen] /points error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch points' });
  }
});

// GET /api/future-generations/earnings — Earning history (all authenticated users)
futureGenerationsRouter.get('/earnings', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, activity_type, description, points, created_at
       FROM fg_earning_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.userId]
    );
    res.json({ success: true, events: result.rows });
  } catch (err) {
    console.error('[FutureGen] /earnings error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch earning history' });
  }
});

// GET /api/future-generations/redemptions — Redemption history (all authenticated users)
futureGenerationsRouter.get('/redemptions', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, item_name, points_spent, external_ref, status, created_at
       FROM fg_redemption_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.userId]
    );
    res.json({ success: true, events: result.rows });
  } catch (err) {
    console.error('[FutureGen] /redemptions error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch redemption history' });
  }
});

// POST /api/future-generations/cashout — Pro users cash out points to bank ($1/point)
const FG_CASHOUT_MINIMUM_POINTS = 10; // minimum 10 points ($10) per cashout

futureGenerationsRouter.post('/cashout', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;

    // Must be Pro to cash out
    const hasPro = await hasProAccess(userId);
    if (!hasPro) {
      return res.status(403).json({
        success: false,
        error: 'Cashout requires a Pro subscription. Free accounts can earn and view points but cannot cash out.',
        code: 'PRO_REQUIRED'
      });
    }

    await ensureFgBalance(userId);
    const balanceResult = await pool.query(
      'SELECT balance FROM fg_points_balances WHERE user_id = $1',
      [userId]
    );
    const balance = balanceResult.rows[0] ? parseInt(balanceResult.rows[0].balance) : 0;

    if (balance < FG_CASHOUT_MINIMUM_POINTS) {
      return res.status(400).json({
        success: false,
        error: `Minimum cashout is ${FG_CASHOUT_MINIMUM_POINTS} points ($${FG_CASHOUT_MINIMUM_POINTS}). You have ${balance} point${balance === 1 ? '' : 's'}.`
      });
    }

    const { points } = req.body;
    const pointsToCash = points ? Math.min(parseInt(points), balance) : balance;

    if (!pointsToCash || pointsToCash < FG_CASHOUT_MINIMUM_POINTS) {
      return res.status(400).json({
        success: false,
        error: `Must cash out at least ${FG_CASHOUT_MINIMUM_POINTS} points.`
      });
    }

    const amountCents = pointsToCash * 100; // 1 point = $1 = 100 cents

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Deduct points
      await client.query(
        `UPDATE fg_points_balances
         SET balance = balance - $2, total_redeemed = total_redeemed + $2, updated_at = NOW()
         WHERE user_id = $1`,
        [userId, pointsToCash]
      );

      // Record redemption event
      await client.query(
        `INSERT INTO fg_redemption_events (user_id, item_name, points_spent, status)
         VALUES ($1, 'Bank Cashout', $2, 'pending')`,
        [userId, pointsToCash]
      );

      // Create cashout request
      const cashoutResult = await client.query(
        `INSERT INTO fg_cashouts (user_id, points_cashed_out, amount_cents, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING *`,
        [userId, pointsToCash, amountCents]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: `Cashout of ${pointsToCash} point${pointsToCash === 1 ? '' : 's'} ($${(amountCents / 100).toFixed(2)}) requested. Processing typically takes 3–5 business days.`,
        cashout: cashoutResult.rows[0]
      });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[FutureGen] /cashout error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to process cashout' });
  }
});

// GET /api/future-generations/cashouts — Cashout history for current user
futureGenerationsRouter.get('/cashouts', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, points_cashed_out, amount_cents, status, requested_at, processed_at
       FROM fg_cashouts WHERE user_id = $1
       ORDER BY requested_at DESC LIMIT 50`,
      [req.userId]
    );
    res.json({ success: true, cashouts: result.rows });
  } catch (err) {
    console.error('[FutureGen] /cashouts error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch cashout history' });
  }
});

// ── TFR Command Console API + pages ──
// GET /sovereign - Sovereign: The TFR Protocol (primary route)
pageRouter.get('/sovereign', optionalAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC, 'command-console.html'));
});

// GET /command-console → redirect to /sovereign (backward compat)
pageRouter.get('/command-console', (req, res) => {
  res.redirect(301, '/sovereign');
});

// GET /api/tfr/status
tfrRouter.get('/status', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const stats = await tfrEnsureStats(userId, pool);
    const level = tfrCalcLevel(stats.xp);
    const rank = TFR_RANKS.find(r => r.level === level) || TFR_RANKS[0];
    const nextRank = TFR_RANKS.find(r => r.level === level + 1);
    const phase = rank.phase;
    const theme = TFR_PHASE_THEMES[phase];
    const xpToNext = tfrXpToNext(stats.xp, level);
    const xpProgress = nextRank
      ? Math.round(((stats.xp - rank.xp_required) / (nextRank.xp_required - rank.xp_required)) * 100)
      : 100;
    const streakMultiplier = (stats.streak_days || 0) >= 3 ? 1.5 : 1.0;
    const firstBloodDeadline = stats.first_blood_deadline;
    const hoursLeft = firstBloodDeadline && !stats.first_blood_done
      ? Math.max(0, Math.round((new Date(firstBloodDeadline) - Date.now()) / (1000 * 60 * 60)))
      : null;
    const xpEvents = (await pool.query(
      'SELECT * FROM tfr_xp_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10', [userId]
    )).rows;
    const achievements = (await pool.query(
      'SELECT achievement_key, earned_at FROM tfr_achievements WHERE user_id = $1', [userId]
    )).rows;
    const isPro = await hasProAccess(userId);
    const productTier = await getUserProductTier(userId);
    const isElite = await hasEliteAccess(userId);
    const isBusiness = await hasBusinessAccess(userId);
    const isSovereign = await hasSovereignAccess(userId);
    const creditGate = await checkCreditGate(userId);

    // Fetch TFR Reward Points (Aura Restored loyalty points)
    await ensureFgBalance(userId);
    const fgRow = (await pool.query(
      'SELECT balance, total_earned, total_redeemed FROM fg_points_balances WHERE user_id = $1',
      [userId]
    )).rows[0] || { balance: 0, total_earned: 0, total_redeemed: 0 };

    // Determine which tier band the current level belongs to
    const tierBands = {
      free:     [1,2,3],
      pro:      [4,5,6],
      business: [7,8,9],
      elite:    [10,11,12],
      sovereign: [],
    };
    const currentLevelTierBand = level <= 3 ? 'free' : level <= 6 ? 'pro' : level <= 9 ? 'business' : 'elite';
    const isLevelAccessible = (
      (level <= 3) ||
      (level <= 6 && isPro) ||
      (level <= 9 && isBusiness) ||
      (level <= 12 && isElite)
    );

    res.json({
      success: true,
      is_pro: isPro,
      product_tier: productTier,
      tier_access: {
        free:     true,
        pro:      isPro,
        business: isBusiness,
        elite:    isElite,
        sovereign: isSovereign,
        current_tier: productTier,
        current_level_band: currentLevelTierBand,
        level_accessible: isLevelAccessible,
      },
      credit_gate: creditGate,
      stats: {
        xp: stats.xp, level, streak_days: stats.streak_days || 0,
        longest_streak: stats.longest_streak || 0, prestige: stats.prestige || false,
        first_blood_done: stats.first_blood_done || false,
        first_blood_deadline: firstBloodDeadline, first_blood_hours_left: hoursLeft,
      },
      rank: {
        level, name: rank.name, phase, phase_name: TFR_PHASE_NAMES[phase], theme,
        xp_progress: xpProgress, xp_to_next: xpToNext,
        current_xp_threshold: rank.xp_required,
        next_xp_threshold: nextRank ? nextRank.xp_required : null,
        next_rank_name: nextRank ? nextRank.name : 'MAX RANK',
      },
      streak: { days: stats.streak_days || 0, multiplier: streakMultiplier, multiplier_active: streakMultiplier > 1 },
      xp_events: xpEvents,
      achievements,
      reward_points: {
        balance: parseInt(fgRow.balance) || 0,
        total_earned: parseInt(fgRow.total_earned) || 0,
        total_redeemed: parseInt(fgRow.total_redeemed) || 0,
      },
    });
  } catch (err) {
    console.error('[TFR] GET /api/tfr/status error:', err.message);
    res.status(500).json({ error: 'Failed to load TFR status' });
  }
});

// POST /api/tfr/checkin — open to all users (free=5 XP, pro=25 XP)
tfrRouter.post('/checkin', requireAuth, async (req, res) => {
  const isPro = await hasProAccess(req.userId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.userId;
    const stats = await tfrEnsureStats(userId, client);

    // Use user's local timezone for day boundaries (falls back to UTC)
    const userTz = (req.body && req.body.timezone && isValidTimezone(req.body.timezone))
      ? req.body.timezone : (stats.checkin_timezone || null);
    const today = getUserLocalDate(userTz);
    const lastDate = stats.last_activity_date
      ? new Date(stats.last_activity_date).toISOString().split('T')[0] : null;
    if (lastDate === today) {
      await client.query('COMMIT');
      return res.json({ success: false, message: 'Already checked in today', already_done: true });
    }
    const yesterday = getUserLocalYesterday(userTz);
    let newStreak = lastDate === yesterday ? (stats.streak_days || 0) + 1 : 1;

    // Persist user's timezone for future reference
    if (req.body && req.body.timezone && isValidTimezone(req.body.timezone)) {
      await client.query(
        'UPDATE tfr_user_stats SET checkin_timezone = $1 WHERE user_id = $2',
        [req.body.timezone, userId]
      );
    }
    const newLongest = Math.max(newStreak, stats.longest_streak || 0);
    await client.query(`
      UPDATE tfr_user_stats
      SET streak_days = $1, longest_streak = $2, last_activity_date = $3, updated_at = NOW()
      WHERE user_id = $4
    `, [newStreak, newLongest, today, userId]);

    // Pro gets 25 XP; free gets 5 XP — both track streaks
    const baseXp = isPro ? 25 : 5;
    const result = await tfrAwardXp(userId, 'daily_checkin', 'Daily check-in', baseXp, client);

    // Complete the "daily_checkin" challenge
    const checkinChal = (await client.query(
      "SELECT id, xp_reward FROM engagement_challenges WHERE criteria_key = 'daily_checkin' AND active = TRUE LIMIT 1"
    )).rows[0];
    if (checkinChal) {
      const periodKey = today;
      const alreadyDone = (await client.query(
        'SELECT id FROM user_challenges WHERE user_id=$1 AND challenge_id=$2 AND period_key=$3 AND status=$4',
        [userId, checkinChal.id, periodKey, 'completed']
      )).rows[0];
      if (!alreadyDone) {
        const chalXp = isPro ? checkinChal.xp_reward * 2 : checkinChal.xp_reward;
        await client.query(`
          INSERT INTO user_challenges (user_id, challenge_id, period_key, status, completed_at, xp_awarded)
          VALUES ($1, $2, $3, 'completed', NOW(), $4) ON CONFLICT DO NOTHING
        `, [userId, checkinChal.id, periodKey, chalXp]);
        await tfrAwardXp(userId, 'challenge_complete', 'Challenge: Complete your daily check-in', chalXp, client);
      }
    }

    // Check streak milestones (7, 30, 90, 365) — award achievement + bonus XP
    const STREAK_MILESTONES = { 7: 50, 30: 150, 90: 300, 365: 1000 };
    if (STREAK_MILESTONES[newStreak]) {
      const achKey = `streak_${newStreak}`;
      const alreadyEarned = (await client.query(
        'SELECT id FROM tfr_achievements WHERE user_id=$1 AND achievement_key=$2', [userId, achKey]
      )).rows[0];
      if (!alreadyEarned) {
        await client.query(
          'INSERT INTO tfr_achievements (user_id, achievement_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [userId, achKey]
        );
        const milestoneXp = isPro ? STREAK_MILESTONES[newStreak] * 2 : STREAK_MILESTONES[newStreak];
        await tfrAwardXp(userId, 'streak_milestone', `${newStreak}-Day Streak Milestone!`, milestoneXp, client);
        result.milestone_unlocked = { days: newStreak, xp_bonus: milestoneXp, key: achKey };
      }
    }

    // Update total_points
    await client.query(
      'UPDATE tfr_user_stats SET total_points = COALESCE(total_points,0) + $1 WHERE user_id = $2',
      [result.xp_earned || baseXp, userId]
    );

    // Award 15 TFR Reward Points for daily check-in (monthly cap enforced)
    let checkinPointsAwarded = 0;
    try {
      const CHECKIN_PTS = 15;
      const currentMonth = today.substring(0, 7);
      await ensureFgBalance(userId);
      const balRow2 = (await client.query(
        'SELECT monthly_points_earned, monthly_cap_reset_month FROM fg_points_balances WHERE user_id = $1',
        [userId]
      )).rows[0] || {};
      const monthEarned2 = balRow2.monthly_cap_reset_month === currentMonth
        ? (parseInt(balRow2.monthly_points_earned) || 0) : 0;
      const remaining2 = Math.max(0, 5000 - monthEarned2);
      const toAward2 = Math.min(CHECKIN_PTS, remaining2);
      if (toAward2 > 0) {
        await client.query(
          `UPDATE fg_points_balances
           SET balance = balance + $2,
               total_earned = total_earned + $2,
               monthly_points_earned = CASE WHEN monthly_cap_reset_month = $3 THEN monthly_points_earned + $2 ELSE $2 END,
               monthly_cap_reset_month = $3,
               updated_at = NOW()
           WHERE user_id = $1`,
          [userId, toAward2, currentMonth]
        );
        await client.query(
          `INSERT INTO fg_earning_events (user_id, activity_type, description, points)
           VALUES ($1, 'daily_checkin', 'Daily check-in — 15 FACTS Points', $2)`,
          [userId, toAward2]
        );
        checkinPointsAwarded = toAward2;
      }
      // First check-in achievement (one-time)
      await client.query(
        `INSERT INTO rewards_achievements (user_id, achievement_key, points_awarded)
         VALUES ($1, 'first_checkin', 0) ON CONFLICT DO NOTHING`,
        [userId]
      );
    } catch (rpErr) {
      console.error('[Rewards] checkin points error:', rpErr.message);
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: newStreak >= 3 ? `Day ${newStreak} — 1.5x XP ACTIVE` : `Day ${newStreak} streak`,
      streak: newStreak, xp_earned: result.xp_earned, multiplier: result.multiplier,
      leveled_up: result.leveled_up, level: result.level, new_rank: result.new_rank,
      milestone_unlocked: result.milestone_unlocked || null,
      is_pro: isPro,
      reward_points_earned: checkinPointsAwarded,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[TFR] checkin error:', err.message);
    res.status(500).json({ error: 'Check-in failed' });
  } finally { client.release(); }
});

// GET /api/tfr/leaks
tfrRouter.get('/leaks', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    // Gate leaks to Pro users only
    const isPro = await hasProAccess(userId);
    if (!isPro) {
      return res.status(403).json({ success: false, pro_required: true, message: 'Upgrade to access the Leak Detector' });
    }
    const stats = await tfrEnsureStats(userId, pool);
    const level = tfrCalcLevel(stats.xp);
    if (level < 2) {
      return res.json({ success: false, locked: true, message: 'Leak Detector unlocks at Level 2', xp_needed: TFR_RANKS[1].xp_required - stats.xp });
    }
    const txCount = (await pool.query("SELECT COUNT(*) FROM transactions WHERE user_id = $1", [userId])).rows[0].count;
    if (parseInt(txCount) < 5) {
      return res.json({ success: true, leaks: [], message: 'Not enough transaction data yet. Keep logging to enable leak detection.', total_monthly_waste: 0 });
    }
    const recurringRaw = (await pool.query(`
      SELECT description AS merchant, ROUND(ABS(amount)::numeric, 2) AS amount,
        COUNT(*) AS occurrences, MIN(date) AS first_seen, MAX(date) AS last_seen
      FROM transactions
      WHERE user_id = $1 AND type = 'expense' AND date >= NOW() - INTERVAL '90 days' AND ABS(amount) <= 100
      GROUP BY description, ROUND(ABS(amount)::numeric, 2)
      HAVING COUNT(*) >= 2
      ORDER BY occurrences DESC, amount ASC LIMIT 20
    `, [userId])).rows;
    const spikesRaw = (await pool.query(`
      WITH monthly AS (
        SELECT c.name AS category, DATE_TRUNC('month', t.date) AS month, SUM(ABS(t.amount)) AS total
        FROM transactions t JOIN categories c ON c.id = t.category_id
        WHERE t.user_id = $1 AND t.type = 'expense' AND t.date >= NOW() - INTERVAL '60 days'
        GROUP BY c.name, DATE_TRUNC('month', t.date)
      ),
      pivoted AS (
        SELECT category,
          SUM(CASE WHEN month = DATE_TRUNC('month', NOW()) THEN total ELSE 0 END) AS this_month,
          SUM(CASE WHEN month = DATE_TRUNC('month', NOW() - INTERVAL '1 month') THEN total ELSE 0 END) AS last_month
        FROM monthly GROUP BY category
      )
      SELECT category, this_month, last_month,
        ROUND(((this_month - last_month) / NULLIF(last_month, 0)) * 100) AS pct_increase
      FROM pivoted WHERE last_month > 20 AND this_month > last_month * 1.3
      ORDER BY pct_increase DESC LIMIT 5
    `, [userId])).rows;
    const existingDecisions = (await pool.query(
      "SELECT merchant_name, amount, user_decision FROM tfr_leak_candidates WHERE user_id = $1 AND scan_date = CURRENT_DATE",
      [userId]
    )).rows;
    const decisionMap = {};
    existingDecisions.forEach(d => { decisionMap[`${d.merchant_name}_${d.amount}`] = d.user_decision; });
    const leaks = [];
    const seen = new Set();
    for (const r of recurringRaw) {
      const key = `${r.merchant}_${r.amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isPhantom = parseFloat(r.amount) <= 9.99;
      leaks.push({
        id: key, merchant: r.merchant, amount: parseFloat(r.amount),
        leak_type: isPhantom ? 'phantom' : 'subscription',
        monthly_cost: parseFloat(r.amount), occurrences: parseInt(r.occurrences),
        note: isPhantom ? 'Phantom charge — small recurring amount' : `Charged ${r.occurrences}× in 90 days`,
        user_decision: decisionMap[key] || null,
      });
    }
    for (const s of spikesRaw) {
      const key = `spike_${s.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      leaks.push({
        id: key, merchant: s.category, amount: parseFloat(s.this_month),
        leak_type: 'spike', monthly_cost: Math.max(0, parseFloat(s.this_month) - parseFloat(s.last_month)),
        pct_increase: parseInt(s.pct_increase),
        note: `Up ${s.pct_increase}% vs last month ($${parseFloat(s.last_month).toFixed(0)} → $${parseFloat(s.this_month).toFixed(0)})`,
        user_decision: decisionMap[key] || null,
      });
    }
    const total_monthly_waste = leaks.filter(l => l.user_decision !== 'keep').reduce((sum, l) => sum + l.monthly_cost, 0);
    res.json({ success: true, leaks, total_monthly_waste: Math.round(total_monthly_waste * 100) / 100, level_unlocked: true });
  } catch (err) {
    console.error('[TFR] leaks error:', err.message);
    res.status(500).json({ error: 'Leak detection failed' });
  }
});

// POST /api/tfr/leaks/decision
tfrRouter.post('/leaks/decision', requireAuth, async (req, res) => {
  const isPro = await hasProAccess(req.userId);
  if (!isPro) {
    return res.status(403).json({ success: false, pro_required: true, message: 'Upgrade to use the Leak Detector' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.userId;
    const { merchant, amount, leak_type, decision } = req.body;
    if (!merchant || !amount || !decision || !['keep', 'eliminate'].includes(decision)) {
      return res.status(400).json({ error: 'merchant, amount, leak_type, decision required' });
    }
    await client.query(`
      INSERT INTO tfr_leak_candidates (user_id, merchant_name, amount, leak_type, frequency, monthly_cost, user_decision, decided_at, scan_date)
      VALUES ($1, $2, $3, $4, 'monthly', $3, $5, NOW(), CURRENT_DATE)
      ON CONFLICT DO NOTHING
    `, [userId, merchant, amount, leak_type || 'subscription', decision]);
    let xp_result = null;
    if (decision === 'eliminate') {
      xp_result = await tfrAwardXp(userId, 'leak_eliminated', `Eliminated leak: ${merchant}`, 50, client);
      const eliminatedSum = (await client.query(`
        SELECT COALESCE(SUM(monthly_cost), 0) AS total FROM tfr_leak_candidates
        WHERE user_id = $1 AND user_decision = 'eliminate' AND monthly_cost > 0
      `, [userId])).rows[0].total;
      if (parseFloat(eliminatedSum) >= 100) {
        await client.query(`INSERT INTO tfr_achievements (user_id, achievement_key) VALUES ($1, 'leak_slayer') ON CONFLICT DO NOTHING`, [userId]);
      }
      const stats = (await client.query('SELECT * FROM tfr_user_stats WHERE user_id = $1', [userId])).rows[0];
      if (stats && !stats.first_blood_done && stats.first_blood_deadline && new Date() <= new Date(stats.first_blood_deadline)) {
        await client.query(`UPDATE tfr_user_stats SET first_blood_done = TRUE, updated_at = NOW() WHERE user_id = $1`, [userId]);
        await tfrAwardXp(userId, 'first_blood', 'FIRST BLOOD — First leak eliminated within 48 hours', 150, client);
        await client.query(`INSERT INTO tfr_micro_wins (user_id, win_type, xp_awarded) VALUES ($1, 'first_blood', 150) ON CONFLICT DO NOTHING`, [userId]);
        await client.query(`INSERT INTO tfr_achievements (user_id, achievement_key) VALUES ($1, 'first_blood') ON CONFLICT DO NOTHING`, [userId]);
        if (xp_result) xp_result.first_blood_achieved = true;
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, decision, xp_result });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[TFR] leaks/decision error:', err.message);
    res.status(500).json({ error: 'Failed to record decision' });
  } finally { client.release(); }
});

// GET /api/tfr/xp-events
tfrRouter.get('/xp-events', requireAuth, async (req, res) => {
  try {
    const events = (await pool.query(
      'SELECT * FROM tfr_xp_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [req.userId]
    )).rows;
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// POST /api/tfr/award-transaction-xp
tfrRouter.post('/award-transaction-xp', requireAuth, async (req, res) => {
  // Gate XP earning to Pro users only
  const isPro = await hasProAccess(req.userId);
  if (!isPro) {
    return res.status(403).json({ success: false, pro_required: true, message: 'Upgrade to earn XP' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.userId;
    await tfrEnsureStats(userId, client);
    const today = new Date().toISOString().split('T')[0];
    const todayCount = (await client.query(`
      SELECT COUNT(*) FROM tfr_xp_events
      WHERE user_id = $1 AND source = 'transaction_log' AND created_at::date = $2
    `, [userId, today])).rows[0].count;
    if (parseInt(todayCount) >= 3) {
      await client.query('COMMIT');
      return res.json({ success: false, message: 'Daily limit reached' });
    }
    const stats = (await client.query('SELECT * FROM tfr_user_stats WHERE user_id = $1', [userId])).rows[0];
    const lastDate = stats?.last_activity_date ? new Date(stats.last_activity_date).toISOString().split('T')[0] : null;
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    if (lastDate !== today) {
      const newStreak = lastDate === yesterday ? (stats?.streak_days || 0) + 1 : 1;
      const newLongest = Math.max(newStreak, stats?.longest_streak || 0);
      await client.query(`UPDATE tfr_user_stats SET streak_days=$1, longest_streak=$2, last_activity_date=$3, updated_at=NOW() WHERE user_id=$4`,
        [newStreak, newLongest, today, userId]);
    }
    const result = await tfrAwardXp(userId, 'transaction_log', 'Transaction logged', 10, client);
    await client.query('COMMIT');
    res.json({ success: true, ...result });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'XP award failed' });
  } finally { client.release(); }
});

// GET /api/tfr/all-ranks
tfrRouter.get('/all-ranks', (req, res) => {
  res.json({ success: true, ranks: TFR_RANKS, phases: TFR_PHASE_NAMES, themes: TFR_PHASE_THEMES });
});

// GET /api/tfr/tier-map — returns the full 12-level tier mapping
tfrRouter.get('/tier-map', async (req, res) => {
  try {
    const rows = (await pool.query('SELECT * FROM level_tier_map ORDER BY level ASC')).rows;
    res.json({ success: true, levels: rows });
  } catch (err) {
    // If the table doesn't exist yet (pre-migration), fall back to TFR_RANKS
    const fallback = TFR_RANKS.map(r => ({
      level: r.level,
      rank_name: r.name,
      phase: r.phase,
      xp_required: r.xp_required,
      tier_band: r.level <= 3 ? 'free' : r.level <= 6 ? 'pro' : r.level <= 9 ? 'business' : 'elite',
    }));
    res.json({ success: true, levels: fallback });
  }
});

// GET /api/tfr/credit-gate/status — check credit gate for current user
tfrRouter.get('/credit-gate/status', requireAuth, async (req, res) => {
  try {
    const gate = await checkCreditGate(req.userId);
    const hasCreditDoc = (await pool.query(
      "SELECT id FROM user_documents WHERE user_id = $1 AND category = 'credit_reports' LIMIT 1",
      [req.userId]
    )).rows.length > 0;

    // Auto-satisfy if they have a credit report uploaded
    if (hasCreditDoc && !['uploaded','waived'].includes(gate.status)) {
      await pool.query(
        "UPDATE users SET credit_gate_status = 'uploaded' WHERE id = $1",
        [req.userId]
      );
      gate.status = 'uploaded';
      gate.satisfied = true;
    }

    res.json({ success: true, ...gate, has_credit_document: hasCreditDoc });
  } catch (err) {
    console.error('[TFR] credit-gate/status error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to check credit gate' });
  }
});

// POST /api/tfr/credit-gate/satisfy — called when user uploads credit report
// This is triggered from document-vault.html after a credit_report upload
tfrRouter.post('/credit-gate/satisfy', requireAuth, async (req, res) => {
  try {
    await pool.query(
      "UPDATE users SET credit_gate_status = 'uploaded' WHERE id = $1",
      [req.userId]
    );
    res.json({ success: true, message: 'Credit gate satisfied. You can now access Elite features (Levels 4-6).' });
  } catch (err) {
    console.error('[TFR] credit-gate/satisfy error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to update credit gate' });
  }
});

// ── Daily engagement loop ──
// ─────────────────────────────────────────────────────────────────────────────
// DAILY ENGAGEMENT LOOP — Streaks, Challenges, Tips, Points
// ─────────────────────────────────────────────────────────────────────────────

// ── Activity Event Tracking (for view-based challenge verification) ──────────
// Lightweight table: user_activity_events (user_id, event_type, event_date)
// Created via ensureActivityTable() on first use; no migration needed.
let _activityTableReady = false;
async function ensureActivityTable() {
  if (_activityTableReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_activity_events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        event_date DATE NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, event_type, event_date)
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_user_activity_events_lookup ON user_activity_events(user_id, event_type, event_date)');
    _activityTableReady = true;
  } catch (e) {
    // Table might already exist from a prior run — that's fine
    if (e.code === '42P07' || e.message?.includes('already exists')) {
      _activityTableReady = true;
    } else {
      console.error('[Activity] table setup error:', e.message);
    }
  }
}

// Record a user activity event (idempotent per user+type+date)
async function recordActivity(userId, eventType) {
  await ensureActivityTable();
  try {
    await pool.query(`
      INSERT INTO user_activity_events (user_id, event_type, event_date)
      VALUES ($1, $2, CURRENT_DATE)
      ON CONFLICT (user_id, event_type, event_date) DO NOTHING
    `, [userId, eventType]);
  } catch (e) { /* silent — non-critical */ }
}

// Check if user performed activity today
async function hasActivityToday(userId, eventType) {
  await ensureActivityTable();
  const today = new Date().toISOString().split('T')[0];
  const r = await pool.query(
    'SELECT 1 FROM user_activity_events WHERE user_id=$1 AND event_type=$2 AND event_date=$3 LIMIT 1',
    [userId, eventType, today]
  );
  return r.rows.length > 0;
}

// POST /api/engagement/activity — track user view/visit events (for challenge verification)
engagementRouter.post('/activity', requireAuth, async (req, res) => {
  try {
    const { event_type } = req.body;
    const ALLOWED_EVENTS = ['view_allocations', 'view_dashboard', 'visit_sovereign', 'view_fun_allocation', 'view_education'];
    if (!event_type || !ALLOWED_EVENTS.includes(event_type)) {
      return res.status(400).json({ error: 'Invalid event_type' });
    }
    await recordActivity(req.userId, event_type);

    // Auto-complete the corresponding challenge if one matches
    const autoResult = await tryAutoCompleteChallenge(req.userId, event_type);
    res.json({ success: true, tracked: true, auto_completed: autoResult || null });
  } catch (e) {
    console.error('[Activity] track error:', e.message);
    res.status(500).json({ error: 'Failed to track activity' });
  }
});

// ── Challenge Verification System ────────────────────────────────────────────

/**
 * Verify if a user has actually completed the action required by a challenge.
 * Returns { verified: boolean, reason?: string }
 */
async function verifyChallengeCompletion(userId, criteriaKey, client, userTimezone) {
  const db = client || pool;
  const today = getUserLocalDate(userTimezone || null);
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  // ISO week start (Monday)
  const weekDay = now.getDay() || 7; // Convert Sunday=0 to 7
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - weekDay + 1);
  const weekStartStr = weekStart.toISOString().split('T')[0];

  switch (criteriaKey) {
    // ── DAILY challenges ─────────────────────────────────────────────
    case 'log_transaction': {
      const r = await db.query(
        'SELECT COUNT(*) FROM transactions WHERE user_id=$1 AND transaction_date=$2',
        [userId, today]
      );
      const count = parseInt(r.rows[0].count);
      return count >= 1
        ? { verified: true }
        : { verified: false, reason: 'Log at least 1 transaction today to complete this challenge.' };
    }
    case 'log_3_transactions': {
      const r = await db.query(
        'SELECT COUNT(*) FROM transactions WHERE user_id=$1 AND transaction_date=$2',
        [userId, today]
      );
      const count = parseInt(r.rows[0].count);
      return count >= 3
        ? { verified: true }
        : { verified: false, reason: `Log ${3 - count} more transaction${3 - count === 1 ? '' : 's'} today (${count}/3 so far).` };
    }
    case 'view_allocations': {
      const has = await hasActivityToday(userId, 'view_allocations');
      return has
        ? { verified: true }
        : { verified: false, reason: 'Visit the Allocations tab to complete this challenge.' };
    }
    case 'daily_checkin': {
      // Auto-completed by check-in endpoint — verify via tfr_user_stats
      const statsRow = await db.query(
        'SELECT last_activity_date, checkin_timezone FROM tfr_user_stats WHERE user_id=$1', [userId]
      );
      const storedTz = userTimezone || statsRow.rows[0]?.checkin_timezone || null;
      const todayLocal = getUserLocalDate(storedTz);
      const lastDate = statsRow.rows[0]?.last_activity_date
        ? new Date(statsRow.rows[0].last_activity_date).toISOString().split('T')[0]
        : null;
      return lastDate === todayLocal
        ? { verified: true }
        : { verified: false, reason: 'Hit the Check-In button to complete this challenge.' };
    }
    case 'read_tip': {
      // Auto-completed by tip read endpoint — check user_challenges directly
      return { verified: true }; // If they get here, the tip endpoint already handles it
    }
    case 'view_dashboard': {
      const has = await hasActivityToday(userId, 'view_dashboard');
      return has
        ? { verified: true }
        : { verified: false, reason: 'Visit your Dashboard to complete this challenge.' };
    }
    case 'visit_sovereign': {
      const has = await hasActivityToday(userId, 'visit_sovereign');
      return has
        ? { verified: true }
        : { verified: false, reason: 'Visit the Command Console to complete this challenge.' };
    }
    case 'view_fun_allocation': {
      const has = await hasActivityToday(userId, 'view_fun_allocation');
      return has
        ? { verified: true }
        : { verified: false, reason: 'View your Fun spending in the Allocations tab to complete this challenge.' };
    }
    case 'log_bill': {
      // Check for any expense transaction logged today (bills are expenses)
      const r = await db.query(
        "SELECT COUNT(*) FROM transactions WHERE user_id=$1 AND transaction_date=$2 AND type='expense'",
        [userId, today]
      );
      return parseInt(r.rows[0].count) >= 1
        ? { verified: true }
        : { verified: false, reason: 'Log a bill or expense payment today to complete this challenge.' };
    }
    case 'view_education': {
      const has = await hasActivityToday(userId, 'view_education');
      return has
        ? { verified: true }
        : { verified: false, reason: 'View your Education budget in the Allocations tab to complete this challenge.' };
    }

    // ── WEEKLY challenges ────────────────────────────────────────────
    case 'weekly_7day_streak': {
      const stats = await db.query('SELECT streak_days FROM tfr_user_stats WHERE user_id=$1', [userId]);
      const streak = stats.rows[0]?.streak_days || 0;
      return streak >= 7
        ? { verified: true }
        : { verified: false, reason: `Maintain a 7-day streak (currently ${streak} days).` };
    }
    case 'review_all_allocations': {
      // Check if user visited allocations at least once this week
      await ensureActivityTable();
      const r = await db.query(
        'SELECT COUNT(DISTINCT event_date) FROM user_activity_events WHERE user_id=$1 AND event_type=$2 AND event_date >= $3',
        [userId, 'view_allocations', weekStartStr]
      );
      return parseInt(r.rows[0].count) >= 1
        ? { verified: true }
        : { verified: false, reason: 'Review your allocations this week to complete this challenge.' };
    }
    case 'log_15_weekly': {
      const r = await db.query(
        'SELECT COUNT(*) FROM transactions WHERE user_id=$1 AND transaction_date >= $2',
        [userId, weekStartStr]
      );
      const count = parseInt(r.rows[0].count);
      return count >= 15
        ? { verified: true }
        : { verified: false, reason: `Log ${15 - count} more transactions this week (${count}/15).` };
    }
    case 'check_savings_weekly': {
      // Check if user visited allocations this week (viewing savings allocation)
      await ensureActivityTable();
      const r = await db.query(
        'SELECT COUNT(*) FROM user_activity_events WHERE user_id=$1 AND event_type=$2 AND event_date >= $3',
        [userId, 'view_allocations', weekStartStr]
      );
      return parseInt(r.rows[0].count) >= 1
        ? { verified: true }
        : { verified: false, reason: 'Check your Savings allocation this week.' };
    }

    // ── MONTHLY challenges ───────────────────────────────────────────
    case 'monthly_30day_streak': {
      const stats = await db.query('SELECT streak_days FROM tfr_user_stats WHERE user_id=$1', [userId]);
      return (stats.rows[0]?.streak_days || 0) >= 30
        ? { verified: true }
        : { verified: false, reason: `Reach a 30-day streak (currently ${stats.rows[0]?.streak_days || 0} days).` };
    }
    case 'monthly_debt_review': {
      // Check if user viewed debt-related tab or logged debt payments this month
      await ensureActivityTable();
      const r = await db.query(
        "SELECT COUNT(*) FROM user_activity_events WHERE user_id=$1 AND event_type='view_allocations' AND event_date >= $2",
        [userId, monthStart]
      );
      return parseInt(r.rows[0].count) >= 1
        ? { verified: true }
        : { verified: false, reason: 'Review your debt and allocations this month.' };
    }
    case 'monthly_fun_reduction': {
      // Check if Fun spending % is at or below target allocation
      const funCat = await db.query("SELECT id FROM categories WHERE slug IN ('lifestyle','fun') LIMIT 1");
      if (!funCat.rows[0]) return { verified: false, reason: 'Fun category not found.' };
      const funId = funCat.rows[0].id;
      const target = await db.query(
        'SELECT COALESCE(pa.percentage, ac.percentage) as pct FROM allocation_config ac LEFT JOIN permanent_allocations pa ON pa.category_id=ac.category_id AND pa.user_id=$1 WHERE ac.category_id=$2',
        [userId, funId]
      );
      const targetPct = parseFloat(target.rows[0]?.pct || 10);
      // Get this month's spending distribution
      const spending = await db.query(`
        SELECT COALESCE(SUM(CASE WHEN category_id=$1 THEN amount ELSE 0 END), 0) as fun_total,
               COALESCE(SUM(amount), 0) as total
        FROM transactions WHERE user_id=$2 AND type='expense' AND transaction_date >= $3
      `, [funId, userId, monthStart]);
      const funTotal = parseFloat(spending.rows[0].fun_total);
      const total = parseFloat(spending.rows[0].total);
      if (total === 0) return { verified: false, reason: 'Log some expenses this month first.' };
      const actualPct = (funTotal / total) * 100;
      return actualPct <= targetPct
        ? { verified: true }
        : { verified: false, reason: `Fun spending is ${actualPct.toFixed(1)}% vs ${targetPct}% target. Reduce Fun spending.` };
    }
    case 'monthly_50_logs': {
      const r = await db.query(
        'SELECT COUNT(*) FROM transactions WHERE user_id=$1 AND transaction_date >= $2',
        [userId, monthStart]
      );
      const count = parseInt(r.rows[0].count);
      return count >= 50
        ? { verified: true }
        : { verified: false, reason: `Log ${50 - count} more transactions this month (${count}/50).` };
    }
    case 'monthly_20_challenges': {
      // Auto-completed by the system when 20 daily challenges are done
      const monthKey = getPeriodKey('monthly');
      const r = await db.query(`
        SELECT COUNT(*) FROM user_challenges uc
        JOIN engagement_challenges ec ON ec.id = uc.challenge_id
        WHERE uc.user_id=$1 AND uc.status='completed' AND ec.type='daily'
          AND uc.period_key LIKE $2
      `, [userId, `${monthKey.substring(0, 7)}%`]);
      return parseInt(r.rows[0].count) >= 20
        ? { verified: true }
        : { verified: false, reason: `Complete ${20 - parseInt(r.rows[0].count)} more daily challenges this month.` };
    }
    case 'monthly_streak_record': {
      const stats = await db.query('SELECT streak_days, longest_streak FROM tfr_user_stats WHERE user_id=$1', [userId]);
      const current = stats.rows[0]?.streak_days || 0;
      const longest = stats.rows[0]?.longest_streak || 0;
      // They hit a new record if current === longest and it increased this month
      return current >= longest && current > 0
        ? { verified: true }
        : { verified: false, reason: `Beat your personal best streak of ${longest} days (currently ${current}).` };
    }

    default:
      // Unknown criteria — allow completion (backwards compatible)
      return { verified: true };
  }
}

/**
 * Try to auto-complete a challenge by criteria_key for a user.
 * Used after actions (transaction logged, tab visited, etc.)
 * Returns { challenge_title, xp_earned } if completed, null otherwise.
 */
async function tryAutoCompleteChallenge(userId, criteriaKey) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const challenge = (await client.query(
      'SELECT * FROM engagement_challenges WHERE criteria_key=$1 AND active=TRUE LIMIT 1',
      [criteriaKey]
    )).rows[0];
    if (!challenge) { await client.query('ROLLBACK'); return null; }

    const periodKey = getPeriodKey(challenge.type);
    const existing = (await client.query(
      'SELECT * FROM user_challenges WHERE user_id=$1 AND challenge_id=$2 AND period_key=$3',
      [userId, challenge.id, periodKey]
    )).rows[0];
    if (existing?.status === 'completed') { await client.query('ROLLBACK'); return null; }

    // Verify the action was actually done
    const verification = await verifyChallengeCompletion(userId, criteriaKey, client);
    if (!verification.verified) { await client.query('ROLLBACK'); return null; }

    const isPro = await hasProAccess(userId);
    const xpEarned = isPro ? Math.round(challenge.xp_reward * 2) : challenge.xp_reward;

    await client.query(`
      INSERT INTO user_challenges (user_id, challenge_id, period_key, status, completed_at, xp_awarded)
      VALUES ($1, $2, $3, 'completed', NOW(), $4)
      ON CONFLICT (user_id, challenge_id, period_key) DO UPDATE
        SET status='completed', completed_at=NOW(), xp_awarded=$4
    `, [userId, challenge.id, periodKey, xpEarned]);

    await tfrEnsureStats(userId, client);
    await tfrAwardXp(userId, 'challenge_complete', `Challenge: ${challenge.title}`, xpEarned, client);
    await client.query(
      'UPDATE tfr_user_stats SET total_points = COALESCE(total_points,0) + $1 WHERE user_id=$2',
      [xpEarned, userId]
    );

    // Award TFR Reward Points if challenge has points_reward > 0
    let pointsAwarded = 0;
    const challengePtsReward = parseInt(challenge.points_reward) || 0;
    if (challengePtsReward > 0) {
      try {
        await ensureFgBalance(userId);
        const rpToday = new Date().toISOString().split('T')[0];
        const rpMonth = rpToday.substring(0, 7);
        const rpBal = (await client.query(
          'SELECT monthly_points_earned, monthly_cap_reset_month FROM fg_points_balances WHERE user_id = $1',
          [userId]
        )).rows[0] || {};
        const rpMonthEarned = rpBal.monthly_cap_reset_month === rpMonth
          ? (parseInt(rpBal.monthly_points_earned) || 0) : 0;
        const rpRemaining = Math.max(0, 5000 - rpMonthEarned);
        const rpToAward = Math.min(challengePtsReward, rpRemaining);
        if (rpToAward > 0) {
          await client.query(
            `UPDATE fg_points_balances
             SET balance = balance + $2,
                 total_earned = total_earned + $2,
                 monthly_points_earned = CASE WHEN monthly_cap_reset_month = $3 THEN monthly_points_earned + $2 ELSE $2 END,
                 monthly_cap_reset_month = $3,
                 updated_at = NOW()
             WHERE user_id = $1`,
            [userId, rpToAward, rpMonth]
          );
          await client.query(
            `INSERT INTO fg_earning_events (user_id, activity_type, description, points)
             VALUES ($1, 'challenge_complete', $2, $3)`,
            [userId, `Challenge: ${challenge.title} — ${rpToAward} FACTS Points`, rpToAward]
          );
          pointsAwarded = rpToAward;
        }
      } catch (rpErr) {
        console.error('[Rewards] challenge points error:', rpErr.message);
      }
    }

    await client.query('COMMIT');
    return { challenge_title: challenge.title, xp_earned: xpEarned, points_awarded: pointsAwarded };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[AutoComplete] error for', criteriaKey, e.message);
    return null;
  } finally { client.release(); }
}

// Helper: deterministic "today's" tip index (rotates daily across 30 tips)
function getTodaysTipIndex() {
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return (dayOfYear % 30) + 1;
}

// Helper: period_key for challenges (daily = YYYY-MM-DD, weekly = YYYY-Www, monthly = YYYY-MM)
function getPeriodKey(type) {
  const now = new Date();
  if (type === 'daily') return now.toISOString().split('T')[0];
  if (type === 'weekly') {
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const week = Math.ceil(((now - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7);
    return `${now.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Helper: get or init TFR stats without requiring Pro
async function engEnsureStats(userId) {
  const existing = (await pool.query('SELECT * FROM tfr_user_stats WHERE user_id = $1', [userId])).rows[0];
  if (existing) return existing;
  const deadline = new Date(Date.now() + 48 * 60 * 60 * 1000);
  const row = (await pool.query(`
    INSERT INTO tfr_user_stats (user_id, first_blood_deadline)
    VALUES ($1, $2)
    ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
    RETURNING *
  `, [userId, deadline])).rows[0];
  return row;
}

// GET /api/engagement/today — fetch today's tip, challenges, streak, points
engagementRouter.get('/today', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const isPro = await hasProAccess(userId);
    const stats = await engEnsureStats(userId);

    // Today's tip
    const tipIndex = getTodaysTipIndex();
    const tip = (await pool.query(
      'SELECT id, content, author, category FROM daily_tips WHERE tip_index = $1 AND active = TRUE', [tipIndex]
    )).rows[0] || null;

    // Today's daily challenges (rotating — pick 3 based on day of year)
    const allDailyChallenges = (await pool.query(
      "SELECT * FROM engagement_challenges WHERE type = 'daily' AND active = TRUE ORDER BY sort_order"
    )).rows;
    const dayOffset = Math.floor(Date.now() / 86400000);
    const todayChallenges = [];
    for (let i = 0; i < 3 && allDailyChallenges.length > 0; i++) {
      const idx = (dayOffset + i) % allDailyChallenges.length;
      todayChallenges.push(allDailyChallenges[idx]);
    }

    // Active weekly + monthly challenges
    const weeklyMonthly = (await pool.query(
      "SELECT * FROM engagement_challenges WHERE type IN ('weekly','monthly') AND active = TRUE ORDER BY type, sort_order"
    )).rows;

    const allChallenges = [...todayChallenges, ...weeklyMonthly];
    const challengeIds = allChallenges.map(c => c.id);

    // Check completion status for all challenges
    let completionMap = {};
    if (challengeIds.length > 0) {
      const periodKeys = {
        daily: getPeriodKey('daily'),
        weekly: getPeriodKey('weekly'),
        monthly: getPeriodKey('monthly'),
      };
      const completions = (await pool.query(`
        SELECT uc.challenge_id, uc.status, uc.completed_at
        FROM user_challenges uc
        JOIN engagement_challenges ec ON ec.id = uc.challenge_id
        WHERE uc.user_id = $1
          AND uc.challenge_id = ANY($2::int[])
          AND (
            (ec.type = 'daily'   AND uc.period_key = $3) OR
            (ec.type = 'weekly'  AND uc.period_key = $4) OR
            (ec.type = 'monthly' AND uc.period_key = $5)
          )
      `, [userId, challengeIds, periodKeys.daily, periodKeys.weekly, periodKeys.monthly])).rows;
      completions.forEach(c => { completionMap[c.challenge_id] = c; });
    }

    // Check verification status for incomplete challenges
    const verificationMap = {};
    for (const c of allChallenges) {
      if (completionMap[c.id]?.status !== 'completed') {
        try {
          verificationMap[c.id] = await verifyChallengeCompletion(userId, c.criteria_key, null, userTz);
        } catch { verificationMap[c.id] = { verified: false, reason: 'Check failed' }; }
      }
    }

    const challengesWithStatus = allChallenges.map(c => ({
      ...c,
      completed: completionMap[c.id]?.status === 'completed',
      completed_at: completionMap[c.id]?.completed_at || null,
      xp_reward: isPro ? Math.round(c.xp_reward * 1) : c.xp_reward, // 2x shown in UI for Pro
      verified: completionMap[c.id]?.status === 'completed' ? true : (verificationMap[c.id]?.verified || false),
      verify_hint: verificationMap[c.id]?.reason || null,
    }));

    // Streak info
    const streak = {
      days: stats.streak_days || 0,
      longest: stats.longest_streak || 0,
      freezes_remaining: isPro ? (stats.freezes_remaining || 0) : 0,
      multiplier: (stats.streak_days || 0) >= 3 ? 1.5 : 1.0,
      milestones: [7, 30, 90, 365],
      next_milestone: [7, 30, 90, 365].find(m => m > (stats.streak_days || 0)) || null,
    };

    // Milestone achievements
    const achievements = (await pool.query(
      "SELECT achievement_key FROM tfr_achievements WHERE user_id = $1", [userId]
    )).rows.map(r => r.achievement_key);

    // TFR Reward Points (Aura Restored loyalty balance) — separate from Financial XP
    await ensureFgBalance(userId);
    const fgPointsRow = (await pool.query(
      'SELECT balance, total_earned, total_redeemed FROM fg_points_balances WHERE user_id = $1',
      [userId]
    )).rows[0] || { balance: 0, total_earned: 0, total_redeemed: 0 };

    // Use user's local timezone for checked_in_today (falls back to UTC)
    const userTz = (req.query.timezone && isValidTimezone(req.query.timezone))
      ? req.query.timezone : (stats.checkin_timezone || null);
    const today = getUserLocalDate(userTz);
    const checkedInToday = stats.last_activity_date
      ? new Date(stats.last_activity_date).toISOString().split('T')[0] === today
      : false;

    res.json({
      success: true,
      is_pro: isPro,
      streak,
      checked_in_today: checkedInToday,
      tip,
      challenges: {
        daily: challengesWithStatus.filter(c => c.type === 'daily'),
        weekly: challengesWithStatus.filter(c => c.type === 'weekly'),
        monthly: challengesWithStatus.filter(c => c.type === 'monthly'),
      },
      total_points: stats.total_points || stats.xp || 0,
      // TFR Reward Points: redeemable at Aura Restored (separate from Financial XP)
      reward_points: {
        balance: parseInt(fgPointsRow.balance) || 0,
        total_earned: parseInt(fgPointsRow.total_earned) || 0,
        total_redeemed: parseInt(fgPointsRow.total_redeemed) || 0,
      },
      achievements,
      xp_multiplier_active: streak.multiplier > 1,
      pro_multiplier: isPro ? '2× User Points bonus active for Pro' : null,
      user_timezone: userTz || 'UTC',
    });
  } catch (err) {
    console.error('[Engagement] GET /today error:', err.message);
    res.status(500).json({ error: 'Failed to load engagement data' });
  }
});

// POST /api/engagement/challenge/:id/complete — mark a challenge as done (with verification)
engagementRouter.post('/challenge/:id/complete', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.userId;
    const challengeId = parseInt(req.params.id);
    const isPro = await hasProAccess(userId);

    const challenge = (await client.query(
      'SELECT * FROM engagement_challenges WHERE id = $1 AND active = TRUE', [challengeId]
    )).rows[0];
    if (!challenge) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Challenge not found' });
    }

    const periodKey = getPeriodKey(challenge.type);

    // Check if already completed
    const existing = (await client.query(`
      SELECT * FROM user_challenges WHERE user_id = $1 AND challenge_id = $2 AND period_key = $3
    `, [userId, challengeId, periodKey])).rows[0];
    if (existing?.status === 'completed') {
      await client.query('ROLLBACK');
      return res.json({ success: false, already_done: true, message: 'Challenge already completed' });
    }

    // ── Automated verification: check if user actually performed the required action ──
    const verification = await verifyChallengeCompletion(userId, challenge.criteria_key, client);
    if (!verification.verified) {
      await client.query('ROLLBACK');
      return res.json({
        success: false,
        not_verified: true,
        message: verification.reason || 'Complete the required action first.',
      });
    }

    // User Points earned (challenges award TFR Reward Points, NOT Financial XP)
    // Pro users get 2x User Points bonus
    const basePoints = challenge.xp_reward;
    const pointsEarned = isPro ? Math.round(basePoints * 2) : basePoints;

    // Upsert challenge completion (xp_awarded column stores points for backward compat)
    await client.query(`
      INSERT INTO user_challenges (user_id, challenge_id, period_key, status, completed_at, xp_awarded)
      VALUES ($1, $2, $3, 'completed', NOW(), $4)
      ON CONFLICT (user_id, challenge_id, period_key) DO UPDATE
        SET status = 'completed', completed_at = NOW(), xp_awarded = $4
    `, [userId, challengeId, periodKey, pointsEarned]);

    // Award TFR Reward Points (fg_points_balances) — NOT Financial XP
    // Challenges feed the Aura Restored loyalty system, not the financial progression system.
    await ensureFgBalance(userId);
    await client.query(
      `UPDATE fg_points_balances
       SET balance = balance + $1, total_earned = total_earned + $1, updated_at = NOW()
       WHERE user_id = $2`,
      [pointsEarned, userId]
    );
    await client.query(
      `INSERT INTO fg_earning_events (user_id, activity_type, description, points)
       VALUES ($1, 'challenge_complete', $2, $3)`,
      [userId, `Challenge: ${challenge.title}`, pointsEarned]
    );

    // Get current XP stats (unchanged — challenges no longer affect Financial XP)
    await tfrEnsureStats(userId, client);
    const currentStatsRow = (await client.query(
      'SELECT xp, level FROM tfr_user_stats WHERE user_id = $1', [userId]
    )).rows[0] || { xp: 0, level: 1 };

    // Check for monthly_20_challenges milestone (also awards User Points, not XP)
    if (challenge.type === 'daily') {
      const monthKey = getPeriodKey('monthly');
      const monthCount = (await client.query(`
        SELECT COUNT(*) FROM user_challenges uc
        JOIN engagement_challenges ec ON ec.id = uc.challenge_id
        WHERE uc.user_id = $1 AND uc.status = 'completed' AND ec.type = 'daily'
          AND uc.period_key LIKE $2
      `, [userId, `${monthKey.substring(0, 7)}%`])).rows[0].count;

      if (parseInt(monthCount) >= 20) {
        const monthlyChal = (await client.query(
          "SELECT id FROM engagement_challenges WHERE criteria_key = 'monthly_20_challenges' LIMIT 1"
        )).rows[0];
        if (monthlyChal) {
          const monthPeriod = getPeriodKey('monthly');
          const alreadyDone = (await client.query(
            'SELECT id FROM user_challenges WHERE user_id=$1 AND challenge_id=$2 AND period_key=$3 AND status=$4',
            [userId, monthlyChal.id, monthPeriod, 'completed']
          )).rows[0];
          if (!alreadyDone) {
            const bonusPoints = isPro ? 200 : 100;
            await client.query(`
              INSERT INTO user_challenges (user_id, challenge_id, period_key, status, completed_at, xp_awarded)
              VALUES ($1, $2, $3, 'completed', NOW(), $4)
              ON CONFLICT DO NOTHING
            `, [userId, monthlyChal.id, monthPeriod, bonusPoints]);
            // Award bonus User Points for 20-challenge milestone
            await client.query(
              `UPDATE fg_points_balances SET balance = balance + $1, total_earned = total_earned + $1, updated_at = NOW() WHERE user_id = $2`,
              [bonusPoints, userId]
            );
            await client.query(
              `INSERT INTO fg_earning_events (user_id, activity_type, description, points) VALUES ($1, 'challenge_complete', 'Monthly: 20 daily challenges', $2)`,
              [userId, bonusPoints]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      user_points_earned: pointsEarned, // TFR Reward Points (Aura Restored)
      xp_earned: 0, // Challenges no longer award Financial XP
      total_xp: currentStatsRow.xp,
      level: currentStatsRow.level,
      leveled_up: false, // Challenges don't affect Financial XP / level progression
      new_rank: null,
      pro_bonus: isPro,
      message: isPro ? `+${pointsEarned} FACTS Points (2× Pro bonus!)` : `+${pointsEarned} FACTS Points`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Engagement] challenge complete error:', err.message);
    res.status(500).json({ error: 'Failed to complete challenge' });
  } finally { client.release(); }
});

// POST /api/engagement/streak/freeze — burn a streak freeze (Pro only)
engagementRouter.post('/streak/freeze', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const isPro = await hasProAccess(userId);
    if (!isPro) {
      return res.status(403).json({ success: false, pro_required: true, message: 'Streak freezes are a paid feature. Upgrade to protect your streak!' });
    }

    const stats = await engEnsureStats(userId);
    const currentMonth = new Date().toISOString().substring(0, 7);

    // Grant monthly freeze if not yet given this month
    let freezes = stats.freezes_remaining || 0;
    if (stats.last_freeze_month !== currentMonth) {
      // New month: restore 1 free freeze
      await pool.query(
        'UPDATE tfr_user_stats SET freezes_remaining = 1, last_freeze_month = $1, updated_at = NOW() WHERE user_id = $2',
        [currentMonth, userId]
      );
      freezes = 1;
    }

    if (freezes < 1) {
      return res.json({ success: false, message: 'No streak freezes remaining this month. Freezes reset on the 1st.' });
    }

    // Apply freeze: set last_activity_date to today so streak doesn't break
    const today = new Date().toISOString().split('T')[0];
    await pool.query(`
      UPDATE tfr_user_stats
        SET freezes_remaining = freezes_remaining - 1,
            last_activity_date = $1,
            updated_at = NOW()
        WHERE user_id = $2
    `, [today, userId]);

    res.json({ success: true, message: 'Streak freeze used! Your streak is protected for today.', freezes_remaining: freezes - 1 });
  } catch (err) {
    console.error('[Engagement] streak freeze error:', err.message);
    res.status(500).json({ error: 'Failed to apply streak freeze' });
  }
});

// GET /api/engagement/tips — tips archive (last 14 days rotating)
engagementRouter.get('/tips', requireAuth, async (req, res) => {
  try {
    const tips = (await pool.query(
      'SELECT id, content, author, category, tip_index FROM daily_tips WHERE active = TRUE ORDER BY tip_index'
    )).rows;
    const todayIndex = getTodaysTipIndex();
    res.json({ success: true, tips, today_index: todayIndex });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tips' });
  }
});

// POST /api/engagement/tip/:id/read — mark tip as read (awards XP for read_tip challenge)
engagementRouter.post('/tip/:id/read', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.userId;

    // Try to complete the "Read today's money tip" challenge
    const challenge = (await client.query(
      "SELECT * FROM engagement_challenges WHERE criteria_key = 'read_tip' AND active = TRUE LIMIT 1"
    )).rows[0];
    if (challenge) {
      const periodKey = getPeriodKey('daily');
      const existing = (await client.query(
        'SELECT id FROM user_challenges WHERE user_id=$1 AND challenge_id=$2 AND period_key=$3 AND status=$4',
        [userId, challenge.id, periodKey, 'completed']
      )).rows[0];
      if (!existing) {
        const isPro = await hasProAccess(userId);
        const xp = isPro ? challenge.xp_reward * 2 : challenge.xp_reward;
        await client.query(`
          INSERT INTO user_challenges (user_id, challenge_id, period_key, status, completed_at, xp_awarded)
          VALUES ($1, $2, $3, 'completed', NOW(), $4)
          ON CONFLICT DO NOTHING
        `, [userId, challenge.id, periodKey, xp]);
        await tfrEnsureStats(userId, client);
        await tfrAwardXp(userId, 'challenge_complete', 'Challenge: Read today\'s money tip', xp, client);
        await client.query(
          'UPDATE tfr_user_stats SET total_points = COALESCE(total_points,0) + $1 WHERE user_id = $2',
          [xp, userId]
        );
        await client.query('COMMIT');
        return res.json({ success: true, xp_earned: xp, challenge_completed: true });
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, xp_earned: 0, challenge_completed: false });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to record tip read' });
  } finally { client.release(); }
});

// GET /api/engagement/leaderboard — top 10 by XP (Pro only, anonymous)
engagementRouter.get('/leaderboard', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const isPro = await hasProAccess(userId);
    if (!isPro) {
      return res.status(403).json({ success: false, pro_required: true, message: 'Leaderboard is a paid feature' });
    }
    const rows = (await pool.query(`
      SELECT
        ROW_NUMBER() OVER (ORDER BY xp DESC) AS rank,
        CASE WHEN user_id = $1 THEN 'You' ELSE 'Player #' || MOD(user_id * 7919, 9999)::text END AS display_name,
        xp, level, streak_days, user_id = $1 AS is_you
      FROM tfr_user_stats
      ORDER BY xp DESC
      LIMIT 10
    `, [userId])).rows;
    res.json({ success: true, leaderboard: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// ── Rewards / achievements ──
// ═══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────
// TFR REWARDS PROGRAM — /api/rewards/*
// Points economy separate from XP leveling system.
// Points are a spendable currency redeemable at Aura Restored.
// Monthly cap: 5,000 pts. Redemption: 1,000 pts = $1 store credit.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/rewards/dashboard
 * Full rewards dashboard data for the current user.
 */
rewardsRouter.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    await ensureFgBalance(userId);

    const today = new Date().toISOString().split('T')[0];
    const currentMonth = today.substring(0, 7);

    // Balance + monthly tracking
    const balRow = (await pool.query(
      `SELECT balance, total_earned, total_redeemed,
              login_streak_days, longest_login_streak,
              monthly_points_earned, monthly_cap_reset_month,
              last_login_streak_date
       FROM fg_points_balances WHERE user_id = $1`,
      [userId]
    )).rows[0] || {};

    const monthlyEarned = balRow.monthly_cap_reset_month === currentMonth
      ? (parseInt(balRow.monthly_points_earned) || 0) : 0;

    // Recent earning history (last 30 events)
    const history = (await pool.query(
      `SELECT activity_type, description, points, created_at
       FROM fg_earning_events WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 30`,
      [userId]
    )).rows;

    // Redemption codes
    const codes = (await pool.query(
      `SELECT code, points_spent, dollar_value_cents, status, generated_at, expires_at, used_at
       FROM rewards_discount_codes WHERE user_id = $1
       ORDER BY generated_at DESC LIMIT 20`,
      [userId]
    )).rows;

    // Achievements
    const earnedAchievements = (await pool.query(
      `SELECT achievement_key, points_awarded, earned_at FROM rewards_achievements WHERE user_id = $1`,
      [userId]
    )).rows;
    const earnedKeys = new Set(earnedAchievements.map(a => a.achievement_key));

    // Also check tfr_achievements for checkin streaks
    const tfrAchs = (await pool.query(
      `SELECT achievement_key FROM tfr_achievements WHERE user_id = $1`,
      [userId]
    )).rows;
    const tfrAchKeys = new Set(tfrAchs.map(a => a.achievement_key));

    // Define all achievements
    const ALL_ACHIEVEMENTS = [
      { key: 'first_transaction',    label: 'First Transaction Logged',     points: 25, icon: '💸', description: 'Log your first transaction' },
      { key: 'first_checkin',        label: 'First Daily Check-in',         points: 0,  icon: '✅', description: 'Complete your first daily check-in' },
      { key: 'first_budget',         label: 'First Budget Set',             points: 50, icon: '📊', description: 'Set all 6 FACTS allocation categories' },
      { key: 'first_debt_milestone', label: 'First Debt Payoff Milestone',  points: 100,icon: '🎯', description: 'Pay off any portion of a debt' },
      { key: 'credit_report_uploaded', label: 'Credit Report Uploaded',    points: 50, icon: '📄', description: 'Upload your credit report' },
      { key: 'discovery_scan',       label: 'Discovery Scan Complete',      points: 75, icon: '🔍', description: 'Complete your first Discovery Scan' },
      { key: 'plaid_connected',      label: 'Bank Connected via Plaid',     points: 100,icon: '🏦', description: 'Connect a bank account (Pro)' },
      { key: 'login_streak_7',       label: '7-Day Login Streak',           points: 50, icon: '🔥', description: 'Log in 7 days in a row' },
      { key: 'login_streak_14',      label: '14-Day Login Streak',          points: 100,icon: '⚡', description: 'Log in 14 days in a row' },
      { key: 'login_streak_30',      label: '30-Day Login Streak',          points: 250,icon: '👑', description: 'Log in 30 days in a row' },
    ];

    const achievementsWithStatus = ALL_ACHIEVEMENTS.map(a => ({
      ...a,
      earned: earnedKeys.has(a.key) || tfrAchKeys.has(a.key),
      earned_at: earnedAchievements.find(e => e.achievement_key === a.key)?.earned_at || null,
    }));

    // Active challenges (weekly + monthly)
    const activeChallenges = (await pool.query(`
      SELECT ec.id, ec.title, ec.description, ec.type, ec.xp_reward, ec.points_reward, ec.criteria_key,
             uc.status AS user_status, uc.completed_at, uc.period_key
      FROM engagement_challenges ec
      LEFT JOIN user_challenges uc
        ON uc.challenge_id = ec.id AND uc.user_id = $1 AND uc.period_key = (
          CASE ec.type
            WHEN 'weekly' THEN to_char(now(), 'IYYY-IW')
            WHEN 'monthly' THEN to_char(now(), 'YYYY-MM')
            ELSE to_char(now(), 'YYYY-MM-DD')
          END
        )
      WHERE ec.active = TRUE AND ec.type IN ('weekly','monthly') AND ec.points_reward > 0
      ORDER BY ec.type DESC, ec.sort_order
    `, [userId])).rows;

    // Login streak info
    const loginStreak = {
      current: parseInt(balRow.login_streak_days) || 0,
      longest: parseInt(balRow.longest_login_streak) || 0,
      next_milestone: [7, 14, 30].find(m => m > (parseInt(balRow.login_streak_days) || 0)) || null,
      next_milestone_bonus: null,
    };
    if (loginStreak.next_milestone) {
      loginStreak.next_milestone_bonus = { 7: 50, 14: 100, 30: 250 }[loginStreak.next_milestone];
    }

    res.json({
      success: true,
      points: {
        balance: parseInt(balRow.balance) || 0,
        total_earned: parseInt(balRow.total_earned) || 0,
        total_redeemed: parseInt(balRow.total_redeemed) || 0,
        monthly_earned: monthlyEarned,
        monthly_cap: 5000,
        monthly_remaining: Math.max(0, 5000 - monthlyEarned),
        monthly_cap_pct: Math.min(100, Math.round((monthlyEarned / 5000) * 100)),
      },
      login_streak: loginStreak,
      history,
      discount_codes: codes,
      achievements: achievementsWithStatus,
      active_challenges: activeChallenges,
      redemption_info: {
        min_redemption: 1000,
        rate: '1,000 pts = $1.00 store credit',
        store: 'Aura Restored',
        expiration_days: 90,
      },
    });
  } catch (err) {
    console.error('[Rewards] GET /api/rewards/dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load rewards dashboard' });
  }
});

/**
 * POST /api/rewards/daily-interaction
 * Records that the user had a meaningful app interaction today.
 * Awards 10 FACTS Points (max once per calendar day).
 * A "meaningful interaction" means the user navigated to a core feature,
 * logged data, or completed an action — not just opened the app.
 */
rewardsRouter.post('/daily-interaction', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { action } = req.body || {};
    await ensureFgBalance(userId);

    const today = new Date().toISOString().split('T')[0];
    const currentMonth = today.substring(0, 7);

    // Check if already awarded today (last_daily_points_date covers the login award;
    // we use a separate mechanism here but login already awards 10 pts)
    // This endpoint is for non-login interactions (e.g., viewing dashboard, transactions, etc.)
    // We reuse last_daily_points_date since login already sets it; this is a no-op if already logged in today.
    const balRow = (await pool.query(
      'SELECT last_daily_points_date, monthly_points_earned, monthly_cap_reset_month FROM fg_points_balances WHERE user_id = $1',
      [userId]
    )).rows[0] || {};

    const alreadyAwarded = balRow.last_daily_points_date &&
      String(balRow.last_daily_points_date).split('T')[0] === today;

    if (alreadyAwarded) {
      return res.json({ success: true, already_done: true, message: 'Daily interaction points already awarded today' });
    }

    const monthEarned = balRow.monthly_cap_reset_month === currentMonth
      ? (parseInt(balRow.monthly_points_earned) || 0) : 0;
    const remaining = Math.max(0, 5000 - monthEarned);
    const toAward = Math.min(10, remaining);

    if (toAward > 0) {
      await pool.query(
        `UPDATE fg_points_balances
         SET balance = balance + $2,
             total_earned = total_earned + $2,
             last_daily_points_date = $3,
             monthly_points_earned = CASE WHEN monthly_cap_reset_month = $4 THEN monthly_points_earned + $2 ELSE $2 END,
             monthly_cap_reset_month = $4,
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId, toAward, today, currentMonth]
      );
      await pool.query(
        `INSERT INTO fg_earning_events (user_id, activity_type, description, points)
         VALUES ($1, 'daily_interaction', $2, $3)`,
        [userId, `Daily interaction: ${action || 'app session'} — ${toAward} FACTS Points`, toAward]
      );
    } else {
      // Still record the date to suppress duplicate calls even when capped
      await pool.query(
        'UPDATE fg_points_balances SET last_daily_points_date = $2, updated_at = NOW() WHERE user_id = $1',
        [userId, today]
      );
    }

    res.json({
      success: true,
      points_awarded: toAward,
      capped: toAward < 10,
      message: toAward > 0 ? `+${toAward} FACTS Points for today's activity` : 'Monthly cap reached',
    });
  } catch (err) {
    console.error('[Rewards] POST /api/rewards/daily-interaction error:', err.message);
    res.status(500).json({ error: 'Failed to record daily interaction' });
  }
});

/**
 * POST /api/rewards/redeem
 * Redeem FACTS Points for an Aura Restored discount code.
 * Body: { points: number }
 * Min: 1,000 pts. Rate: 1,000 pts = $1.
 * Points deducted immediately. Code expires in 90 days.
 */
rewardsRouter.post('/redeem', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = req.userId;
    const requestedPoints = parseInt(req.body && req.body.points) || 0;

    if (requestedPoints < 1000) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Minimum redemption is 1,000 points ($1.00 value)' });
    }
    if (requestedPoints % 1000 !== 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Points must be in multiples of 1,000' });
    }

    await ensureFgBalance(userId);
    const balRow = (await client.query(
      'SELECT balance FROM fg_points_balances WHERE user_id = $1',
      [userId]
    )).rows[0];

    if (!balRow || parseInt(balRow.balance) < requestedPoints) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient points. You have ${parseInt(balRow?.balance) || 0} pts, need ${requestedPoints} pts.` });
    }

    const dollarValueCents = (requestedPoints / 1000) * 100; // 1000 pts = $1 = 100 cents

    // Generate unique discount code: TFR-[USER_ID]-[RANDOM6]
    const randomSuffix = crypto.randomBytes(3).toString('hex').toUpperCase();
    const code = `TFR-${userId}-${randomSuffix}`;

    // Deduct points
    await client.query(
      `UPDATE fg_points_balances
       SET balance = balance - $2,
           total_redeemed = total_redeemed + $2,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, requestedPoints]
    );

    // Record redemption event
    await client.query(
      `INSERT INTO fg_redemption_events (user_id, item_name, points_spent, external_ref, status)
       VALUES ($1, 'Aura Restored Store Credit', $2, $3, 'completed')`,
      [userId, requestedPoints, code]
    );

    // Create discount code record
    const codeRow = (await client.query(
      `INSERT INTO rewards_discount_codes (user_id, code, points_spent, dollar_value_cents, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING *`,
      [userId, code, requestedPoints, dollarValueCents]
    )).rows[0];

    await client.query('COMMIT');

    // Fetch user email for notification (fire-and-forget)
    const userRow = (await pool.query('SELECT email, name FROM users WHERE id = $1', [userId])).rows[0];

    res.json({
      success: true,
      code: code,
      points_spent: requestedPoints,
      dollar_value: (dollarValueCents / 100).toFixed(2),
      expires_at: codeRow.expires_at,
      message: `Your Aura Restored discount code: ${code}`,
      instructions: 'Use this code at checkout on the Aura Restored store. Valid for 90 days.',
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Rewards] POST /api/rewards/redeem error:', err.message);
    res.status(500).json({ error: 'Redemption failed. Please try again.' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/rewards/codes
 * List all discount codes for the current user.
 */
rewardsRouter.get('/codes', requireAuth, async (req, res) => {
  try {
    const codes = (await pool.query(
      `SELECT code, points_spent, dollar_value_cents, status, generated_at, expires_at, used_at
       FROM rewards_discount_codes WHERE user_id = $1
       ORDER BY generated_at DESC`,
      [req.userId]
    )).rows;
    // Mark expired codes
    const now = new Date();
    await pool.query(
      `UPDATE rewards_discount_codes SET status = 'expired'
       WHERE user_id = $1 AND status = 'active' AND expires_at < NOW()`,
      [req.userId]
    );
    res.json({ success: true, codes });
  } catch (err) {
    console.error('[Rewards] GET /api/rewards/codes error:', err.message);
    res.status(500).json({ error: 'Failed to load discount codes' });
  }
});

/**
 * POST /api/rewards/achievement
 * Award a one-time achievement to the current user.
 * Called by frontend after specific actions (budget set, Plaid connect, etc.)
 * Body: { achievement_key: string }
 */
rewardsRouter.post('/achievement', requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { achievement_key } = req.body || {};

    const ACHIEVEMENT_POINTS = {
      first_budget:          50,
      first_debt_milestone: 100,
      credit_report_uploaded: 50,
      discovery_scan:        75,
      plaid_connected:      100,
    };

    if (!achievement_key || !ACHIEVEMENT_POINTS[achievement_key]) {
      return res.status(400).json({ error: 'Invalid or unsupported achievement key' });
    }

    // Check if already earned
    const existing = (await pool.query(
      'SELECT id FROM rewards_achievements WHERE user_id = $1 AND achievement_key = $2',
      [userId, achievement_key]
    )).rows[0];
    if (existing) {
      return res.json({ success: true, already_earned: true, message: 'Achievement already unlocked' });
    }

    const pts = ACHIEVEMENT_POINTS[achievement_key];
    await ensureFgBalance(userId);
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = today.substring(0, 7);
    const balRow = (await pool.query(
      'SELECT monthly_points_earned, monthly_cap_reset_month FROM fg_points_balances WHERE user_id = $1',
      [userId]
    )).rows[0] || {};
    const monthEarned = balRow.monthly_cap_reset_month === currentMonth
      ? (parseInt(balRow.monthly_points_earned) || 0) : 0;
    const toAward = Math.min(pts, Math.max(0, 5000 - monthEarned));

    if (toAward > 0) {
      await pool.query(
        `UPDATE fg_points_balances
         SET balance = balance + $2,
             total_earned = total_earned + $2,
             monthly_points_earned = CASE WHEN monthly_cap_reset_month = $3 THEN monthly_points_earned + $2 ELSE $2 END,
             monthly_cap_reset_month = $3,
             updated_at = NOW()
         WHERE user_id = $1`,
        [userId, toAward, currentMonth]
      );
      await pool.query(
        `INSERT INTO fg_earning_events (user_id, activity_type, description, points)
         VALUES ($1, 'achievement', $2, $3)`,
        [userId, `Achievement unlocked: ${achievement_key.replace(/_/g,' ')} — ${toAward} FACTS Points`, toAward]
      );
    }

    await pool.query(
      `INSERT INTO rewards_achievements (user_id, achievement_key, points_awarded)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, achievement_key, toAward || 0]
    );

    res.json({
      success: true,
      achievement_key,
      points_awarded: toAward,
      message: `Achievement unlocked! +${toAward} FACTS Points`,
    });
  } catch (err) {
    console.error('[Rewards] POST /api/rewards/achievement error:', err.message);
    res.status(500).json({ error: 'Failed to record achievement' });
  }
});

/**
 * POST /api/rewards/referral
 * Award referral points when a referred user completes signup + activation.
 * Called internally — not directly by the client.
 * Also enforces 5 referral bonuses/month cap.
 */
async function awardReferralPoints(referrerId, referredUserId) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = today.substring(0, 7);
    await ensureFgBalance(referrerId);

    // Check monthly referral cap (5 referrals = 2,500 pts max per month)
    const monthlyReferrals = (await pool.query(
      `SELECT COUNT(*) AS cnt FROM fg_earning_events
       WHERE user_id = $1 AND activity_type = 'referral'
         AND to_char(created_at, 'YYYY-MM') = $2`,
      [referrerId, currentMonth]
    )).rows[0]?.cnt || 0;

    if (parseInt(monthlyReferrals) >= 5) {
      console.log(`[Rewards] Referral cap reached for user ${referrerId} this month`);
      return { awarded: false, reason: 'monthly_referral_cap' };
    }

    const balRow = (await pool.query(
      'SELECT monthly_points_earned, monthly_cap_reset_month FROM fg_points_balances WHERE user_id = $1',
      [referrerId]
    )).rows[0] || {};
    const monthEarned = balRow.monthly_cap_reset_month === currentMonth
      ? (parseInt(balRow.monthly_points_earned) || 0) : 0;
    const toAward = Math.min(500, Math.max(0, 5000 - monthEarned));

    if (toAward > 0) {
      await pool.query(
        `UPDATE fg_points_balances
         SET balance = balance + $2,
             total_earned = total_earned + $2,
             monthly_points_earned = CASE WHEN monthly_cap_reset_month = $3 THEN monthly_points_earned + $2 ELSE $2 END,
             monthly_cap_reset_month = $3,
             updated_at = NOW()
         WHERE user_id = $1`,
        [referrerId, toAward, currentMonth]
      );
      await pool.query(
        `INSERT INTO fg_earning_events (user_id, activity_type, description, points)
         VALUES ($1, 'referral', $2, $3)`,
        [referrerId, `Referral bonus: friend signed up and activated — ${toAward} FACTS Points`, toAward]
      );
    }
    return { awarded: true, points: toAward };
  } catch (err) {
    console.error('[Rewards] awardReferralPoints error:', err.message);
    return { awarded: false, error: err.message };
  }
}

// Serve rewards dashboard page
pageRouter.get('/rewards', requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC, 'rewards.html'));
});

// ─────────────────────────────────────────────────────────────────────────────
// Monthly cap reset job — runs once daily at 00:05 UTC
// Resets monthly_points_earned for users whose cap month has rolled over
// ─────────────────────────────────────────────────────────────────────────────
(function scheduleRewardsJobs() {
  const FIVE_MINUTES = 5 * 60 * 1000;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  // Run daily maintenance
  async function runDailyRewardsMaintenance() {
    try {
      const currentMonth = new Date().toISOString().substring(0, 7);
      // Reset monthly_points_earned for users in a stale month
      const resetResult = await pool.query(
        `UPDATE fg_points_balances
         SET monthly_points_earned = 0,
             monthly_cap_reset_month = $1
         WHERE monthly_cap_reset_month IS NOT NULL
           AND monthly_cap_reset_month != $1`,
        [currentMonth]
      );
      if (resetResult.rowCount > 0) {
        console.log(`[Rewards] Monthly cap reset for ${resetResult.rowCount} users (new month: ${currentMonth})`);
      }

      // Expire discount codes past their expiry date
      const expiredResult = await pool.query(
        `UPDATE rewards_discount_codes SET status = 'expired'
         WHERE status = 'active' AND expires_at < NOW()`
      );
      if (expiredResult.rowCount > 0) {
        console.log(`[Rewards] Expired ${expiredResult.rowCount} discount codes`);
      }
    } catch (err) {
      console.error('[Rewards] Daily maintenance error:', err.message);
    }
  }

  // Run after a short delay on startup, then every 24 hours
  setTimeout(() => {
    runDailyRewardsMaintenance();
    setInterval(runDailyRewardsMaintenance, ONE_DAY);
  }, FIVE_MINUTES);
})();

module.exports = {
  tfrRouter,
  engagementRouter,
  rewardsRouter,
  futureGenerationsRouter,
  pageRouter,
  bindGamificationRuntime,
  tryAutoCompleteChallenge,
  getPeriodKey,
  verifyChallengeCompletion,
  recordActivity,
  hasActivityToday,
  ensureActivityTable
};
