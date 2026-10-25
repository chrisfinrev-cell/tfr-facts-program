/**
 * mod_ai_coach — AI Financial Coach
 *
 * Owns: tiered nudge engine, chat sessions, rate limiting by tier,
 *       archetype-aware coaching, upgrade hooks for upsell prompts.
 *
 * Does NOT own: OpenAI billing, Stripe payment processing, user auth sessions,
 *               Phase Zero flow, gamification XP awards.
 *
 * AI MANDATORY: All AI calls go to OpenAI via lib/aiClient (OPENAI_API_KEY).
 * Never instantiate AI SDK clients directly for product AI features.
 *
 * Routes (auto-mounted at /api/mod_ai_coach):
 *   GET  /health                    — module health check
 *   GET  /nudge                     — get tiered nudge/tip for current user
 *   POST /chat                      — send chat message, get AI response
 *   GET  /chat/history              — paginated chat history
 *   DELETE /chat/history            — clear chat history
 *   GET  /limits                    — current rate limit status
 *   GET  /upgrade-hook              — check if AI should surface an upgrade prompt
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const { asyncRoute } = require('../../module-error-boundary');
const { chat } = require('../../lib/aiClient');

// ─── Tier-based rate limits (messages per day) ────────────────────────────────
const TIER_DAILY_LIMITS = {
  free:                 0,   // No AI chat for free tier
  individual_pro:       10,
  tfr_pro:              20,  // Family
  business_core:        30,
  business_bundle:      50,
  tfr_elite:            100,
  sovereign_executive:  -1,  // Unlimited
};

// ─── Tier-based nudge intelligence level ─────────────────────────────────────
const TIER_NUDGE_LEVEL = {
  free:                 'generic',       // Static tips only
  individual_pro:       'basic',         // Personalized to allocation data
  tfr_pro:              'household',     // Family-aware tips
  business_core:        'business',      // Business FACTS tips
  business_bundle:      'advanced',      // Predictive, trend-aware
  tfr_elite:            'strategic',     // Wealth-building, HELOC-aware
  sovereign_executive:  'anticipatory',  // Anticipatory insights, succession
};

// ─── Static generic tips (free tier only) ─────────────────────────────────────
const GENERIC_TIPS = [
  "The FACTS method starts with Necessities. Have you reviewed your 50% baseline this month?",
  "Reserve (10%) is your financial immune system. Are you building it consistently?",
  "Velocity (10%) is about momentum — every dollar you deploy intentionally moves you forward.",
  "Legacy allocation isn't just for the wealthy. Start with 1% and let it compound.",
  "Growth capital works hardest when it's deployed, not sitting in a savings account.",
  "Lifestyle spending is guilt-free when the other 5 buckets are funded first.",
  "Financial sovereignty starts with knowing your numbers. Log every transaction this week.",
  "Your Phase Zero archetype shapes your financial instincts. Trust the system, not the feeling.",
];

const {
  AI_SYSTEM_GUARDRAILS,
  AI_RESPONSE_FOOTER,
  SHORT_DISCLAIMER,
} = require('../shared/edu-compliance');

// ─── System prompts by intelligence level ─────────────────────────────────────
function buildSystemPrompt(level, userData, archetypeData) {
  const archetype = archetypeData?.archetype || 'undetermined';
  const baseContext = `You are the FACTS AI Coach — an educational financial literacy assistant for the FACTS (Financial Allocation Control & Tracking System) platform.
You teach budgeting/allocation frameworks. You are NOT a licensed advisor and do NOT provide regulated advice.

FACTS METHODOLOGY (educational framework only): Users allocate income across 6 purpose-driven categories:
1. Necessities (50% default) — housing, utilities, food, transport
2. Reserve (10%) — emergency fund, financial immune system
3. Velocity (10%) — momentum capital, deployed investments
4. Growth (10%) — long-term wealth building
5. Lifestyle (10%) — guilt-free personal spending
6. Legacy (10%) — generational wealth, giving

User's financial archetype (from Phase Zero assessment): ${archetype}
${archetypeData?.description ? `Archetype description: ${archetypeData.description}` : ''}

COACHING PRINCIPLES:
- Ground guidance in FACTS methodology as education, not directives
- Reference the user's archetype when relevant
- Be direct, practical, never preachy
- Celebrate wins without being sycophantic
- When data is limited, ask targeted questions
- Never give investment, tax, legal, lending, insurance, or credit-repair advice — guide allocation thinking only
- NEVER mention the underlying AI provider or model, or that you're an AI system

${AI_SYSTEM_GUARDRAILS}`;

  if (level === 'generic' || level === 'basic') {
    return baseContext + '\n\nKeep responses under 150 words. Focus on practical FACTS allocation guidance.';
  }

  const allocationContext = userData?.allocations
    ? `\nUser's current allocations: ${JSON.stringify(userData.allocations)}`
    : '';
  const transactionContext = userData?.recent_summary
    ? `\nRecent spending summary: ${JSON.stringify(userData.recent_summary)}`
    : '';

  if (level === 'household') {
    return baseContext + allocationContext + transactionContext
      + '\n\nThis is a Family tier user. Consider household dynamics, shared goals, and family financial coordination. Keep responses under 200 words.';
  }

  if (level === 'business') {
    return baseContext + allocationContext + transactionContext
      + '\n\nThis is a Business tier user. Reference business FACTS allocations (Operations, Reserves, Taxes, Marketing, Innovation). Keep responses under 200 words.';
  }

  if (level === 'advanced' || level === 'strategic') {
    return baseContext + allocationContext + transactionContext
      + '\n\nThis is an advanced user. You may discuss educational trend analysis, HELOC concepts (not directives), sovereignty scoring, and wealth-building trajectories as literacy only. Never recommend specific loans or investments. Responses up to 300 words.';
  }

  if (level === 'anticipatory') {
    return baseContext + allocationContext + transactionContext
      + '\n\nThis is a Sovereign user. You have access to full financial picture. Provide anticipatory, proactive insights — identify patterns before the user notices them. Reference succession planning and legacy building. Responses up to 400 words.';
  }

  return baseContext;
}

// ─── DB Pool ───────────────────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });
  }
  return _pool;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.userId = req.session.userId;
  next();
}

// ─── Get user tier (normalize) ────────────────────────────────────────────────
async function getUserTier(userId) {
  const pool = getPool();
  const r = await pool.query(
    'SELECT pricing_tier, plan, paid_until, email, is_creator FROM users WHERE id = $1',
    [userId]
  );
  if (!r.rows.length) return 'free';
  const u = r.rows[0];

  const ownerEmails = (process.env.OWNER_EMAILS || 'ecci2760@gmail.com,ecci2760f@gmail.com,dianes3cps@gmail.com')
    .split(',').map(e => e.trim().toLowerCase());
  if (u.is_creator || ownerEmails.includes((u.email || '').toLowerCase())) {
    return 'sovereign_executive';
  }

  const legacyMap = { pro: 'individual_pro', household_pro: 'tfr_pro', none: 'free' };
  const tier = legacyMap[u.pricing_tier] || u.pricing_tier || 'free';

  // Verify subscription is active (except free + sovereign)
  if (tier === 'free' || tier === 'sovereign_executive') return tier;
  const isActive = u.plan === 'paid' && u.paid_until && new Date(u.paid_until) > new Date();
  return isActive ? tier : 'free';
}

// ─── Get user allocation data (for personalized nudges) ───────────────────────
async function getUserAllocationData(userId) {
  const pool = getPool();
  try {
    // Recent allocations
    const allocResult = await pool.query(
      `SELECT category_name, percentage FROM user_allocations
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 6`,
      [userId]
    );

    // Phase Zero archetype
    const pzResult = await pool.query(
      `SELECT metadata FROM user_events
       WHERE user_id = $1 AND event_type = 'phase_zero_completed'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    // Recent transaction summary (last 30 days by category)
    const txResult = await pool.query(
      `SELECT category, SUM(amount) as total, COUNT(*) as count
       FROM transactions
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY category
       ORDER BY total DESC
       LIMIT 6`,
      [userId]
    );

    const archetype = pzResult.rows[0]?.metadata?.archetype || null;
    const archetypeDesc = pzResult.rows[0]?.metadata?.archetype_description || null;

    return {
      allocations: allocResult.rows,
      archetype,
      archetype_description: archetypeDesc,
      recent_summary: txResult.rows,
    };
  } catch (e) {
    return { allocations: [], archetype: null, recent_summary: [] };
  }
}

// ─── Check and increment daily rate limit ────────────────────────────────────
async function checkRateLimit(userId, tier) {
  const limit = TIER_DAILY_LIMITS[tier] ?? 0;
  if (limit === -1) return { allowed: true, remaining: -1, limit: -1 }; // Unlimited

  if (limit === 0) {
    return {
      allowed: false,
      remaining: 0,
      limit: 0,
      upgrade_required: true,
      message: 'AI coaching is available for Individual tier and above.',
      upgrade_tier: 'individual_pro',
    };
  }

  const pool = getPool();

  // Count messages sent today
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const r = await pool.query(
    `SELECT COUNT(*) as count FROM ai_coach_messages
     WHERE user_id = $1 AND role = 'user' AND created_at >= $2`,
    [userId, today]
  );

  const usedToday = parseInt(r.rows[0]?.count || 0, 10);
  const remaining = Math.max(0, limit - usedToday);

  return {
    allowed: usedToday < limit,
    remaining,
    limit,
    used_today: usedToday,
    resets_at: new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };
}

// ─── Call AI (OpenAI via lib/aiClient) ────────────────────────────────────────
async function callAI(messages, systemPrompt) {
  const text = await chat(messages, systemPrompt, { maxTokens: 1024 });
  return text || 'I encountered an error generating a response. Please try again.';
}

// ─── Router ───────────────────────────────────────────────────────────────────
const router = express.Router();

// GET /api/mod_ai_coach/health
router.get('/health', asyncRoute(async (req, res) => {
  res.json({ status: 'ok', module: 'mod_ai_coach', version: '1.0.0' });
}));

/**
 * GET /api/mod_ai_coach/nudge
 * Returns a tiered nudge/tip. Free = static, paid = AI-generated + personalized.
 */
router.get('/nudge', requireAuth, asyncRoute(async (req, res) => {
  const tier = await getUserTier(req.userId);
  const level = TIER_NUDGE_LEVEL[tier] || 'generic';

  if (level === 'generic') {
    // Static tip — no AI call needed
    const tip = GENERIC_TIPS[Math.floor(Math.random() * GENERIC_TIPS.length)];
    return res.json({
      nudge: tip,
      tier,
      level: 'generic',
      is_ai: false,
      upgrade_hook: {
        show: true,
        message: 'Unlock personalized AI coaching with Individual tier.',
        cta: 'Upgrade for $9.99/mo',
        target_tier: 'individual_pro',
      },
    });
  }

  // AI-generated nudge for paid tiers
  const userData = await getUserAllocationData(req.userId);
  const systemPrompt = buildSystemPrompt(level, userData, { archetype: userData.archetype, description: userData.archetype_description });

  let nudgeText;
  try {
    nudgeText = await callAI([
      {
        role: 'user',
        content: `Generate a single, actionable financial nudge for me based on my FACTS allocations and spending patterns. Keep it to 2-3 sentences. Focus on the most impactful thing I could do right now.${userData.archetype ? ` Remember my archetype is ${userData.archetype}.` : ''}`,
      }
    ], systemPrompt);
  } catch (e) {
    // Fallback to generic on AI error
    nudgeText = GENERIC_TIPS[Math.floor(Math.random() * GENERIC_TIPS.length)];
  }

  // Upgrade hook for tiers that could get more
  const upgradeHook = tier === 'individual_pro' ? {
    show: true,
    message: 'Family tier unlocks household insights and 20 more messages per day.',
    cta: 'Upgrade to Family',
    target_tier: 'tfr_pro',
  } : null;

  res.json({
    nudge: nudgeText,
    tier,
    level,
    is_ai: true,
    archetype: userData.archetype,
    upgrade_hook: upgradeHook,
  });
}));

/**
 * GET /api/mod_ai_coach/limits
 * Returns current rate limit status.
 */
router.get('/limits', requireAuth, asyncRoute(async (req, res) => {
  const tier = await getUserTier(req.userId);
  const status = await checkRateLimit(req.userId, tier);
  res.json({ tier, ...status });
}));

/**
 * POST /api/mod_ai_coach/chat
 * Body: { message }
 * Returns: { reply, remaining, upgrade_hook? }
 */
router.post('/chat', requireAuth, asyncRoute(async (req, res) => {
  const { message } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required' });
  }

  const userMessage = message.trim().slice(0, 2000); // Cap message length
  const tier = await getUserTier(req.userId);
  const pool = getPool();

  // Check rate limit
  const rateCheck = await checkRateLimit(req.userId, tier);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: 'Daily message limit reached',
      ...rateCheck,
    });
  }

  // Get user data for context
  const userData = await getUserAllocationData(req.userId);
  const level = TIER_NUDGE_LEVEL[tier] || 'generic';
  const systemPrompt = buildSystemPrompt(level, userData, {
    archetype: userData.archetype,
    description: userData.archetype_description,
  });

  // Load recent conversation history (last 10 turns = 20 messages)
  const historyResult = await pool.query(
    `SELECT role, content FROM ai_coach_messages
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 20`,
    [req.userId]
  );
  const history = historyResult.rows.reverse(); // oldest first

  // Build messages array for AI
  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];

  // Call AI
  let reply;
  try {
    reply = await callAI(messages, systemPrompt);
  } catch (e) {
    console.error('[mod_ai_coach] AI call failed:', e.message);
    return res.status(503).json({ error: 'AI service temporarily unavailable. Please try again.' });
  }

  // Persist both messages
  await pool.query(
    `INSERT INTO ai_coach_messages (user_id, role, content, tier, created_at)
     VALUES ($1, 'user', $2, $3, NOW()),
            ($1, 'assistant', $4, $3, NOW())`,
    [req.userId, userMessage, tier, reply]
  );

  // Re-check remaining after this message
  const newRateCheck = await checkRateLimit(req.userId, tier);

  // Upgrade hook: surface when nearing daily educational message limit
  let upgradeHook = null;
  if (newRateCheck.remaining !== -1 && newRateCheck.remaining <= 2 && tier !== 'sovereign_executive') {
    const nextTiers = {
      individual_pro: { tier: 'tfr_pro', name: 'Family', limit: TIER_DAILY_LIMITS['tfr_pro'] },
      tfr_pro:        { tier: 'business_bundle', name: 'Business', limit: TIER_DAILY_LIMITS['business_bundle'] },
      business_bundle:{ tier: 'tfr_elite', name: 'Elite', limit: TIER_DAILY_LIMITS['tfr_elite'] },
      tfr_elite:      { tier: 'sovereign_executive', name: 'Sovereign', limit: -1 },
    };
    const next = nextTiers[tier];
    if (next) {
      upgradeHook = {
        show: true,
        message: `You have ${newRateCheck.remaining} AI messages left today. ${next.name} tier gives you ${next.limit === -1 ? 'unlimited' : next.limit} messages/day.`,
        cta: `Upgrade to ${next.name}`,
        target_tier: next.tier,
      };
    }
  }

  // Ensure educational footer is present on API responses (not stored twice if model already added it)
  const replyWithDisclaimer = reply.includes('Educational illustration only')
    ? reply
    : (reply + AI_RESPONSE_FOOTER);

  res.json({
    reply: replyWithDisclaimer,
    disclaimer: SHORT_DISCLAIMER,
    tier,
    remaining: newRateCheck.remaining,
    limit: newRateCheck.limit,
    upgrade_hook: upgradeHook,
  });
}));

/**
 * GET /api/mod_ai_coach/chat/history?page=1&per_page=20
 * Returns paginated chat history.
 */
router.get('/chat/history', requireAuth, asyncRoute(async (req, res) => {
  const tier = await getUserTier(req.userId);
  if (TIER_DAILY_LIMITS[tier] === 0) {
    return res.status(403).json({ error: 'AI coaching not available on free tier' });
  }

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(50, parseInt(req.query.per_page) || 20);
  const offset = (page - 1) * perPage;

  const pool = getPool();
  const r = await pool.query(
    `SELECT id, role, content, created_at FROM ai_coach_messages
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.userId, perPage, offset]
  );

  const countR = await pool.query(
    'SELECT COUNT(*) as total FROM ai_coach_messages WHERE user_id = $1',
    [req.userId]
  );

  res.json({
    messages: r.rows.reverse(), // return in chronological order
    total: parseInt(countR.rows[0]?.total || 0),
    page,
    per_page: perPage,
  });
}));

/**
 * DELETE /api/mod_ai_coach/chat/history
 * Clears all chat history for the current user.
 */
router.delete('/chat/history', requireAuth, asyncRoute(async (req, res) => {
  const pool = getPool();
  await pool.query('DELETE FROM ai_coach_messages WHERE user_id = $1', [req.userId]);
  res.json({ success: true, message: 'Chat history cleared' });
}));

/**
 * GET /api/mod_ai_coach/upgrade-hook
 * Returns contextual upgrade suggestion based on usage patterns.
 */
router.get('/upgrade-hook', requireAuth, asyncRoute(async (req, res) => {
  const tier = await getUserTier(req.userId);
  const rateCheck = await checkRateLimit(req.userId, tier);

  if (tier === 'sovereign_executive') {
    return res.json({ show: false });
  }

  if (tier === 'free') {
    return res.json({
      show: true,
      context: 'no_access',
      message: 'Get personalized AI coaching based on your FACTS allocations.',
      cta: 'Start Individual Plan — $9.99/mo',
      target_tier: 'individual_pro',
    });
  }

  const usageRatio = rateCheck.limit > 0 ? (rateCheck.used_today || 0) / rateCheck.limit : 0;
  if (usageRatio >= 0.7) {
    const nextTiers = {
      individual_pro: 'tfr_pro',
      tfr_pro:        'business_bundle',
      business_bundle:'tfr_elite',
      tfr_elite:      'sovereign_executive',
    };
    const nextTier = nextTiers[tier];
    if (nextTier) {
      const nextLimit = TIER_DAILY_LIMITS[nextTier];
      return res.json({
        show: true,
        context: 'near_limit',
        message: `You've used ${Math.round(usageRatio * 100)}% of your daily AI messages.`,
        cta: `Unlock ${nextLimit === -1 ? 'unlimited' : nextLimit} messages/day`,
        target_tier: nextTier,
        current_usage: rateCheck.used_today,
        current_limit: rateCheck.limit,
      });
    }
  }

  res.json({ show: false });
}));

// ─── Module export ────────────────────────────────────────────────────────────
module.exports = {
  metadata: {
    name: 'AI Financial Coach',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true,
  },
  routes: router,
  healthCheck: async () => ({
    module: 'mod_ai_coach',
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  }),
};
