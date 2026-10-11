'use strict';
// mod_shopping: Shopping Calculator backend
// Owns: GPS store discovery, shopping list CRUD, price submissions, receipt scan, sweep CTAs
// Does NOT own: SSC keypad (mod_ssc), Rate Radar (mod_rate_radar)

const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { getOpenAI } = require('../../lib/aiClient');
const { uploadFile } = require('../../lib/fileStorage');
const asyncRoute = fn => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Multer for receipt uploads (image only, 10MB cap)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported file type. Upload JPG, PNG, or WebP.'));
  },
});

// ── Helpers ──────────────────────────────────────────────────────────────
async function getUser(req) {
  if (!req.session || !req.session.userId) return null;
  const r = await pool.query('SELECT id, tier FROM users WHERE id = $1', [req.session.userId]);
  return r.rows[0] || null;
}

async function authOrSession(req) {
  const user = await getUser(req);
  if (user) return { user_id: user.id, session_key: null };
  const key = req.headers['x-session-key'] || req.body?.session_key || req.query?.session_key;
  return { user_id: null, session_key: key || 'anon_' + (req.ip || 'unknown') };
}

function isFactsUser(user) {
  if (!user) return false;
  const tier = (user.tier || '').toLowerCase();
  return ['individual', 'family', 'business', 'bundle', 'elite', 'sovereign'].includes(tier);
}

function calcDistance(lat1, lng1, lat2, lng2) {
  const R = 3959; // miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Bucket display names ────────────────────────────────────────────────────
const BUCKET_DISPLAY = {
  necessities: 'Necessities',
  velocity: 'Velocity',
  reserve: 'Reserve',
  lifestyle: 'Lifestyle',
  growth: 'Growth',
  legacy: 'Legacy',
};

function bucketDisplayName(slug) {
  return BUCKET_DISPLAY[slug] || slug.charAt(0).toUpperCase() + slug.slice(1);
}

// ── Receipt image upload (non-fatal — scan still works without stored image) ─
async function uploadReceiptImage(buffer, filename, mimeType) {
  return uploadFile(buffer, filename, mimeType, { folder: 'receipts' });
}

// ── OpenAI Vision OCR ────────────────────────────────────────────────────────

// System prompt for receipt parsing
const RECEIPT_OCR_PROMPT = `You are a grocery receipt parser for a shopping calculator app.

Extract ALL line items from this receipt. Return ONLY a valid JSON array (no markdown, no explanation).

Each item must have:
- "name": product name (normalize — remove size descriptors like "16oz", "1 lb" from name)
- "brand": brand name if visible (empty string if not)
- "price_cents": price as integer cents (e.g., $4.99 → 499)
- "confidence": 0.0-1.0 quality score

RULES:
- SKIP: store headers, date/time lines, subtotal, tax, total, payment lines (CASH, CARD, CHANGE, VISA, MASTERCARD, AMEX)
- SKIP lines like "SUBTOTAL", "TAX", "TOTAL", "GROSS", "NET", "CHANGE", "CASH", "DEBIT", "CREDIT"
- For items with quantity × price format, extract only the total price shown
- For dot-leader format "Product Name..........$4.99", extract price after the dots
- If price is not parseable, set price_cents to null and confidence to 0.3
- Return EXACTLY the items with prices — do not guess product names

Output JSON array format:
[
  {"name": "Eggs (dozen)", "brand": "Great Value", "price_cents": 499, "confidence": 0.95},
  {"name": "Bread (whole wheat)", "brand": "Nature Own", "price_cents": 329, "confidence": 0.88}
]

If no valid items found, return: []`;

async function extractReceiptItems(buffer, mimeType, imageUrl) {
  const openai = getOpenAI();

  const imageContent = imageUrl
    ? { type: 'image_url', image_url: { url: imageUrl } }
    : { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } };

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: RECEIPT_OCR_PROMPT },
      imageContent,
    ],
  }];

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    task: 'document-extraction',
    messages,
    max_tokens: 1536,
  });

  const text = response.choices[0].message.content || '';
  const jsonMatch = text.match(/\n?(\\[.*?\\])\n?/s) || text.match(/(\\{[\\s\\S]*\\})/);
  if (!jsonMatch) {
    const fallback = text.replace(/[^\\],:[^\\]/g, '');
    try { return JSON.parse(fallback); } catch { return []; }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return Array.isArray(parsed) ? parsed.filter(i => i.price_cents && i.price_cents > 0) : [];
  } catch {
    return [];
  }
}

// ── Fuzzy Name Matching ──────────────────────────────────────────────────────
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(the|a|an|of|oz|lb|lbs|ct|pack|box|can|bottle|jar)\b/g, '')
    .replace(/\b(doz|dozen|bunch|each)\b/g, '')
    .replace(/\b0+(\b)/g, '$1')
    .replace(/\//g, ' ')
    .replace(/ +/g, ' ')
    .replace(/^\b|\b$/g, '')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function fuzzyMatch(ocrName, listName) {
  const a = normalize(ocrName);
  const b = normalize(listName);
  if (!a || !b) return 0;

  if (a === b) return 1.0;
  if (a.includes(b) || b.includes(a)) return 0.92;

  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  const score = 1 - (dist / maxLen);

  if (dist <= 2 && score > 0.7) return score;
  return 0;
}

function matchItemsToList(ocrItems, listItems) {
  const matches = [];
  const unmatchedReceipt = [];
  const matchedListIds = new Set();

  for (const ocrItem of ocrItems) {
    let best = null, bestScore = 0;
    for (const listItem of listItems) {
      if (matchedListIds.has(listItem.id)) continue;
      const score = fuzzyMatch(ocrItem.name, listItem.name);
      if (score > bestScore && score >= 0.65) {
        best = listItem;
        bestScore = score;
      }
    }
    if (best) {
      matchedListIds.add(best.id);
      matches.push({
        list_item: best.name,
        list_item_id: best.id,
        ocr_name: ocrItem.name,
        ocr_brand: ocrItem.brand || '',
        ocr_price_cents: ocrItem.price_cents,
        confidence: Math.round(bestScore * 100) / 100,
      });
    } else {
      unmatchedReceipt.push({ name: ocrItem.name, brand: ocrItem.brand || '', price_cents: ocrItem.price_cents, ocr_confidence: ocrItem.confidence });
    }
  }

  const unmatchedList = listItems
    .filter(li => !matchedListIds.has(li.id))
    .map(li => li.name);

  return { matches, unmatched_receipt: unmatchedReceipt, unmatched_list: unmatchedList };
}

// ── Rate limit: max 10 receipt scans per user per day ───────────────────────
async function rateLimitReceiptScans(userId, sessionKey) {
  if (!userId && !sessionKey) return true;
  const where = userId ? 'user_id = $1' : 'session_key = $1';
  const param = userId || sessionKey;
  const r = await pool.query(
    `SELECT COUNT(*) as cnt FROM mod_shopping.receipt_scans
     WHERE ${where} AND created_at > NOW() - INTERVAL '1 day'`,
    [param]
  );
  return parseInt(r.rows[0].cnt) < 10;
}

// ── Health ────────────────────────────────────────────────────────────────
router.get('/health', asyncRoute(async (req, res) => {
  res.json({ status: 'ok', module: 'mod_shopping' });
}));

// ── Store Discovery ───────────────────────────────────────────────────────
router.get('/stores', asyncRoute(async (req, res) => {
  const { lat, lng, radius = 5, category } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const latN = parseFloat(lat), lngN = parseFloat(lng), radiusN = parseFloat(radius);

  const storesR = await pool.query(
    `SELECT id, name, address, lat, lng, category, chain, price_count, avg_price_cents
     FROM mod_shopping.stores ORDER BY id LIMIT 20`
  );

  if (!storesR.rows.length) return res.json({ stores: [], count: 0 });

  let stores = storesR.rows.map(s => ({
    id: s.id, name: s.name, address: s.address || '',
    lat: s.lat, lng: s.lng,
    category: s.category || 'grocery', chain: s.chain || '',
    price_count: s.price_count || 0, avg_price_cents: s.avg_price_cents || null,
    distance: calcDistance(latN, lngN, parseFloat(s.lat), parseFloat(s.lng)),
  })).filter(s => s.distance <= radiusN);

  if (category) stores = stores.filter(s => s.category === category);
  stores.sort((a, b) => a.distance - b.distance);
  res.json({ stores, count: stores.length });
}));

// ── GET /stores/nearby (spec-compliant, free tier capped at 3) ────────────
router.get('/stores/nearby', asyncRoute(async (req, res) => {
  const { lat, lng, radius = 5 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const latN = parseFloat(lat), lngN = parseFloat(lng), radiusN = parseFloat(radius);
  const user = await getUser(req);
  const freeTier = !isFactsUser(user);

  const storesR = await pool.query(
    `SELECT id, name, address, lat, lng, category, chain, price_count, avg_price_cents
     FROM mod_shopping.stores ORDER BY id LIMIT 20`
  );

  if (!storesR.rows.length) return res.json({ stores: [], count: 0 });

  let stores = storesR.rows.map(s => ({
    id: s.id, name: s.name, address: s.address || '',
    category: s.category || 'grocery',
    distance: Math.round(calcDistance(latN, lngN, parseFloat(s.lat), parseFloat(s.lng)) * 10) / 10,
    price_count: s.price_count || 0,
  })).filter(s => s.distance <= radiusN);

  stores.sort((a, b) => a.distance - b.distance);

  // Free tier: max 3 stores
  const capped = freeTier && stores.length > 3;
  const result = capped ? stores.slice(0, 3) : stores;

  res.json({ stores: result, count: result.length, capped });
}));

// ── Product Search ────────────────────────────────────────────────────────
router.get('/search', asyncRoute(async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ products: [] });

  // Demo product catalog with prices per store chain
  const catalog = [
    { name: 'Eggs (dozen)', brand: 'Great Value', category: 'dairy', upc: '078742434012' },
    { name: 'Eggs (dozen)', brand: "Trader Joe's", category: 'dairy', upc: '00511101' },
    { name: 'Eggs (dozen)', brand: "Eggland's Best", category: 'dairy', upc: '041235011006' },
    { name: 'Bread (whole wheat)', brand: 'Nature Own', category: 'bakery', upc: '073130010024' },
    { name: 'Bread (whole wheat)', brand: "Dave's Killer", category: 'bakery', upc: '013764030044' },
    { name: 'Bread (whole wheat)', brand: "Arnold", category: 'bakery', upc: '075500101021' },
    { name: 'Almond Milk (64oz)', brand: "Silk", category: 'dairy', upc: '025700016236' },
    { name: 'Almond Milk (64oz)', brand: 'Great Value', category: 'dairy', upc: '078742229014' },
    { name: 'Chicken Breast (lb)', brand: 'Perdue', category: 'meat', upc: '0070745030154' },
    { name: 'Chicken Breast (lb)', brand: 'Tyson', category: 'meat', upc: '023700010035' },
    { name: 'Ground Beef 80/20 (lb)', brand: 'Great Value', category: 'meat', upc: '078742230286' },
    { name: 'Bananas (lb)', brand: '', category: 'produce', upc: '' },
    { name: 'Avocados (each)', brand: '', category: 'produce', upc: '' },
    { name: 'Spinach (10oz)', brand: 'Earthbound', category: 'produce', upc: '023567124013' },
    { name: 'Broccoli (bunch)', brand: '', category: 'produce', upc: '' },
    { name: 'Greek Yogurt', brand: 'Chobani', category: 'dairy', upc: '818290011003' },
    { name: 'Greek Yogurt', brand: 'Fage', category: 'dairy', upc: '036632007004' },
    { name: 'Orange Juice (64oz)', brand: 'Tropicana', category: 'beverages', upc: '048500001132' },
    { name: 'Milk (gallon)', brand: "Horizon Organic", category: 'dairy', upc: '048355007014' },
    { name: 'Milk (gallon)', brand: 'Great Value', category: 'dairy', upc: '078742002045' },
    { name: 'Pasta (lb)', brand: 'Barilla', category: 'pantry', upc: '076808901005' },
    { name: 'Rice (5lb)', brand: 'Great Value', category: 'pantry', upc: '078742010125' },
    { name: 'Olive Oil (500ml)', brand: 'California Olive', category: 'pantry', upc: '085981003003' },
    { name: 'Butter (lb)', brand: 'Kerrygold', category: 'dairy', upc: '076770000018' },
    { name: 'Cheddar Cheese (8oz)', brand: 'Tillamook', category: 'dairy', upc: '072730001001' },
    { name: 'Soda (12pk)', brand: 'Coca-Cola', category: 'beverages', upc: '049000042256' },
    { name: 'Chips (oz)', brand: 'Lay', category: 'pantry', upc: '028400056302' },
    { name: 'Dish Soap (24oz)', brand: 'Dawn', category: 'household', upc: '037000856015' },
    { name: 'Laundry Detergent', brand: 'Tide', category: 'household', upc: '037000896118' },
    { name: 'Paper Towels (2pk)', brand: 'Bounty', category: 'household', upc: '037000956853' },
    { name: 'Toilet Paper (12pk)', brand: 'Charmin', category: 'household', upc: '037000957007' },
    { name: 'Shampoo', brand: 'Head & Shoulders', category: 'personal', upc: '037000131013' },
    { name: 'Deodorant', brand: 'Dove', category: 'personal', upc: '011111002064' },
    { name: 'Toothpaste', brand: 'Crest', category: 'personal', upc: '037000322009' },
    { name: 'Salmon Fillet (lb)', brand: 'Farm Raised', category: 'meat', upc: '' },
    { name: 'Shrimp (lb)', brand: 'Wild Caught', category: 'meat', upc: '' },
    { name: 'Pork Chops (lb)', brand: '', category: 'meat', upc: '' },
    { name: 'Cheerios (box)', brand: 'General Mills', category: 'pantry', upc: '016000275306' },
    { name: 'Peanut Butter (16oz)', brand: 'Jif', category: 'pantry', upc: '051500240038' },
  ];

  const qLower = q.toLowerCase();
  const matches = catalog
    .filter(p => p.name.toLowerCase().includes(qLower) || p.brand.toLowerCase().includes(qLower))
    .slice(0, 8);

  res.json({ products: matches });
}));

// ── Shopping List CRUD ────────────────────────────────────────────────────
router.post('/list', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { name } = req.body;

  const r = await pool.query(
    `INSERT INTO mod_shopping.shopping_lists(user_id, session_key, name)
     VALUES ($1, $2, $3) RETURNING *`,
    [user_id, session_key, name || 'My List']
  );
  res.json({ list: r.rows[0] });
}));

router.get('/list', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const r = await pool.query(
    `SELECT sl.*, s.name as store_name, s.address as store_address
     FROM mod_shopping.shopping_lists sl
     LEFT JOIN mod_shopping.stores s ON s.id = sl.store_id
     WHERE sl.user_id = $1 OR sl.session_key = $2
     ORDER BY sl.created_at DESC LIMIT 5`,
    [user_id, session_key]
  );
  res.json({ lists: r.rows });
}));

router.get('/list/:id', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { id } = req.params;

  const listR = await pool.query(
    `SELECT sl.*, s.name as store_name, s.address as store_address
     FROM mod_shopping.shopping_lists sl
     LEFT JOIN mod_shopping.stores s ON s.id = sl.store_id
     WHERE sl.id = $1 AND (sl.user_id = $2 OR sl.session_key = $3)`,
    [id, user_id, session_key]
  );
  if (!listR.rows[0]) return res.status(404).json({ error: 'List not found' });

  const itemsR = await pool.query(
    `SELECT * FROM mod_shopping.list_items WHERE list_id = $1 ORDER BY created_at ASC`,
    [id]
  );

  res.json({ list: listR.rows[0], items: itemsR.rows });
}));

// Add item to list
router.post('/list/:id/items', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { id } = req.params;
  const { name, brand, upc, category, quantity } = req.body;

  const listR = await pool.query(
    `SELECT * FROM mod_shopping.shopping_lists WHERE id = $1 AND (user_id = $2 OR session_key = $3)`,
    [id, user_id, session_key]
  );
  if (!listR.rows[0]) return res.status(404).json({ error: 'List not found' });

  // Free tier cap: 10 items
  const user = await getUser(req);
  if (!isFactsUser(user)) {
    const countR = await pool.query('SELECT COUNT(*) as cnt FROM mod_shopping.list_items WHERE list_id = $1', [id]);
    if (parseInt(countR.rows[0].cnt) >= 10) {
      return res.status(403).json({ error: 'Free tier limit reached (10 items)', upgrade_required: true });
    }
  }

  const r = await pool.query(
    `INSERT INTO mod_shopping.list_items(list_id, name, brand, upc, category, quantity)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, name, brand || '', upc || '', category || '', quantity || 1]
  );

  // Update list item count
  await pool.query(
    `UPDATE mod_shopping.shopping_lists SET item_count = item_count + 1, updated_at = now() WHERE id = $1`,
    [id]
  );

  res.json({ item: r.rows[0] });
}));

// Remove item
router.delete('/list/:listId/items/:itemId', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { listId, itemId } = req.params;

  await pool.query(
    `DELETE FROM mod_shopping.list_items WHERE id = $1 AND list_id = $2`,
    [itemId, listId]
  );
  await pool.query(
    `UPDATE mod_shopping.shopping_lists SET item_count = item_count - 1, updated_at = now() WHERE id = $1`,
    [listId]
  );

  res.json({ success: true });
}));

// Toggle item checked
router.patch('/list/:id/items/:itemId', asyncRoute(async (req, res) => {
  const { checked, entered_price_cents, confirmed } = req.body;
  const { id, itemId } = req.params;

  const r = await pool.query(
    `UPDATE mod_shopping.list_items SET checked = COALESCE($1, checked),
     entered_price_cents = COALESCE($2, entered_price_cents),
     confirmed = COALESCE($3, confirmed)
     WHERE id = $4 AND list_id = $5 RETURNING *`,
    [checked, entered_price_cents, confirmed, itemId, id]
  );

  // Recalculate list total
  if (r.rows[0]) {
    const totalR = await pool.query(
      `SELECT COALESCE(SUM(entered_price_cents * quantity), 0)::INTEGER as total_cents
       FROM mod_shopping.list_items WHERE list_id = $1 AND confirmed = true`,
      [id]
    );
    await pool.query(
      `UPDATE mod_shopping.shopping_lists SET total_cents = $1, updated_at = now() WHERE id = $2`,
      [totalR.rows[0].total_cents, id]
    );
  }

  res.json({ item: r.rows[0] });
}));

// Select store for a list (enter shopping mode)
router.patch('/list/:id/store', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { id } = req.params;
  const { store_id } = req.body;

  const r = await pool.query(
    `UPDATE mod_shopping.shopping_lists SET store_id = $1, status = 'shopping', updated_at = now()
     WHERE id = $2 AND (user_id = $3 OR session_key = $4) RETURNING *`,
    [store_id || null, id, user_id, session_key]
  );
  res.json({ list: r.rows[0] });
}));

// Complete shopping trip
router.post('/list/:id/complete', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { id } = req.params;

  const r = await pool.query(
    `UPDATE mod_shopping.shopping_lists SET status = 'completed', updated_at = now()
     WHERE id = $1 AND (user_id = $2 OR session_key = $3) RETURNING *`,
    [id, user_id, session_key]
  );
  res.json({ list: r.rows[0] });
}));

// ── Price Submissions ─────────────────────────────────────────────────────
router.post('/prices', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { store_id, product_name, brand, price_cents, source } = req.body;

  if (!price_cents || !store_id) return res.status(400).json({ error: 'store_id and price_cents required' });

  const r = await pool.query(
    `INSERT INTO mod_shopping.price_submissions(user_id, session_key, store_id, product_name, brand, price_cents, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [user_id, session_key, store_id, product_name, brand || '', price_cents, source || 'manual']
  );

  // Update store avg price (last 20 submissions)
  await pool.query(
    `UPDATE mod_shopping.stores SET
     price_count = (SELECT COUNT(*) FROM mod_shopping.price_submissions WHERE store_id = $1),
     avg_price_cents = (SELECT MEDIAN(price_cents)::INTEGER FROM mod_shopping.price_submissions WHERE store_id = $1 LIMIT 20)
     WHERE id = $1`,
    [store_id]
  );

  res.json({ submission: r.rows[0], created_at: r.rows[0].created_at });
}));

// ── Compare Stores (now uses /optimize internally) ────────────────────────
router.get('/compare/:listId', asyncRoute(async (req, res) => {
  // Delegate to the full optimizer — compare is just a thin wrapper
  const { listId } = req.params;
  const { lat, lng, radius } = req.query;
  const user = await getUser(req);

  // Quick empty-list guard
  const itemsR = await pool.query(
    `SELECT id, name, brand, quantity FROM mod_shopping.list_items WHERE list_id = $1`,
    [listId]
  );
  if (!itemsR.rows.length) {
    return res.json({
      empty_list: true,
      message: 'Add items to your list to compare stores.',
    });
  }

  const listR = await pool.query('SELECT * FROM mod_shopping.shopping_lists WHERE id = $1', [listId]);
  if (!listR.rows[0]) return res.status(404).json({ error: 'List not found' });

  if (!isFactsUser(user)) {
    // Free tier: per-item cheapest
    const itemNames = itemsR.rows.map(i => i.name.toLowerCase());

    const pricesR = await pool.query(
      `SELECT LOWER(ps.product_name) as name, ps.store_id, s.name as store_name,
              s.category, s.lat, s.lng,
              MIN(ps.price_cents)::INTEGER as best_price
       FROM mod_shopping.price_submissions ps
       JOIN mod_shopping.stores s ON s.id = ps.store_id
       WHERE LOWER(ps.product_name) = ANY($1)
       GROUP BY LOWER(ps.product_name), ps.store_id, s.name, s.category, s.lat, s.lng
       ORDER BY best_price ASC`,
      [itemNames]
    );

    const seen = new Set();
    const picks = [];
    for (const row of pricesR.rows) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      const qty = (itemsR.rows.find(i => i.name.toLowerCase() === row.name) || {}).quantity || 1;
      picks.push({
        name: itemsR.rows.find(i => i.name.toLowerCase() === row.name)?.name || row.name,
        store_name: row.store_name,
        category: row.category || 'unknown',
        price_cents: row.best_price,
        price_display: `$${(row.best_price / 100).toFixed(2)}`,
        quantity: qty,
      });
    }

    return res.json({
      limited: true,
      items: picks,
      upgrade_required: true,
      message: 'Going to multiple stores? FACTS Pro finds the ONE store that saves the most.',
    });
  }

  // FACTS user: full optimize (re-use the algorithm)
  // Re-use /optimize by proxying its logic inline to avoid extra DB calls
  // — already have itemsR and listR. Build optimize response manually.
  const storesR = await pool.query(
    `SELECT id, name, address, lat, lng, category,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_cents)::INTEGER as median_price,
            COUNT(*) as price_count
     FROM mod_shopping.stores
     GROUP BY id, name, address, lat, lng, category
     LIMIT 20`
  );

  if (!storesR.rows.length) {
    return res.json({ stores: [], edge_case: 'no_stores' });
  }

  const itemNames = itemsR.rows.map(i => i.name.toLowerCase());
  const pricesR = await pool.query(
    `SELECT LOWER(ps.product_name) as name, ps.store_id,
            MIN(ps.price_cents)::INTEGER as best_price
     FROM mod_shopping.price_submissions ps
     WHERE LOWER(ps.product_name) = ANY($1) AND ps.store_id = ANY($2::int[])
     GROUP BY LOWER(ps.product_name), ps.store_id`,
    [itemNames, storesR.rows.map(s => s.id)]
  );

  const priceMap = {};
  for (const row of pricesR.rows) {
    priceMap[`${row.name}_${row.store_id}`] = row.best_price;
  }

  // Default location
  let latN = lat ? parseFloat(lat) : 33.1952;
  let lngN = lng ? parseFloat(lng) : -117.3793;

  const comparisons = storesR.rows.map(store => {
    let totalCents = 0;
    let sourced = 0;
    for (const item of itemsR.rows) {
      const price = priceMap[`${item.name.toLowerCase()}_${store.id}`];
      if (price !== undefined) {
        totalCents += price * (parseInt(item.quantity) || 1);
        sourced++;
      }
    }
    return { store: { id: store.id, name: store.name, address: store.address, category: store.category, distance: 0 }, estimated_total_cents: totalCents, sourced_count: sourced };
  }).filter(s => s.estimated_total_cents > 0 && s.sourced_count > 0);

  comparisons.sort((a, b) => a.estimated_total_cents - b.estimated_total_cents);

  const cheapest = comparisons[0];
  const mostExpensive = comparisons[comparisons.length - 1];
  const savingsCents = mostExpensive ? mostExpensive.estimated_total_cents - cheapest.estimated_total_cents : 0;
  const perTrip = savingsCents / 100;

  res.json({
    stores: comparisons,
    cheapest_store: cheapest,
    savings_cents: savingsCents,
    savings_display: `$${perTrip.toFixed(2)}`,
    annualized_savings_cents: Math.round(perTrip * 24),
    upgrade_required: false,
  });
}));

// ── Demo seeded prices (used when price_submissions is empty) ────────────────
const DEMO_PRICES = {
  // store_id → product name → price (cents)
  // Costco (id from demo stores seed)
  1: { 'eggs (dozen)': 499, 'bread (whole wheat)': 349, 'almond milk (64oz)': 529, 'milk (gallon)': 399, 'chicken breast (lb)': 599, 'bananas (lb)': 59, 'avocados (each)': 149, 'butter (lb)': 499, 'cheddar cheese (8oz)': 399, 'orange juice (64oz)': 429, 'pasta (lb)': 229, 'rice (5lb)': 549, 'olive oil (500ml)': 699, 'cheerios (box)': 479, 'peanut butter (16oz)': 449, 'ground beef 80/20 (lb)': 699, 'greek yogurt': 129, 'salmon fillet (lb)': 1299, 'spinach (10oz)': 399, 'broccoli (bunch)': 249 },
  // Walmart Supercenter
  2: { 'eggs (dozen)': 379, 'bread (whole wheat)': 249, 'almond milk (64oz)': 499, 'milk (gallon)': 329, 'chicken breast (lb)': 549, 'bananas (lb)': 49, 'avocados (each)': 129, 'butter (lb)': 449, 'cheddar cheese (8oz)': 349, 'orange juice (64oz)': 399, 'pasta (lb)': 199, 'rice (5lb)': 499, 'olive oil (500ml)': 599, 'cheerios (box)': 449, 'peanut butter (16oz)': 399, 'ground beef 80/20 (lb)': 649, 'greek yogurt': 119, 'salmon fillet (lb)': 1199, 'spinach (10oz)': 349, 'broccoli (bunch)': 229 },
  // Vons
  3: { 'eggs (dozen)': 559, 'bread (whole wheat)': 399, 'almond milk (64oz)': 589, 'milk (gallon)': 449, 'chicken breast (lb)': 699, 'bananas (lb)': 69, 'avocados (each)': 179, 'butter (lb)': 599, 'cheddar cheese (8oz)': 479, 'orange juice (64oz)': 499, 'pasta (lb)': 279, 'rice (5lb)': 699, 'olive oil (500ml)': 799, 'cheerios (box)': 549, 'peanut butter (16oz)': 529, 'ground beef 80/20 (lb)': 799, 'greek yogurt': 149, 'salmon fillet (lb)': 1499, 'spinach (10oz)': 449, 'broccoli (bunch)': 299 },
  // Trader Joe
  4: { 'eggs (dozen)': 399, 'bread (whole wheat)': 299, 'almond milk (64oz)': 459, 'milk (gallon)': 379, 'chicken breast (lb)': 579, 'bananas (lb)': 49, 'avocados (each)': 139, 'butter (lb)': 479, 'cheddar cheese (8oz)': 379, 'orange juice (64oz)': 349, 'pasta (lb)': 249, 'rice (5lb)': 499, 'olive oil (500ml)': 649, 'cheerios (box)': 399, 'peanut butter (16oz)': 429, 'ground beef 80/20 (lb)': 679, 'greek yogurt': 109, 'salmon fillet (lb)': 1099, 'spinach (10oz)': 349, 'broccoli (bunch)': 219 },
  // Target
  5: { 'eggs (dozen)': 449, 'bread (whole wheat)': 329, 'almond milk (64oz)': 549, 'milk (gallon)': 379, 'chicken breast (lb)': 599, 'bananas (lb)': 59, 'avocados (each)': 159, 'butter (lb)': 529, 'cheddar cheese (8oz)': 429, 'orange juice (64oz)': 459, 'pasta (lb)': 249, 'rice (5lb)': 579, 'olive oil (500ml)': 749, 'cheerios (box)': 499, 'peanut butter (16oz)': 479, 'ground beef 80/20 (lb)': 729, 'greek yogurt': 139, 'salmon fillet (lb)': 1399, 'spinach (10oz)': 429, 'broccoli (bunch)': 279 },
  // Stater Bros
  6: { 'eggs (dozen)': 429, 'bread (whole wheat)': 299, 'almond milk (64oz)': 519, 'milk (gallon)': 359, 'chicken breast (lb)': 569, 'bananas (lb)': 49, 'avocados (each)': 139, 'butter (lb)': 459, 'cheddar cheese (8oz)': 369, 'orange juice (64oz)': 379, 'pasta (lb)': 219, 'rice (5lb)': 529, 'olive oil (500ml)': 679, 'cheerios (box)': 429, 'peanut butter (16oz)': 409, 'ground beef 80/20 (lb)': 659, 'greek yogurt': 109, 'salmon fillet (lb)': 1199, 'spinach (10oz)': 379, 'broccoli (bunch)': 229 },
  // Albertsons
  7: { 'eggs (dozen)': 489, 'bread (whole wheat)': 349, 'almond milk (64oz)': 569, 'milk (gallon)': 419, 'chicken breast (lb)': 649, 'bananas (lb)': 59, 'avocados (each)': 169, 'butter (lb)': 549, 'cheddar cheese (8oz)': 449, 'orange juice (64oz)': 479, 'pasta (lb)': 259, 'rice (5lb)': 629, 'olive oil (500ml)': 749, 'cheerios (box)': 519, 'peanut butter (16oz)': 499, 'ground beef 80/20 (lb)': 749, 'greek yogurt': 139, 'salmon fillet (lb)': 1399, 'spinach (10oz)': 419, 'broccoli (bunch)': 269 },
  // Sprouts
  8: { 'eggs (dozen)': 529, 'bread (whole wheat)': 369, 'almond milk (64oz)': 599, 'milk (gallon)': 469, 'chicken breast (lb)': 749, 'bananas (lb)': 79, 'avocados (each)': 199, 'butter (lb)': 629, 'cheddar cheese (8oz)': 499, 'orange juice (64oz)': 549, 'pasta (lb)': 299, 'rice (5lb)': 749, 'olive oil (500ml)': 849, 'cheerios (box)': 579, 'peanut butter (16oz)': 549, 'ground beef 80/20 (lb)': 899, 'greek yogurt': 159, 'salmon fillet (lb)': 1599, 'spinach (10oz)': 299, 'broccoli (bunch)': 219 },
  // Whole Foods
  9: { 'eggs (dozen)': 699, 'bread (whole wheat)': 549, 'almond milk (64oz)': 699, 'milk (gallon)': 599, 'chicken breast (lb)': 999, 'bananas (lb)': 89, 'avocados (each)': 229, 'butter (lb)': 799, 'cheddar cheese (8oz)': 699, 'orange juice (64oz)': 699, 'pasta (lb)': 399, 'rice (5lb)': 899, 'olive oil (500ml)': 1199, 'cheerios (box)': 699, 'peanut butter (16oz)': 699, 'ground beef 80/20 (lb)': 1099, 'greek yogurt': 199, 'salmon fillet (lb)': 1999, 'spinach (10oz)': 499, 'broccoli (bunch)': 399 },
};

// ── Trip Optimizer ─────────────────────────────────────────────────────────
// The core algorithm: finds cheapest total cart cost across all nearby stores.
// Per-item lowest community price per store, sorted by total.
router.get('/optimize/:listId', asyncRoute(async (req, res) => {
  const user = await getUser(req);
  const { listId } = req.params;
  const { lat, lng, radius = 5 } = req.query;

  // Fetch list + items
  const listR = await pool.query(
    `SELECT sl.*, s.name as store_name, s.id as store_id
     FROM mod_shopping.shopping_lists sl
     LEFT JOIN mod_shopping.stores s ON s.id = sl.store_id
     WHERE sl.id = $1`,
    [listId]
  );
  if (!listR.rows[0]) return res.status(404).json({ error: 'List not found' });

  const itemsR = await pool.query(
    `SELECT id, name, brand, quantity FROM mod_shopping.list_items WHERE list_id = $1`,
    [listId]
  );
  const items = itemsR.rows;

  if (!items.length) {
    return res.json({
      edge_case: 'empty_list',
      message: 'Add items to your list to compare stores.',
      stores_ranked: [],
    });
  }

  // Resolve location (use query coords, list's store, or default)
  let latN = lat ? parseFloat(lat) : 33.1952;
  let lngN = lng ? parseFloat(lng) : -117.3793;
  if (listR.rows[0].store_id) {
    const storeLocR = await pool.query(
      `SELECT lat, lng FROM mod_shopping.stores WHERE id = $1`,
      [listR.rows[0].store_id]
    );
    if (storeLocR.rows[0]) {
      latN = parseFloat(storeLocR.rows[0].lat) || latN;
      lngN = parseFloat(storeLocR.rows[0].lng) || lngN;
    }
  }

  // Fetch all nearby stores with distances
  const storesR = await pool.query(
    `SELECT id, name, address, lat, lng, category,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_cents)::INTEGER as median_price,
            COUNT(*) as price_count
     FROM mod_shopping.stores
     GROUP BY id, name, address, lat, lng, category
     LIMIT 20`
  );

  if (!storesR.rows.length) {
    return res.json({
      edge_case: 'no_stores',
      stores_ranked: [],
    });
  }

  // Build item name set for price lookup (lowercase for matching)
  const itemNames = items.map(i => i.name.toLowerCase());

  // Fetch lowest community price per item per store (case-insensitive)
  const pricesR = await pool.query(
    `SELECT
       LOWER(ps.product_name) as name,
       ps.store_id,
       MIN(ps.price_cents)::INTEGER as best_price,
       COUNT(*) as source_count
     FROM mod_shopping.price_submissions ps
     WHERE LOWER(ps.product_name) = ANY($1)
       AND ps.store_id = ANY($2::int[])
     GROUP BY LOWER(ps.product_name), ps.store_id`,
    [itemNames, storesR.rows.map(s => s.id)]
  );

  // Build lookup: { 'itemname_storeid': cents }
  const priceMap = {};
  for (const row of pricesR.rows) {
    priceMap[`${row.name}_${row.store_id}`] = row.best_price;
  }

  // Fallback: seed demo prices for any missing (store id keyed by row index + 1)
  const storeIdMap = {};
  storesR.rows.forEach((store, idx) => { storeIdMap[idx + 1] = store.id; });

  for (const item of items) {
    const itemKey = item.name.toLowerCase();
    for (let demoStoreId = 1; demoStoreId <= 9; demoStoreId++) {
      const realStoreId = storeIdMap[demoStoreId];
      if (!realStoreId) continue;
      const mapKey = `${itemKey}_${realStoreId}`;
      if (priceMap[mapKey] === undefined && DEMO_PRICES[demoStoreId] && DEMO_PRICES[demoStoreId][itemKey] !== undefined) {
        priceMap[mapKey] = DEMO_PRICES[demoStoreId][itemKey];
      }
    }
  }

  // Calculate total cart cost per store
  const ranked = storesR.rows.map(store => {
    let totalCents = 0;
    const sourced = [];
    const unavailable = [];

    for (const item of items) {
      const key = `${item.name.toLowerCase()}_${store.id}`;
      const price = priceMap[key];
      const qty = parseInt(item.quantity) || 1;

      if (price !== undefined) {
        totalCents += price * qty;
        sourced.push({
          product_id: item.id,
          name: item.name,
          price: (price / 100).toFixed(2),
          price_cents: price,
          quantity: qty,
          source: 'community',
          store_id: store.id,
          store_name: store.name,
        });
      } else {
        unavailable.push({ product_id: item.id, name: item.name });
      }
    }

    return {
      store_id: store.id,
      store_name: store.name,
      store_address: store.address || '',
      category: store.category || 'unknown',
      distance: calcDistance(latN, lngN, parseFloat(store.lat), parseFloat(store.lng)),
      total_cart_cost: (totalCents / 100).toFixed(2),
      total_cart_cost_cents: totalCents,
      items_sourced: sourced,
      items_unavailable: unavailable,
      has_prices: sourced.length > 0,
    };
  });

  // Filter stores with at least 1 item priced
  const withPrices = ranked.filter(s => s.has_prices);

  if (!withPrices.length) {
    return res.json({
      edge_case: 'no_prices_nearby',
      message: 'Not priced near you yet — be the first to contribute prices!',
      stores_ranked: [],
      upgrade_required: !isFactsUser(user),
    });
  }

  // Sort by total cart cost ascending
  withPrices.sort((a, b) => a.total_cart_cost_cents - b.total_cart_cost_cents);

  const cheapest = withPrices[0];
  const mostExpensive = withPrices[withPrices.length - 1];
  const savingsCents = mostExpensive.total_cart_cost_cents - cheapest.total_cart_cost_cents;
  const perTrip = savingsCents / 100;
  const annualized = Math.round(perTrip * 24); // 2 trips/mo × 12 mo

  // Check sweep destination for FACTS users
  let sweepInfo = null;
  if (isFactsUser(user)) {
    try {
      const allocR = await pool.query(
        `SELECT c.slug as bucket, ua.percentage as allocation_pct
         FROM user_allocations ua
         JOIN categories c ON c.id = ua.category_id
         WHERE ua.user_id = $1`,
        [user.id]
      );

      const targets = { necessities: 50, velocity: 10, reserve: 10, lifestyle: 10, growth: 10, legacy: 10 };
      let worstBucket = 'reserve', worstShortfall = 0, worstDisplay = 'Reserve';

      for (const alloc of allocR.rows) {
        const slug = alloc.bucket || '';
        const target = targets[slug] || 10;
        const pct = parseFloat(alloc.allocation_pct) || 0;
        const shortfall = Math.max(0, target - pct);
        if (shortfall > worstShortfall) {
          worstShortfall = shortfall;
          worstBucket = slug;
          worstDisplay = bucketDisplayName(slug);
        }
      }

      const amountNeeded = Math.round(worstShortfall * 500);
      const gapCents = Math.abs(amountNeeded);

      sweepInfo = {
        bucket: worstBucket,
        bucket_display: worstDisplay,
        shortfall_pct: Math.round(worstShortfall * 10) / 10 || 20,
        gap_cents: gapCents,
        gap_display: `$${(gapCents / 100).toFixed(2)}`,
        per_year: annualized,
        per_trip: perTrip,
        message: `Your ${worstDisplay} bucket is ${Math.round(worstShortfall * 10) / 10 || 20}% behind this month. That's ${`$${(gapCents / 100).toFixed(2)}`} needed to close the gap.`,
      };
    } catch { /* non-fatal */ }
  }

  const onlyStore = withPrices.length === 1;
  const response = {
    stores_ranked: withPrices.map((s, i) => {
      const { store_id, store_name, store_address, category, distance, total_cart_cost, total_cart_cost_cents, items_sourced, items_unavailable } = s;
      return { rank: i + 1, store_id, store_name, store_address, category, distance, total_cart_cost, total_cart_cost_cents, items_sourced, items_unavailable };
    }),
    cheapest_store: {
      store_id: cheapest.store_id,
      store_name: cheapest.store_name,
      store_category: cheapest.category,
      total_cart_cost: cheapest.total_cart_cost,
      items_sourced_count: cheapest.items_sourced.length,
    },
    savings_vs_worst_cents: savingsCents,
    savings_display: `$${perTrip.toFixed(2)}`,
    annualized_savings_cents: annualized,
    annualized_display: `$${annualized}`,
    per_trip_savings_display: `$${perTrip.toFixed(2)}`,
    ...(onlyStore && {
      edge_case: 'single_store',
      message: `Only ${cheapest.store_name} has prices in your area`,
    }),
    ...(sweepInfo && { sweep: sweepInfo }),
    upgrade_required: !isFactsUser(user),
    total_items: items.length,
  };

  res.json(response);
}));

// ── Free tier: cheapest pick per item (no total cart comparison) ─────────────
router.get('/optimize/:listId/cheapest-per-item', asyncRoute(async (req, res) => {
  const { listId } = req.params;

  const itemsR = await pool.query(
    `SELECT id, name, brand FROM mod_shopping.list_items WHERE list_id = $1`,
    [listId]
  );

  const items = itemsR.rows;
  if (!items.length) return res.json({ items: [] });

  const itemNames = items.map(i => i.name.toLowerCase());

  const pricesR = await pool.query(
    `SELECT
       LOWER(ps.product_name) as name,
       ps.store_id,
       s.name as store_name,
       s.category,
       s.lat, s.lng,
       MIN(ps.price_cents)::INTEGER as best_price
     FROM mod_shopping.price_submissions ps
     JOIN mod_shopping.stores s ON s.id = ps.store_id
     WHERE LOWER(ps.product_name) = ANY($1)
     GROUP BY LOWER(ps.product_name), ps.store_id, s.name, s.category, s.lat, s.lng
     ORDER BY best_price ASC`,
    [itemNames]
  );

  // Deduplicate: keep only lowest price per item name
  const seen = new Set();
  const picks = [];
  for (const row of pricesR.rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    const qty = (items.find(i => i.name.toLowerCase() === row.name) || { quantity: 1 }).quantity || 1;
    picks.push({
      name: items.find(i => i.name.toLowerCase() === row.name)?.name || row.name,
      store_name: row.store_name,
      category: row.category || 'unknown',
      price_cents: row.best_price,
      price_display: `$${(row.best_price / 100).toFixed(2)}`,
      quantity: qty,
    });
  }

  res.json({
    items: picks,
    upgrade_required: true,
    message: 'Going to multiple stores? FACTS Pro finds the ONE store that saves the most.',
  });
}));

// ── Sweep Destination ─────────────────────────────────────────────────────
router.get('/sweep-destination', asyncRoute(async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  // Get user's bucket percentages via proper category join
  const allocR = await pool.query(
    `SELECT c.slug as bucket, ua.percentage as allocation_pct
     FROM user_allocations ua
     JOIN categories c ON c.id = ua.category_id
     WHERE ua.user_id = $1`,
    [user.id]
  );

  if (!allocR.rows.length) {
    return res.json({
      bucket: 'reserve',
      shortfall_pct: 40,
      amount_needed_cents: 4000,
      bucket_display: 'Reserve',
      message: 'Set up your bucket allocation to enable sweep CTAs'
    });
  }

  // FACTS default targets (sum = 100)
  const targets = { necessities: 50, velocity: 10, reserve: 10, lifestyle: 10, growth: 10, legacy: 10 };
  let worstBucket = 'reserve', worstShortfall = 0, worstDisplay = 'Reserve';

  for (const alloc of allocR.rows) {
    const slug = alloc.bucket || '';
    const target = targets[slug] || 10;
    const pct = parseFloat(alloc.allocation_pct) || 0;
    const shortfall = Math.max(0, target - pct);
    if (shortfall > worstShortfall) {
      worstShortfall = shortfall;
      worstBucket = slug;
      worstDisplay = bucketDisplayName(slug);
    }
  }

  res.json({
    bucket: worstBucket,
    bucket_display: worstDisplay,
    shortfall_pct: Math.round(worstShortfall * 10) / 10 || 20,
    amount_needed_cents: Math.round(worstShortfall * 500),
    message: `Your ${worstDisplay} bucket is ${Math.round(worstShortfall * 10) / 10 || 20}% behind this month`,
  });
}));

// ── Execute Sweep ─────────────────────────────────────────────────────────
router.post('/sweep', asyncRoute(async (req, res) => {
  const { user_id } = await authOrSession(req);
  if (!user_id) return res.status(401).json({ error: 'Login required for sweep' });

  const { bucket, amount_cents, trip_savings_cents, store_id } = req.body;
  if (!bucket || !amount_cents) return res.status(400).json({ error: 'bucket and amount_cents required' });

  const r = await pool.query(
    `INSERT INTO mod_shopping.sweep_history(user_id, bucket, amount_cents, trip_savings_cents, store_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [user_id, bucket, amount_cents, trip_savings_cents || 0, store_id || null]
  );

  res.json({ sweep: r.rows[0] });
}));

// ── Receipt Scan (OCR + R2 + AI parsing) ────────────────────────────────────
router.post('/receipt-scan', upload.single('receipt'), asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { store_id, list_id, purchase_date } = req.body;

  if (!req.file) return res.status(400).json({ error: 'Receipt image required' });

  // Rate limit: 10 scans per user/session per day
  const allowed = await rateLimitReceiptScans(user_id, session_key);
  if (!allowed) {
    return res.status(429).json({
      error: 'Receipt scan limit reached. Try again tomorrow.',
      retry_after: '24 hours',
    });
  }

  // Upload receipt image
  const ext = req.file.originalname.split('.').pop() || 'jpg';
  const r2Key = `receipts/${user_id || session_key}/${Date.now()}.${ext}`;
  const imageUrl = await uploadReceiptImage(req.file.buffer, `${user_id || session_key}-${Date.now()}.${ext}`, req.file.mimetype);

  let parsedItems = [];
  let ocrError = null;

  try {
    parsedItems = await extractReceiptItems(req.file.buffer, req.file.mimetype, imageUrl);
  } catch (err) {
    ocrError = err.message;
    // Fallback: use empty array — user can still enter prices manually
  }

  if (!parsedItems.length && !ocrError) {
    ocrError = "Couldn't read receipt. Try again in better light.";
  }

  // Fetch list items if list_id provided
  let listItems = [];
  if (list_id) {
    const liR = await pool.query(
      `SELECT id, name, brand FROM mod_shopping.list_items WHERE list_id = $1 AND checked = false`,
      [list_id]
    );
    listItems = liR.rows;
  }

  const matchResult = listItems.length ? matchItemsToList(parsedItems, listItems) : null;

  // Store receipt scan record
  const receiptR = await pool.query(
    `INSERT INTO mod_shopping.receipt_scans(user_id, session_key, store_id, r2_key, image_url, purchase_date, parsed_items, total_cents, item_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      user_id, session_key, store_id || null, r2Key, imageUrl,
      purchase_date || null,
      JSON.stringify(parsedItems),
      parsedItems.reduce((s, i) => s + (i.price_cents || 0), 0),
      parsedItems.length,
    ]
  );

  res.json({
    scan_id: receiptR.rows[0].id,
    parsed_items: parsedItems,
    matches: matchResult?.matches || [],
    unmatched_receipt: matchResult?.unmatched_receipt || [],
    unmatched_list: matchResult?.unmatched_list || [],
    image_url: imageUrl,
    error: ocrError || null,
    message: parsedItems.length
      ? `Found ${parsedItems.length} items. Review and confirm below.`
      : "No items detected. Try again in better light.",
  });
}));

// ── Confirm receipt items (bulk) ──────────────────────────────────────────
router.post('/receipt-confirm', asyncRoute(async (req, res) => {
  const { scan_id, list_id, items } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'items required' });

  const { user_id, session_key } = await authOrSession(req);
  const purchaseDate = req.body.purchase_date || null;

  let confirmed = 0, totalCents = 0;
  const pricesSaved = [];

  for (const item of items) {
    if (!item.confirmed) continue;
    confirmed++;

    // Update or create list item price
    if (list_id) {
      const upR = await pool.query(
        `UPDATE mod_shopping.list_items
         SET entered_price_cents = $1, confirmed = true, updated_at = NOW()
         WHERE list_id = $2 AND id = $3
         RETURNING id, name`,
        [item.price_cents, list_id, item.list_item_id || null]
      );

      // If no list_item_id match, try by name
      if (!upR.rows.length && item.ocr_name) {
        await pool.query(
          `UPDATE mod_shopping.list_items
           SET entered_price_cents = $1, confirmed = true, updated_at = NOW()
           WHERE list_id = $2 AND LOWER(name) = LOWER($3) AND confirmed = false
           LIMIT 1`,
          [item.price_cents, list_id, item.ocr_name]
        );
      }
    }

    // Write to price_submissions (community DB contribution)
    if (item.store_id) {
      const subR = await pool.query(
        `INSERT INTO mod_shopping.price_submissions(user_id, session_key, store_id, product_name, brand, price_cents, source, receipt_scan_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'receipt_scan', $7)
         RETURNING created_at`,
        [user_id, session_key, item.store_id, item.ocr_name || item.name, item.brand || '', item.price_cents, scan_id || null]
      );
      pricesSaved.push({ name: item.ocr_name || item.name, price_cents: item.price_cents, created_at: subR.rows[0]?.created_at });
    }

    totalCents += (item.price_cents || 0);
  }

  // Update scan record
  if (scan_id) {
    await pool.query(
      `UPDATE mod_shopping.receipt_scans SET total_cents = $1 WHERE id = $2`,
      [totalCents, scan_id]
    );
  }

  res.json({
    confirmed,
    total_cents: totalCents,
    prices_saved: pricesSaved,
    message: `${confirmed} prices confirmed and saved.`,
  });
}));

// ── Receipt History ─────────────────────────────────────────────────────────
router.get('/receipts', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  const where = user_id
    ? `(user_id = $1 OR session_key = $2)`
    : `session_key = $1`;
  const params = user_id ? [user_id, session_key] : [session_key];

  const r = await pool.query(
    `SELECT rs.id, rs.store_id, rs.r2_key, rs.image_url, rs.purchase_date,
            rs.total_cents, rs.item_count, rs.parsed_items, rs.created_at,
            s.name as store_name, s.category as store_category
     FROM mod_shopping.receipt_scans rs
     LEFT JOIN mod_shopping.stores s ON s.id = rs.store_id
     WHERE ${where}
     ORDER BY rs.created_at DESC
     LIMIT $${params.length + 1}`,
    [...params, limit]
  );

  const receipts = r.rows.map(row => ({
    id: row.id,
    store_id: row.store_id,
    store_name: row.store_name || 'Unknown Store',
    store_category: row.store_category || 'unknown',
    image_url: row.image_url,
    purchase_date: row.purchase_date,
    total_cents: row.total_cents,
    item_count: row.item_count,
    created_at: row.created_at,
    items_preview: row.parsed_items ? row.parsed_items.slice(0, 3).map(i => i.name) : [],
  }));

  res.json({ receipts, count: receipts.length });
}));

// ── Single receipt detail ───────────────────────────────────────────────────
router.get('/receipts/:id', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { id } = req.params;

  const r = await pool.query(
    `SELECT rs.*, s.name as store_name, s.category as store_category
     FROM mod_shopping.receipt_scans rs
     LEFT JOIN mod_shopping.stores s ON s.id = rs.store_id
     WHERE rs.id = $1 AND (rs.user_id = $2 OR rs.session_key = $3)`,
    [id, user_id, session_key]
  );

  if (!r.rows[0]) return res.status(404).json({ error: 'Receipt not found' });

  const row = r.rows[0];
  res.json({
    receipt: {
      id: row.id,
      store_id: row.store_id,
      store_name: row.store_name || 'Unknown Store',
      store_category: row.store_category || 'unknown',
      image_url: row.image_url,
      purchase_date: row.purchase_date,
      total_cents: row.total_cents,
      item_count: row.item_count,
      parsed_items: row.parsed_items || [],
      created_at: row.created_at,
    },
  });
}));

// ── Delete receipt ──────────────────────────────────────────────────────────
router.delete('/receipts/:id', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { id } = req.params;

  const r = await pool.query(
    `DELETE FROM mod_shopping.receipt_scans
     WHERE id = $1 AND (user_id = $2 OR session_key = $3)
     RETURNING id`,
    [id, user_id, session_key]
  );

  if (!r.rows.length) return res.status(404).json({ error: 'Receipt not found or not yours' });
  res.json({ success: true, deleted_id: r.rows[0].id });
}));

// ── Trip Analysis (community avg comparison) ───────────────────────────
router.get('/trip-analysis/:listId', asyncRoute(async (req, res) => {
  const { listId } = req.params;
  const user = await getUser(req);

  const listR = await pool.query(
    `SELECT sl.*, s.name as store_name, s.id as store_id
     FROM mod_shopping.shopping_lists sl
     LEFT JOIN mod_shopping.stores s ON s.id = sl.store_id
     WHERE sl.id = $1`,
    [listId]
  );
  if (!listR.rows[0]) return res.status(404).json({ error: 'List not found' });

  const itemsR = await pool.query(
    `SELECT * FROM mod_shopping.list_items WHERE list_id = $1 AND confirmed = true AND entered_price_cents > 0`,
    [listId]
  );

  if (!itemsR.rows.length) {
    return res.json({ has_prices: false, items: [], comparison: null });
  }

  // Get community averages for each item name (case-insensitive)
  const itemNames = itemsR.rows.map(i => i.name.toLowerCase());
  const avgR = await pool.query(
    `SELECT LOWER(product_name) as name, PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_cents)::INTEGER as avg_cents, COUNT(*) as sample_size
     FROM mod_shopping.price_submissions
     WHERE LOWER(product_name) = ANY($1)
     GROUP BY LOWER(product_name)`,
    [itemNames]
  );

  const avgMap = {};
  avgR.rows.forEach(r => { avgMap[r.name] = { avg: r.avg_cents, sample: r.sample_size }; });

  let userTotal = 0, communityTotal = 0;
  const comparison = itemsR.rows.map(item => {
    const community = avgMap[item.name.toLowerCase()];
    const paid = item.entered_price_cents * (item.quantity || 1);
    const avg = community ? community.avg * (item.quantity || 1) : paid;
    userTotal += paid;
    communityTotal += avg;
    return {
      name: item.name,
      paid_cents: paid,
      avg_cents: avg,
      diff_cents: avg - paid,
      sample_size: community?.sample || 0,
      better_than_avg: community ? paid < avg : null,
    };
  });

  const tripSavingsCents = communityTotal - userTotal;

  res.json({
    has_prices: true,
    items: comparison,
    user_total_cents: userTotal,
    community_total_cents: communityTotal,
    trip_savings_cents: tripSavingsCents,
    store_name: listR.rows[0].store_name,
    upgrade_required: !isFactsUser(user),
  });
}));

// ── GET /api/mod_shopping/products?q={query}&limit=20 ──────────────────────
// Full-text product search with community average price
router.get('/products', asyncRoute(async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q || q.length < 2) return res.json({ products: [] });

  const r = await pool.query(
    `SELECT p.id, p.name, p.upc, p.category, p.created_at,
            COALESCE((SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price::DECIMAL)
                      FROM mod_shopping.prices WHERE product_id = p.id), 0)::DECIMAL(8,2) as community_avg_price
     FROM mod_shopping.products p
     WHERE LOWER(p.name) LIKE LOWER($1)
     ORDER BY p.name
     LIMIT $2`,
    [`%${q}%`, Math.min(parseInt(limit) || 20, 50)]
  );

  res.json({
    products: r.rows.map(p => ({
      id: p.id, name: p.name, upc: p.upc || '',
      category: p.category || '', created_at: p.created_at,
      community_avg_price: parseFloat(p.community_avg_price) || null,
    })),
  });
}));

// ── GET /api/mod_shopping/prices/community?product_id={id}&lat={lat}&lng={lng}&radius=5
// Returns all community prices for a product at stores within radius
router.get('/prices/community', asyncRoute(async (req, res) => {
  const { product_id, lat, lng, radius = 5 } = req.query;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });

  const latN = parseFloat(lat), lngN = parseFloat(lng), radiusN = parseFloat(radius);

  const r = await pool.query(
    `SELECT pr.id, pr.price::DECIMAL(8,2), pr.unit, pr.upc, pr.created_at,
            s.id as store_id, s.name as store_name, s.category, s.lat, s.lng
     FROM mod_shopping.prices pr
     JOIN mod_shopping.stores s ON s.id = pr.store_id
     WHERE pr.product_id = $1
     ORDER BY pr.created_at DESC`,
    [product_id]
  );

  let rows = r.rows.map(row => ({
    store_id: row.store_id, store_name: row.store_name,
    category: row.category || 'unknown',
    distance: calcDistance(latN, lngN, parseFloat(row.lat), parseFloat(row.lng)),
    price: parseFloat(row.price), unit: row.unit || '',
    upc: row.upc || '', created_at: row.created_at,
  }));

  rows = rows.filter(r => r.distance <= radiusN);

  const prices = rows.map(r => r.price).filter(p => !isNaN(p));
  const neighborhood_avg = prices.length ? parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2)) : null;

  res.json({ prices: rows, neighborhood_avg });
}));

// ── GET /api/mod_shopping/prices?product_id={id}&store_id={id}
// Returns price history for a product at a specific store (includes created_at)
router.get('/prices', asyncRoute(async (req, res) => {
  const { product_id, store_id } = req.query;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });

  const params = [product_id];
  let where = 'product_id = $1';
  if (store_id) { params.push(store_id); where += ' AND store_id = $2'; }

  const r = await pool.query(
    `SELECT id, price::DECIMAL(8,2) as price, unit, upc, contribution_type, created_at
     FROM mod_shopping.prices WHERE ${where}
     ORDER BY created_at DESC`,
    params
  );

  res.json({
    prices: r.rows.map(p => ({
      price: parseFloat(p.price), unit: p.unit || '',
      upc: p.upc || '', created_at: p.created_at,
    })),
  });
}));

// ── GET /api/mod_shopping/sweep-destination (FACTS tier) ───────────────────
// Fix response shape per spec: needs sweep_bucket + trip_savings + message
router.get('/sweep-destination', asyncRoute(async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Authentication required' });

  if (!isFactsUser(user)) {
    return res.status(403).json({
      error: 'FACTS tier required for sweep destination',
      upgrade_required: true,
    });
  }

  // Fetch bucket allocation percentages + target amounts
  const allocR = await pool.query(
    `SELECT c.slug as bucket_key, c.name as bucket_name,
            ua.percentage as allocation_pct, ua.amount_cents as current_amount,
            ua.target_cents
     FROM user_allocations ua
     JOIN categories c ON c.id = ua.category_id
     WHERE ua.user_id = $1`,
    [user.id]
  );

  // FACTS default targets (sum = 100%)
  const defaults = { necessities: 50, velocity: 10, reserve: 10, lifestyle: 10, growth: 10, legacy: 10 };
  const BUCKET_LABELS = { necessities: 'Necessities', velocity: 'Velocity', reserve: 'Reserve', lifestyle: 'Lifestyle', growth: 'Growth', legacy: 'Legacy' };

  let worstBucket = 'reserve', worstShortfallPct = 0, worstDisplay = 'Reserve';
  let worstCurrent = 0, worstTarget = 0;

  for (const row of allocR.rows) {
    const slug = row.bucket_key || '';
    const target = defaults[slug] || 10;
    const current = parseFloat(row.allocation_pct) || 0;
    const shortfall = Math.max(0, target - current);
    if (shortfall > worstShortfallPct) {
      worstShortfallPct = shortfall;
      worstBucket = slug;
      worstDisplay = BUCKET_LABELS[slug] || slug;
      worstCurrent = row.current_amount || 0;
      worstTarget = row.target_cents || (target * 500); // fallback: assume $500/mo target
    }
  }

  const gapAmount = Math.max(0, worstTarget - worstCurrent);
  const shortfallPct = Math.round((worstShortfallPct / 100) * 100 * 10) / 10;

  res.json({
    sweep_bucket: {
      bucket_name: worstDisplay,
      bucket_key: worstBucket,
      current: parseFloat((worstCurrent / 100).toFixed(2)),
      target: parseFloat((worstTarget / 100).toFixed(2)),
      shortfall_pct: shortfallPct || 20,
      gap_amount: parseFloat((gapAmount / 100).toFixed(2)),
      needed_to_close: parseFloat((gapAmount / 100).toFixed(2)),
    },
    message: `Your ${worstDisplay} bucket is ${shortfallPct || 20}% behind. Savings go directly there.`,
  });
}));

// ── Personal Items (user recall + predictive suggestions) ───────────────────
router.get('/personal-items', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  if (!user_id && !session_key) return res.status(401).json({ error: 'session required' });

  const r = await pool.query(
    `SELECT id, item_name, category, last_used_at, use_count, created_at
     FROM mod_shopping.user_personal_items
     WHERE ${user_id ? 'user_id = $1' : 'session_key = $1'}
     ORDER BY use_count DESC, last_used_at DESC NULLS LAST
     LIMIT 50`,
    [user_id || session_key]
  );
  res.json({ items: r.rows });
}));

router.post('/personal-items', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  if (!user_id && !session_key) return res.status(401).json({ error: 'session required' });

  const { item_name, category } = req.body;
  if (!item_name || !item_name.trim()) return res.status(400).json({ error: 'item_name required' });

  // Upsert: increment use_count, update last_used_at
  const r = await pool.query(
    `INSERT INTO mod_shopping.user_personal_items(user_id, session_key, item_name, category, last_used_at, use_count)
     VALUES ($1, $2, $3, $4, now(), 1)
     ON CONFLICT ${user_id ? '(user_id, item_name) WHERE user_id IS NOT NULL' : '(session_key, item_name) WHERE user_id IS NULL AND session_key IS NOT NULL'}
     DO UPDATE SET last_used_at = now(), use_count = mod_shopping.user_personal_items.use_count + 1, category = COALESCE(NULLIF($4, ''), mod_shopping.user_personal_items.category)
     RETURNING *`,
    [user_id, session_key, item_name.trim(), category || '']
  );
  res.json({ item: r.rows[0] });
}));

router.delete('/personal-items/:id', asyncRoute(async (req, res) => {
  const { user_id, session_key } = await authOrSession(req);
  const { id } = req.params;

  const where = user_id ? 'id = $1 AND user_id = $2' : 'id = $1 AND session_key = $2';
  const params = user_id ? [id, user_id] : [id, session_key];

  const r = await pool.query(
    `DELETE FROM mod_shopping.user_personal_items WHERE ${where} RETURNING id`,
    params
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
}));

// ── Predictive Suggestions (personal items + community fallback) ─────────────
router.get('/suggest', asyncRoute(async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 1) return res.json({ suggestions: [] });

  const { user_id, session_key } = await authOrSession(req);
  const sessionParam = user_id || session_key || 'anon';

  // Personal items first (sorted by use_count)
  let personal = [];
  if (user_id || session_key) {
    const pR = await pool.query(
      `SELECT item_name, category, use_count FROM mod_shopping.user_personal_items
       WHERE ${user_id ? 'user_id = $1' : 'session_key = $1'}
         AND LOWER(item_name) LIKE LOWER($2)
       ORDER BY use_count DESC LIMIT 8`,
      [sessionParam, `%${q}%`]
    );
    personal = pR.rows;
  }

  // Community products fallback
  const cR = await pool.query(
    `SELECT name, brand, category, upc FROM mod_shopping.products
     WHERE LOWER(name) LIKE LOWER($1)
     ORDER BY name LIMIT 8`,
    [`%${q}%`]
  );

  // Merge — personal items first, then community
  const suggestions = personal.map(p => ({
    name: p.item_name, source: 'personal', use_count: p.use_count,
    category: p.category || '',
  }));
  const communityNames = new Set(personal.map(p => p.item_name.toLowerCase()));
  cR.rows.forEach(c => {
    if (!communityNames.has(c.name.toLowerCase())) {
      suggestions.push({ name: c.name, brand: c.brand || '', source: 'community', category: c.category || '' });
    }
  });

  res.json({ suggestions: suggestions.slice(0, 10) });
}));

module.exports = { routes: router };