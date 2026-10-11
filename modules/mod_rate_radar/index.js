/**
 * mod_rate_radar — Rate Radar: Bill Tracking + AI Comparison Engine
 *
 * Owns: recurring bill tracking, bill scan (AI OCR), AI comparison engine,
 *       savings dashboard, comparison results, refresh scheduling.
 *
 * Does NOT own: user auth sessions, Stripe payments, FACTS allocations engine,
 *               gamification XP, Plaid bank sync.
 *
 * Tier gate: Individual+ (tier rank >= 1). Free tier sees locked CTA.
 *
 * Routes (auto-mounted at /api/mod_rate_radar):
 *   GET    /health
 *   GET    /bills                  — list all bills for current user
 *   POST   /bills                  — add a bill manually
 *   PUT    /bills/:id              — update a bill
 *   DELETE /bills/:id              — delete a bill
 *   POST   /bills/scan             — upload bill image/PDF → AI OCR extraction
 *   GET    /bills/:id/comparison   — get latest comparison for a bill
 *   POST   /bills/:id/compare      — trigger AI comparison for a bill
 *   POST   /compare-all            — trigger AI comparison for all bills
 *   DELETE /bills/:id/alternatives/:key/dismiss  — dismiss an alternative
 *   GET    /dashboard              — savings dashboard summary
 */

'use strict';

const express  = require('express');
const { Pool } = require('pg');
const multer   = require('multer');
const { asyncRoute } = require('../../module-error-boundary');
const { getOpenAI, chat } = require('../../lib/aiClient');
const { uploadFile } = require('../../lib/fileStorage');

// ─── DB Pool ──────────────────────────────────────────────────────────────────
let _pool = null;
function getPool() {
  if (!_pool) _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

// ─── Multer (memory storage for bill scan uploads) ────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/heic','image/webp','application/pdf'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported file type. Upload JPG, PNG, HEIC, or PDF.'));
  },
});

// ─── Tier helpers ─────────────────────────────────────────────────────────────
const TIER_RANK = {
  free: 0, individual: 1, individual_pro: 1,
  family: 2, tfr_pro: 2,
  elite: 3, tfr_elite: 3,
  business: 3, business_core: 3, business_bundle: 3,
  sovereign: 4, sovereign_executive: 4, sovereignty: 4,
};

function normalizeTier(plan) {
  if (!plan) return 'free';
  const p = plan.toLowerCase();
  if (p.includes('sovereign')) return 'sovereign';
  if (p.includes('elite'))     return 'elite';
  if (p.includes('business'))  return 'business';
  if (p.includes('family') || p.includes('tfr_pro') || p.includes('household')) return 'family';
  if (p.includes('individual') || p.includes('individual_pro')) return 'individual';
  return 'free';
}

async function getUserTier(userId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT pricing_tier, subscription_tier, plan FROM users WHERE id = $1`,
    [userId]
  );
  if (!rows[0]) return 'free';
  const u = rows[0];
  return normalizeTier(u.pricing_tier || u.subscription_tier || u.plan || '');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res) {
  if (!req.session?.userId) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  return true;
}

// ─── Frequency → monthly multiplier ──────────────────────────────────────────
const FREQUENCY_MULTIPLIERS = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  semiannually: 1 / 6,
  annually: 1 / 12,
};

function toMonthly(amount, frequency) {
  const mult = FREQUENCY_MULTIPLIERS[frequency] || 1;
  return Math.round(parseFloat(amount) * mult * 100) / 100;
}

// ─── AI call (for comparison engine) ──────────────────────────────────────────
async function callAI(messages, systemPrompt) {
  return (await chat(messages, systemPrompt, { maxTokens: 2048 })) || '';
}

// ─── Upload file to storage (non-fatal — comparison works without it) ────────
async function uploadBillFile(buffer, filename, mimeType) {
  return uploadFile(buffer, filename, mimeType, { folder: 'rate-radar' });
}

// ─── AI comparison engine ─────────────────────────────────────────────────────
const COMPARISON_SYSTEM_PROMPT = `You are an educational bill-comparison assistant for the FACTS platform.
Your job is to analyze a user's current recurring bill and return up to 3 illustrative alternative providers/offers ranked by estimated monthly savings for literacy/education only.
This is NOT financial, insurance, lending, or switching advice. Estimates may be inaccurate. Users must verify with providers and licensed professionals.

RULES:
- Return ONLY valid JSON (no markdown fences, no explanation outside JSON).
- alternatives array must have exactly 3 items (or fewer if no real alternatives exist for the category).
- Amounts must be realistic market rates as of 2025-2026 — do not make up dramatic savings. Label implicitly as estimates.
- For category "subscriptions" only suggest real competing services.
- For "loans" and "mortgage" list illustrative refinance concepts based on recent public rate ranges — do NOT recommend the user refinance; note they should consult a licensed lender/advisor.
- For "utilities" note deregulated market potential and energy efficiency tips as educational context.
- For "insurance" give illustrative competing quote ranges (e.g. Geico vs Progressive vs State Farm) — not personalized insurance advice.
- Include a "switching_ease" field: "easy" | "moderate" | "hard" as a rough educational heuristic only.
- Include "details" string: 1-2 sentences on what's different (coverage level, contract length, terms) plus that quotes must be verified.
- Include "action_url" as null (we don't affiliate-link).
- In "notes", remind: educational estimates only; not advice; verify before switching.

JSON schema:
{
  "alternatives": [
    {
      "key": "unique-string-id",
      "provider": "Provider Name",
      "plan_name": "Plan or Product Name",
      "monthly_amount": 29.99,
      "monthly_savings": 10.00,
      "annual_savings": 120.00,
      "switching_ease": "easy",
      "details": "Same coverage, no contract, cancel anytime.",
      "action_url": null
    }
  ],
  "notes": "Optional paragraph with additional context or caveats."
}`;

async function runComparison(bill) {
  const prompt = `Analyze this bill and return the top 3 competing alternatives:

Category: ${bill.category} / ${bill.subcategory || 'general'}
Provider: ${bill.provider}
Plan: ${bill.plan_name || 'not specified'}
Current monthly amount: $${bill.monthly_equivalent}
Frequency: ${bill.frequency}
Auto-renewal: ${bill.auto_renewal ? 'yes' : 'no'}
Contract end date: ${bill.contract_end_date || 'month-to-month'}
Notes: ${bill.notes || 'none'}

Return JSON only.`;

  const text = await callAI(
    [{ role: 'user', content: prompt }],
    COMPARISON_SYSTEM_PROMPT
  );

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI did not return valid JSON');
  return JSON.parse(jsonMatch[0]);
}

// ─── OCR extraction via OpenAI ───────────────────────────────────────────────
async function extractBillFromFile(buffer, mimeType, fileUrl) {
  const openai = getOpenAI();

  let imageContent;
  if (mimeType === 'application/pdf') {
    // For PDFs: use text extraction prompt without image (describe what AI should extract)
    // Since we can't embed PDFs as images, convert to base64 and let vision handle it
    // or use a text-based extraction with the file URL if available
    imageContent = fileUrl
      ? { type: 'image_url', image_url: { url: fileUrl } }
      : null;
  } else {
    const base64 = buffer.toString('base64');
    imageContent = {
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${base64}` },
    };
  }

  const messages = [{
    role: 'user',
    content: imageContent
      ? [
          { type: 'text', text: EXTRACT_PROMPT },
          imageContent,
        ]
      : [{ type: 'text', text: EXTRACT_PROMPT + '\n\nNote: File is a PDF — extract all visible text and bill fields.' }],
  }];

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    task: 'document-extraction',
    messages,
    max_tokens: 1024,
  });

  const text = response.choices[0].message.content;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('AI extraction did not return valid JSON');
  return JSON.parse(jsonMatch[0]);
}

const EXTRACT_PROMPT = `Extract bill/invoice information from this image and return JSON only (no markdown fences).

JSON schema:
{
  "provider": "Company name",
  "plan_name": "Plan or service name if visible",
  "amount": 49.99,
  "frequency": "monthly",
  "due_date": "2026-06-01",
  "account_number_masked": "****1234",
  "category": "utilities",
  "subcategory": "electric",
  "confidence": "high",
  "low_confidence_fields": ["field1", "field2"],
  "raw_notes": "Any other relevant text from the bill"
}

category must be one of: insurance, loans, subscriptions, utilities, memberships, other
frequency must be one of: weekly, biweekly, monthly, quarterly, semiannually, annually
confidence is "high" if most fields are clear, "low" if image is blurry or partial.
If a field is not visible, use null.`;

// ─── Router ───────────────────────────────────────────────────────────────────
const router = express.Router();

// Health
router.get('/health', (req, res) => res.json({ status: 'ok', module: 'mod_rate_radar' }));

// ── GET /bills ─────────────────────────────────────────────────────────────────
router.get('/bills', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const tier = await getUserTier(userId);

  if (TIER_RANK[tier] < 1) {
    return res.status(403).json({
      error: 'Rate Radar requires Individual tier or above.',
      upgrade_required: true,
    });
  }

  const pool = getPool();
  const { rows: bills } = await pool.query(
    `SELECT b.*, c.alternatives, c.potential_savings, c.checked_at
     FROM rate_radar_bills b
     LEFT JOIN LATERAL (
       SELECT alternatives, potential_savings, checked_at
       FROM rate_radar_comparisons
       WHERE bill_id = b.id
       ORDER BY checked_at DESC LIMIT 1
     ) c ON true
     WHERE b.user_id = $1
     ORDER BY b.monthly_equivalent DESC`,
    [userId]
  );

  res.json({ bills });
}));

// ── POST /bills ────────────────────────────────────────────────────────────────
router.post('/bills', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const tier = await getUserTier(userId);

  if (TIER_RANK[tier] < 1) {
    return res.status(403).json({ error: 'Rate Radar requires Individual tier or above.', upgrade_required: true });
  }

  const {
    category, subcategory, provider, plan_name,
    amount, frequency, next_payment_date, auto_renewal,
    contract_end_date, notes,
  } = req.body;

  if (!category || !provider || !amount || !frequency) {
    return res.status(400).json({ error: 'category, provider, amount, and frequency are required.' });
  }

  const monthly_equivalent = toMonthly(amount, frequency);
  const pool = getPool();

  const { rows } = await pool.query(
    `INSERT INTO rate_radar_bills
       (user_id, category, subcategory, provider, plan_name, amount, frequency,
        monthly_equivalent, next_payment_date, auto_renewal, contract_end_date, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [userId, category, subcategory||null, provider, plan_name||null,
     amount, frequency, monthly_equivalent,
     next_payment_date||null, auto_renewal ?? true,
     contract_end_date||null, notes||null]
  );

  res.status(201).json({ bill: rows[0] });
}));

// ── PUT /bills/:id ─────────────────────────────────────────────────────────────
router.put('/bills/:id', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const pool = getPool();

  const { rows: existing } = await pool.query(
    'SELECT id FROM rate_radar_bills WHERE id=$1 AND user_id=$2', [req.params.id, userId]
  );
  if (!existing[0]) return res.status(404).json({ error: 'Bill not found.' });

  const {
    category, subcategory, provider, plan_name,
    amount, frequency, next_payment_date, auto_renewal,
    contract_end_date, notes,
  } = req.body;

  const monthly_equivalent = amount && frequency ? toMonthly(amount, frequency) : undefined;

  const { rows } = await pool.query(
    `UPDATE rate_radar_bills SET
       category = COALESCE($1, category),
       subcategory = COALESCE($2, subcategory),
       provider = COALESCE($3, provider),
       plan_name = COALESCE($4, plan_name),
       amount = COALESCE($5, amount),
       frequency = COALESCE($6, frequency),
       monthly_equivalent = COALESCE($7, monthly_equivalent),
       next_payment_date = COALESCE($8, next_payment_date),
       auto_renewal = COALESCE($9, auto_renewal),
       contract_end_date = COALESCE($10, contract_end_date),
       notes = COALESCE($11, notes),
       updated_at = NOW()
     WHERE id=$12 AND user_id=$13
     RETURNING *`,
    [category, subcategory, provider, plan_name, amount, frequency,
     monthly_equivalent, next_payment_date, auto_renewal, contract_end_date,
     notes, req.params.id, userId]
  );

  res.json({ bill: rows[0] });
}));

// ── DELETE /bills/:id ──────────────────────────────────────────────────────────
router.delete('/bills/:id', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  await pool.query('DELETE FROM rate_radar_bills WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  res.json({ success: true });
}));

// ── POST /bills/scan ───────────────────────────────────────────────────────────
router.post('/bills/scan', upload.single('bill'), asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const tier = await getUserTier(userId);

  if (TIER_RANK[tier] < 1) {
    return res.status(403).json({ error: 'Bill scanning requires Individual tier or above.', upgrade_required: true });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  // Upload to R2 for storage (non-blocking failure)
  const fileUrl = await uploadBillFile(req.file.buffer, req.file.originalname, req.file.mimetype);

  // Extract bill data via OCR
  let extracted;
  try {
    extracted = await extractBillFromFile(req.file.buffer, req.file.mimetype, fileUrl);
  } catch (e) {
    return res.status(422).json({
      error: 'Could not read this bill. Try a clearer image or enter manually.',
      detail: e.message,
    });
  }

  res.json({ extracted, file_url: fileUrl });
}));

// ── GET /bills/:id/comparison ──────────────────────────────────────────────────
router.get('/bills/:id/comparison', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT c.*, b.provider, b.category, b.monthly_equivalent
     FROM rate_radar_comparisons c
     JOIN rate_radar_bills b ON b.id = c.bill_id
     WHERE c.bill_id=$1 AND c.user_id=$2
     ORDER BY c.checked_at DESC LIMIT 1`,
    [req.params.id, req.session.userId]
  );

  if (!rows[0]) return res.status(404).json({ error: 'No comparison data yet. Run a comparison first.' });
  res.json({ comparison: rows[0] });
}));

// ── POST /bills/:id/compare ────────────────────────────────────────────────────
router.post('/bills/:id/compare', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const pool = getPool();

  const { rows: bills } = await pool.query(
    'SELECT * FROM rate_radar_bills WHERE id=$1 AND user_id=$2', [req.params.id, userId]
  );
  if (!bills[0]) return res.status(404).json({ error: 'Bill not found.' });

  const bill = bills[0];

  let result;
  try {
    result = await runComparison(bill);
  } catch (e) {
    return res.status(500).json({ error: 'AI comparison failed. Try again in a moment.', detail: e.message });
  }

  const alternatives = result.alternatives || [];
  const maxSavings = alternatives.length > 0
    ? Math.max(...alternatives.map(a => a.monthly_savings || 0))
    : 0;

  // Upsert comparison record
  await pool.query(
    `INSERT INTO rate_radar_comparisons (bill_id, user_id, alternatives, potential_savings, checked_at, expires_at)
     VALUES ($1,$2,$3,$4,NOW(),NOW() + INTERVAL '7 days')
     ON CONFLICT DO NOTHING`,
    [bill.id, userId, JSON.stringify(alternatives), maxSavings]
  );

  // If conflict (old record exists), update it
  await pool.query(
    `UPDATE rate_radar_comparisons
     SET alternatives=$1, potential_savings=$2, checked_at=NOW(), expires_at=NOW() + INTERVAL '7 days'
     WHERE bill_id=$3 AND user_id=$4`,
    [JSON.stringify(alternatives), maxSavings, bill.id, userId]
  );

  res.json({
    bill_id: bill.id,
    alternatives,
    notes: result.notes || null,
    potential_savings: maxSavings,
    disclaimer: 'Educational estimates only — not financial, insurance, or lending advice. Verify with providers and licensed professionals before switching.',
  });
}));

// ── POST /compare-all ──────────────────────────────────────────────────────────
router.post('/compare-all', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const pool = getPool();

  const { rows: bills } = await pool.query(
    'SELECT * FROM rate_radar_bills WHERE user_id=$1', [userId]
  );

  if (!bills.length) return res.json({ processed: 0, results: [] });

  // Respond immediately, run comparisons in background
  res.json({ queued: bills.length, message: 'Comparisons running in background. Refresh in ~30s.' });

  // Fire-and-forget (single process, no worker queue needed)
  (async () => {
    for (const bill of bills) {
      try {
        const result = await runComparison(bill);
        const alternatives = result.alternatives || [];
        const maxSavings = alternatives.length > 0 ? Math.max(...alternatives.map(a => a.monthly_savings || 0)) : 0;
        await pool.query(
          `INSERT INTO rate_radar_comparisons (bill_id, user_id, alternatives, potential_savings, checked_at, expires_at)
           VALUES ($1,$2,$3,$4,NOW(),NOW() + INTERVAL '7 days')
           ON CONFLICT DO NOTHING`,
          [bill.id, userId, JSON.stringify(alternatives), maxSavings]
        );
        await pool.query(
          `UPDATE rate_radar_comparisons SET alternatives=$1, potential_savings=$2, checked_at=NOW(), expires_at=NOW() + INTERVAL '7 days'
           WHERE bill_id=$3 AND user_id=$4`,
          [JSON.stringify(alternatives), maxSavings, bill.id, userId]
        );
      } catch (_) { /* per-bill failure is non-fatal */ }
    }
  })().catch(() => {});
}));

// ── DELETE /bills/:id/alternatives/:key/dismiss ────────────────────────────────
router.delete('/bills/:billId/alternatives/:key/dismiss', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const pool = getPool();
  await pool.query(
    `INSERT INTO rate_radar_dismissals (user_id, bill_id, alternative_key)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [req.session.userId, req.params.billId, req.params.key]
  );
  res.json({ success: true });
}));

// ── GET /dashboard ─────────────────────────────────────────────────────────────
router.get('/dashboard', asyncRoute(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const userId = req.session.userId;
  const tier = await getUserTier(userId);

  if (TIER_RANK[tier] < 1) {
    return res.status(403).json({ error: 'Rate Radar requires Individual tier or above.', upgrade_required: true });
  }

  const pool = getPool();

  // Total monthly spend
  const { rows: spendRows } = await pool.query(
    `SELECT COALESCE(SUM(monthly_equivalent),0) as total_monthly,
            COUNT(*) as bill_count
     FROM rate_radar_bills WHERE user_id=$1`,
    [userId]
  );

  // Category breakdown
  const { rows: categoryRows } = await pool.query(
    `SELECT category, COALESCE(SUM(monthly_equivalent),0) as monthly_total
     FROM rate_radar_bills WHERE user_id=$1 GROUP BY category ORDER BY monthly_total DESC`,
    [userId]
  );

  // Total potential savings (from comparisons)
  const { rows: savingsRows } = await pool.query(
    `SELECT COALESCE(SUM(c.potential_savings),0) as total_potential_savings
     FROM rate_radar_comparisons c
     WHERE c.user_id=$1 AND c.expires_at > NOW()`,
    [userId]
  );

  // Quick wins: bills with highest potential savings, ease=easy
  const { rows: quickWins } = await pool.query(
    `SELECT b.id, b.provider, b.category, b.monthly_equivalent, c.potential_savings, c.alternatives, c.checked_at
     FROM rate_radar_bills b
     JOIN rate_radar_comparisons c ON c.bill_id = b.id AND c.user_id = b.user_id
     WHERE b.user_id=$1 AND c.expires_at > NOW() AND c.potential_savings > 0
     ORDER BY c.potential_savings DESC LIMIT 5`,
    [userId]
  );

  // Bills due within 7 days
  const { rows: dueSoon } = await pool.query(
    `SELECT id, provider, category, amount, next_payment_date
     FROM rate_radar_bills
     WHERE user_id=$1 AND next_payment_date BETWEEN NOW() AND NOW() + INTERVAL '7 days'
     ORDER BY next_payment_date ASC`,
    [userId]
  );

  const totalMonthly  = parseFloat(spendRows[0].total_monthly);
  const totalSavings  = parseFloat(savingsRows[0].total_potential_savings);
  const annualSavings = Math.round(totalSavings * 12 * 100) / 100;

  // FACTS bucket allocation suggestion (display only)
  const factsBucketSuggestion = totalSavings > 0 ? {
    message: `Switching to better rates saves $${totalSavings.toFixed(2)}/mo — that's an extra $${(totalSavings * 12).toFixed(0)}/yr back in your pocket.`,
    suggestions: [
      { bucket: 'Velocity', amount: (totalSavings * 0.4).toFixed(2), rationale: '40% → accelerate debt payoff' },
      { bucket: 'Reserve',  amount: (totalSavings * 0.3).toFixed(2), rationale: '30% → strengthen your financial cushion' },
      { bucket: 'Growth',   amount: (totalSavings * 0.3).toFixed(2), rationale: '30% → compound your wealth' },
    ],
  } : null;

  res.json({
    total_monthly: totalMonthly,
    bill_count: parseInt(spendRows[0].bill_count),
    total_potential_savings: totalSavings,
    annual_potential_savings: annualSavings,
    category_breakdown: categoryRows,
    quick_wins: quickWins,
    due_soon: dueSoon,
    facts_allocation_suggestion: factsBucketSuggestion,
  });
}));

// ─── Module exports ───────────────────────────────────────────────────────────
module.exports = {
  routes: router,
  metadata: {
    name: 'Rate Radar',
    version: '1.0.0',
    requiredCoreVersion: '1.0.0',
    defaultEnabled: true,
    tierRequired: 'individual',
  },
  healthCheck: async (pool) => {
    try {
      await pool.query('SELECT 1 FROM rate_radar_bills LIMIT 1');
      return { status: 'ok', version: '1.0.0' };
    } catch (e) {
      return { status: 'error', error: e.message };
    }
  },
};
