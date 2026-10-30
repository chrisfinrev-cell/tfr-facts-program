/**
 * Ensure default 6-bucket FACTS allocations exist for a new user.
 * Idempotent. Never throws.
 */
'use strict';

const DEFAULTS = [
  { slug: 'necessities', pct: 50, aliases: ['nec', 'necessities'] },
  { slug: 'reserve',     pct: 10, aliases: ['reserve', 'save'] },
  { slug: 'velocity',    pct: 10, aliases: ['velocity'] },
  { slug: 'growth',      pct: 10, aliases: ['growth', 'ff', 'financial-freedom'] },
  { slug: 'lifestyle',   pct: 10, aliases: ['lifestyle'] },
  { slug: 'legacy',      pct: 10, aliases: ['legacy'] }
];

async function seedDefaultAllocations(pool, userId) {
  if (!userId) return false;
  try {
    const existing = await pool.query(
      `SELECT COUNT(*)::INTEGER AS n FROM user_allocations WHERE user_id = $1`,
      [userId]
    );
    if (existing.rows[0] && existing.rows[0].n > 0) return false;

    const cats = await pool.query(
      `SELECT id, slug FROM categories`
    );
    const bySlug = {};
    cats.rows.forEach(function (c) {
      if (c.slug) bySlug[c.slug] = c.id;
    });

    for (const def of DEFAULTS) {
      let categoryId = null;
      for (const alias of def.aliases) {
        if (bySlug[alias]) { categoryId = bySlug[alias]; break; }
      }
      if (!categoryId) continue;
      await pool.query(
        `INSERT INTO user_allocations (user_id, category_id, percentage)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, categoryId, def.pct]
      ).catch(async function () {
        await pool.query(
          `INSERT INTO user_allocations (user_id, category_id, percentage)
           VALUES ($1, $2, $3)`,
          [userId, categoryId, def.pct]
        ).catch(function () { /* already present */ });
      });
    }

    // Partner milestone when default 6-bucket allocations are first created
    try {
      const { recordAffiliateMilestone } = require('./milestones');
      await recordAffiliateMilestone(pool, userId, 'bucket_setup_complete');
    } catch (affErr) {
      console.warn('[seedDefaultAllocations] affiliate milestone:', affErr.message);
    }

    return true;
  } catch (err) {
    console.warn('[seedDefaultAllocations]', err.message);
    return false;
  }
}

module.exports = { seedDefaultAllocations, DEFAULTS };
