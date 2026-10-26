'use strict';

/**
 * Six-bucket FACTS allocations + category view.
 * Mount:
 *   app.use('/api/allocations', router)
 *   app.use('/api/categories', categoriesRouter)
 */

const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('./auth');

const router = express.Router();
const categoriesRouter = express.Router();

const FACTS_ALLOCATION_BUCKETS = [
  { slug: 'necessities', name: 'Necessities', percentage: 50, color: '#10b981', icon: '🏠', sort_order: 1 },
  { slug: 'velocity', name: 'Velocity', percentage: 10, color: '#f59e0b', icon: '⚡', sort_order: 2 },
  { slug: 'reserve', name: 'Reserve', percentage: 10, color: '#818cf8', icon: '🛡️', sort_order: 3 },
  { slug: 'lifestyle', name: 'Lifestyle', percentage: 10, color: '#ec4899', icon: '🌿', sort_order: 4 },
  { slug: 'growth', name: 'Growth', percentage: 10, color: '#06b6d4', icon: '📈', sort_order: 5 },
  { slug: 'legacy', name: 'Legacy', percentage: 10, color: '#c9a227', icon: '👑', sort_order: 6 }
];

const FACTS_SLUG_ALIASES = {
  necessities: ['necessities', 'fixed-expenses', 'fixed_expenses', 'fixed'],
  velocity: ['velocity'],
  reserve: ['reserve', 'save', 'future-expenses', 'future_expenses'],
  lifestyle: ['lifestyle', 'fun'],
  growth: ['growth', 'ff', 'financial-freedom', 'financial_freedom'],
  legacy: ['legacy']
};

function factsBucketFor(slugOrName) {
  const key = String(slugOrName || '').trim().toLowerCase();
  if (!key) return null;
  for (const bucket of FACTS_ALLOCATION_BUCKETS) {
    if (bucket.slug === key || bucket.name.toLowerCase() === key) return bucket;
    if ((FACTS_SLUG_ALIASES[bucket.slug] || []).indexOf(key) !== -1) return bucket;
  }
  return null;
}

let _factsAllocSchemaPromise = null;
function loadFactsAllocSchema() {
  if (!_factsAllocSchemaPromise) {
    _factsAllocSchemaPromise = (async () => {
      async function columnsFor(table) {
        const exists = await pool.query(
          `SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1`,
          [table]
        );
        if (!exists.rowCount) return null;
        const cols = await pool.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1`,
          [table]
        );
        return new Set(cols.rows.map(r => r.column_name));
      }
      return {
        categories: await columnsFor('categories'),
        user_allocations: await columnsFor('user_allocations'),
        permanent_allocations: await columnsFor('permanent_allocations'),
        allocation_config: await columnsFor('allocation_config')
      };
    })().catch(err => {
      _factsAllocSchemaPromise = null;
      throw err;
    });
  }
  return _factsAllocSchemaPromise;
}

function allocationHttpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function readUserAllocationView(userId) {
  const schema = await loadFactsAllocSchema();
  if (!schema.categories) {
    return {
      categories: FACTS_ALLOCATION_BUCKETS.map(b => Object.assign({ id: null }, b)),
      has_temporary: false
    };
  }

  const c = schema.categories;
  const select = ['c.id', 'c.name'];
  if (c.has('slug')) select.push('c.slug');
  if (c.has('color')) select.push('c.color');
  if (c.has('icon')) select.push('c.icon');
  if (c.has('sort_order')) select.push('c.sort_order');
  if (c.has('default_percentage')) select.push('c.default_percentage');
  const where = c.has('is_active') ? 'WHERE c.is_active IS DISTINCT FROM FALSE' : '';
  const order = c.has('sort_order') ? 'ORDER BY c.sort_order, c.id' : 'ORDER BY c.id';
  const cats = await pool.query(`SELECT ${select.join(', ')} FROM categories c ${where} ${order}`);

  const permanent = new Map();
  if (schema.permanent_allocations) {
    const rows = await pool.query(
      'SELECT category_id, percentage FROM permanent_allocations WHERE user_id = $1',
      [userId]
    );
    rows.rows.forEach(r => permanent.set(Number(r.category_id), r.percentage));
  }

  const temporary = new Map();
  const base = new Map();
  if (schema.user_allocations) {
    const hasTemp = schema.user_allocations.has('is_temporary');
    const rows = await pool.query(
      `SELECT category_id, percentage${hasTemp ? ', is_temporary' : ''}
       FROM user_allocations WHERE user_id = $1`,
      [userId]
    );
    rows.rows.forEach(r => {
      const isTemp = hasTemp && (r.is_temporary === true || r.is_temporary === 't');
      if (isTemp) temporary.set(Number(r.category_id), r.percentage);
      else base.set(Number(r.category_id), r.percentage);
    });
  }

  const config = new Map();
  if (schema.allocation_config && schema.allocation_config.has('category_id') && schema.allocation_config.has('percentage')) {
    const rows = await pool.query('SELECT category_id, percentage FROM allocation_config');
    rows.rows.forEach(r => config.set(Number(r.category_id), r.percentage));
  }

  let categories = cats.rows.map(row => {
    const id = Number(row.id);
    const bucket = factsBucketFor(row.slug) || factsBucketFor(row.name);
    let percentage = null;
    if (temporary.has(id)) percentage = temporary.get(id);
    else if (permanent.has(id)) percentage = permanent.get(id);
    else if (base.has(id)) percentage = base.get(id);
    else if (config.has(id)) percentage = config.get(id);
    else if (row.default_percentage != null) percentage = row.default_percentage;
    else if (bucket) percentage = bucket.percentage;
    else percentage = 0;
    return {
      id,
      name: row.name,
      slug: row.slug || (bucket && bucket.slug) || '',
      color: row.color || (bucket && bucket.color) || '#94a3b8',
      icon: row.icon || (bucket && bucket.icon) || '📁',
      sort_order: row.sort_order,
      percentage: parseFloat(percentage)
    };
  });

  if (!categories.length) {
    categories = FACTS_ALLOCATION_BUCKETS.map(b => Object.assign({ id: null }, b));
  }

  return { categories, has_temporary: temporary.size > 0 };
}

async function insertFactsCategory(client, schema, bucket) {
  const cols = schema.categories;
  const fields = [];
  const values = [];
  function add(col, val) {
    if (cols.has(col)) {
      fields.push(col);
      values.push(val);
    }
  }
  add('slug', bucket.slug);
  add('name', bucket.name);
  add('sort_order', bucket.sort_order);
  add('color', bucket.color);
  add('icon', bucket.icon);
  add('default_percentage', bucket.percentage);
  add('is_active', true);
  if (!fields.length) throw allocationHttpError(500, 'Allocation categories are not available');
  const placeholders = fields.map((_, i) => '$' + (i + 1)).join(', ');
  const inserted = await client.query(
    `INSERT INTO categories (${fields.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    values
  );
  return inserted.rows[0].id;
}

async function resolveAllocationCategoryId(client, schema, alloc) {
  if (!schema.categories) throw allocationHttpError(500, 'Allocation categories are not available');
  const numericId = parseInt(alloc.category_id, 10);
  if (Number.isFinite(numericId)) {
    const found = await client.query('SELECT id FROM categories WHERE id = $1', [numericId]);
    if (found.rows.length) return found.rows[0].id;
  }

  const bucket = factsBucketFor(alloc.slug) || factsBucketFor(alloc.name);
  const candidates = [];
  if (alloc.slug) candidates.push(String(alloc.slug));
  if (alloc.name) candidates.push(String(alloc.name));
  if (bucket) {
    candidates.push(bucket.slug, bucket.name);
    (FACTS_SLUG_ALIASES[bucket.slug] || []).forEach(alias => candidates.push(alias));
  }

  const cols = schema.categories;
  for (const candidate of candidates) {
    if (cols.has('slug')) {
      const bySlug = await client.query(
        'SELECT id FROM categories WHERE LOWER(slug) = LOWER($1) LIMIT 1',
        [candidate]
      );
      if (bySlug.rows.length) return bySlug.rows[0].id;
    }
    const byName = await client.query(
      'SELECT id FROM categories WHERE LOWER(name) = LOWER($1) LIMIT 1',
      [candidate]
    );
    if (byName.rows.length) return byName.rows[0].id;
  }

  if (bucket) return insertFactsCategory(client, schema, bucket);
  throw allocationHttpError(400, 'Unknown category: ' + (alloc.slug || alloc.name || alloc.category_id || 'missing'));
}

async function upsertPermanentAllocation(client, schema, userId, categoryId, percentage) {
  const cols = schema.permanent_allocations;
  if (!cols) return;
  const hasUpdated = cols.has('updated_at');
  const updated = await client.query(
    `UPDATE permanent_allocations
     SET percentage = $3${hasUpdated ? ', updated_at = NOW()' : ''}
     WHERE user_id = $1 AND category_id = $2`,
    [userId, categoryId, percentage]
  );
  if (updated.rowCount > 0) return;
  if (hasUpdated) {
    await client.query(
      `INSERT INTO permanent_allocations (user_id, category_id, percentage, updated_at)
       VALUES ($1, $2, $3, NOW())`,
      [userId, categoryId, percentage]
    );
  } else {
    await client.query(
      `INSERT INTO permanent_allocations (user_id, category_id, percentage)
       VALUES ($1, $2, $3)`,
      [userId, categoryId, percentage]
    );
  }
}

async function upsertUserAllocationRow(client, schema, userId, categoryId, percentage, asTemporary) {
  const cols = schema.user_allocations;
  if (!cols) return;
  const hasTemp = cols.has('is_temporary');
  const hasUpdated = cols.has('updated_at');

  if (hasTemp && !asTemporary) {
    const updated = await client.query(
      `UPDATE user_allocations
       SET percentage = $3, is_temporary = FALSE${hasUpdated ? ', updated_at = NOW()' : ''}
       WHERE user_id = $1 AND category_id = $2 AND is_temporary = FALSE`,
      [userId, categoryId, percentage]
    );
    if (updated.rowCount > 0) return;
  } else if (!hasTemp) {
    const updated = await client.query(
      `UPDATE user_allocations
       SET percentage = $3${hasUpdated ? ', updated_at = NOW()' : ''}
       WHERE user_id = $1 AND category_id = $2`,
      [userId, categoryId, percentage]
    );
    if (updated.rowCount > 0) return;
  }

  try {
    if (hasTemp && hasUpdated) {
      await client.query(
        `INSERT INTO user_allocations (user_id, category_id, percentage, is_temporary, updated_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [userId, categoryId, percentage, !!asTemporary]
      );
    } else if (hasTemp) {
      await client.query(
        `INSERT INTO user_allocations (user_id, category_id, percentage, is_temporary)
         VALUES ($1, $2, $3, $4)`,
        [userId, categoryId, percentage, !!asTemporary]
      );
    } else if (hasUpdated) {
      await client.query(
        `INSERT INTO user_allocations (user_id, category_id, percentage, updated_at)
         VALUES ($1, $2, $3, NOW())`,
        [userId, categoryId, percentage]
      );
    } else {
      await client.query(
        `INSERT INTO user_allocations (user_id, category_id, percentage)
         VALUES ($1, $2, $3)`,
        [userId, categoryId, percentage]
      );
    }
  } catch (err) {
    if (err.code !== '23505') throw err;
    if (hasTemp) {
      await client.query(
        `UPDATE user_allocations
         SET percentage = $3, is_temporary = $4${hasUpdated ? ', updated_at = NOW()' : ''}
         WHERE user_id = $1 AND category_id = $2`,
        [userId, categoryId, percentage, !!asTemporary]
      );
    } else {
      await client.query(
        `UPDATE user_allocations
         SET percentage = $3${hasUpdated ? ', updated_at = NOW()' : ''}
         WHERE user_id = $1 AND category_id = $2`,
        [userId, categoryId, percentage]
      );
    }
  }
}

async function ensureAllocationConfigRow(client, schema, categoryId, percentage) {
  const cols = schema.allocation_config;
  if (!cols || !cols.has('category_id') || !cols.has('percentage')) return;
  try {
    const existing = await client.query(
      'SELECT 1 FROM allocation_config WHERE category_id = $1',
      [categoryId]
    );
    if (existing.rowCount) return;
    await client.query(
      'INSERT INTO allocation_config (category_id, percentage) VALUES ($1, $2)',
      [categoryId, percentage]
    );
  } catch (err) {
    console.error('allocation_config seed skipped:', err.message);
  }
}

async function savePermanentAllocationRow(client, schema, userId, categoryId, percentage) {
  await upsertPermanentAllocation(client, schema, userId, categoryId, percentage);
  await upsertUserAllocationRow(client, schema, userId, categoryId, percentage, false);
  await ensureAllocationConfigRow(client, schema, categoryId, percentage);
}

async function saveTemporaryAllocationRow(client, schema, userId, categoryId, percentage) {
  const cols = schema.user_allocations;
  if (!cols) throw allocationHttpError(500, 'Allocation storage is not available');
  const hasTemp = cols.has('is_temporary');
  const hasUpdated = cols.has('updated_at');

  if (!hasTemp) {
    const current = await client.query(
      'SELECT percentage FROM user_allocations WHERE user_id = $1 AND category_id = $2',
      [userId, categoryId]
    );
    if (current.rows[0]) {
      await upsertPermanentAllocation(client, schema, userId, categoryId, current.rows[0].percentage);
    }
    await upsertUserAllocationRow(client, schema, userId, categoryId, percentage, false);
    return;
  }

  const existing = await client.query(
    `SELECT percentage, is_temporary FROM user_allocations
     WHERE user_id = $1 AND category_id = $2`,
    [userId, categoryId]
  );
  const storedDefault = existing.rows.find(r => r.is_temporary !== true);
  if (storedDefault && schema.permanent_allocations) {
    const already = await client.query(
      'SELECT 1 FROM permanent_allocations WHERE user_id = $1 AND category_id = $2',
      [userId, categoryId]
    );
    if (!already.rowCount) {
      await upsertPermanentAllocation(client, schema, userId, categoryId, storedDefault.percentage);
    }
  }

  await client.query(
    `DELETE FROM user_allocations
     WHERE user_id = $1 AND category_id = $2 AND is_temporary = TRUE`,
    [userId, categoryId]
  );

  try {
    if (hasUpdated) {
      await client.query(
        `INSERT INTO user_allocations (user_id, category_id, percentage, is_temporary, updated_at)
         VALUES ($1, $2, $3, TRUE, NOW())`,
        [userId, categoryId, percentage]
      );
    } else {
      await client.query(
        `INSERT INTO user_allocations (user_id, category_id, percentage, is_temporary)
         VALUES ($1, $2, $3, TRUE)`,
        [userId, categoryId, percentage]
      );
    }
  } catch (err) {
    // Older databases unique on (user_id, category_id) only, so a default row
    // already occupies the key. Mark that row one-time; permanent_allocations
    // keeps the previous default so the next income can revert.
    if (err.code !== '23505') throw err;
    await client.query(
      `UPDATE user_allocations
       SET percentage = $3, is_temporary = TRUE${hasUpdated ? ', updated_at = NOW()' : ''}
       WHERE user_id = $1 AND category_id = $2`,
      [userId, categoryId, percentage]
    );
  }
}

function validateAllocationPayload(allocations) {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return 'allocations array required';
  }
  const total = allocations.reduce((sum, a) => sum + parseFloat(a.percentage), 0);
  if (!Number.isFinite(total) || Math.abs(total - 100) > 0.01) {
    const shown = Number.isFinite(total) ? total.toFixed(2) : 'invalid';
    return `Percentages must sum to 100 (got ${shown})`;
  }
  return null;
}

categoriesRouter.get('/', requireAuth, async (req, res) => {
  try {
    const view = await readUserAllocationView(req.userId);
    res.json(view);
  } catch (err) {
    console.error('GET /api/categories error:', err.message);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

async function handleSavePermanent(req, res) {
  const { allocations } = req.body;
  const userId = req.userId;
  const invalid = validateAllocationPayload(allocations);
  if (invalid) return res.status(400).json({ error: invalid });

  const client = await pool.connect();
  try {
    const schema = await loadFactsAllocSchema();
    await client.query('BEGIN');

    for (const alloc of allocations) {
      const categoryId = await resolveAllocationCategoryId(client, schema, alloc);
      await savePermanentAllocationRow(client, schema, userId, categoryId, parseFloat(alloc.percentage));
    }

    if (schema.user_allocations && schema.user_allocations.has('is_temporary')) {
      await client.query(
        'DELETE FROM user_allocations WHERE user_id = $1 AND is_temporary = TRUE',
        [userId]
      );
    }

    await client.query('COMMIT');
    const view = await readUserAllocationView(userId);
    view.has_temporary = false;
    res.json(view);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already closed */ }
    console.error('PUT /api/allocations/permanent error:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to update permanent allocations' });
  } finally {
    client.release();
  }
}

async function handleSaveTemporary(req, res) {
  const { allocations } = req.body;
  const userId = req.userId;
  const invalid = validateAllocationPayload(allocations);
  if (invalid) return res.status(400).json({ error: invalid });

  const client = await pool.connect();
  try {
    const schema = await loadFactsAllocSchema();
    await client.query('BEGIN');

    for (const alloc of allocations) {
      const categoryId = await resolveAllocationCategoryId(client, schema, alloc);
      await saveTemporaryAllocationRow(client, schema, userId, categoryId, parseFloat(alloc.percentage));
    }

    await client.query('COMMIT');
    const view = await readUserAllocationView(userId);
    res.json(view);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* already closed */ }
    console.error('PUT /api/allocations/temporary error:', err.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to update temporary allocations' });
  } finally {
    client.release();
  }
}

router.put('/permanent', requireAuth, handleSavePermanent);
router.put('/temporary', requireAuth, handleSaveTemporary);
router.put('/', requireAuth, handleSavePermanent);

module.exports = {
  router,
  categoriesRouter,
  readUserAllocationView,
  validateAllocationPayload,
  loadFactsAllocSchema
};
