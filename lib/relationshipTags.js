'use strict';

/**
 * Relationship tags are disclosure / ops designations only.
 * Commission payouts always use STANDARD rates regardless of inviter tag.
 */

const RELATIONSHIP_TAGS = Object.freeze(['STANDARD', 'FAMILY', 'CLOSE_CONTACT']);

/** Level 1–5 initial commission percentages (standard program). */
const STANDARD_COMMISSION_RATES = Object.freeze([16, 8, 4, 2, 1]);

/** Convenience alias for Level-1 direct enroller rate. */
const STANDARD_COMMISSION_RATE = STANDARD_COMMISSION_RATES[0];

const PERSONAL_CONTACT_TAGS = Object.freeze(new Set(['FAMILY', 'CLOSE_CONTACT']));

/** Accounts that must never join Future Generations / affiliate payouts. */
const FORCE_EXCLUDED_EMAILS = Object.freeze(
  new Set(['ecci2760f@gmail.com'])
);

const DISCLOSURE_BANNER =
  'You were invited by a personal contact / family member of the team. Standard FACTS™ Affiliate Program terms and standard payout schedules apply.';

function normalizeAffiliateTier(raw) {
  const tier = String(raw || '')
    .trim()
    .toUpperCase();
  return tier || null;
}

function isAffiliateExcluded(userOrTier) {
  if (userOrTier == null) return false;
  if (typeof userOrTier === 'string') {
    return normalizeAffiliateTier(userOrTier) === 'EXCLUDED';
  }
  const email = userOrTier.email && String(userOrTier.email).toLowerCase();
  if (email && FORCE_EXCLUDED_EMAILS.has(email)) return true;
  if (userOrTier.is_affiliate_disabled === true) return true;
  return normalizeAffiliateTier(userOrTier.affiliate_tier) === 'EXCLUDED';
}

/**
 * Future Generations / commission eligibility.
 * EXCLUDED personal testers and income-blocked admins are not eligible.
 */
function isAffiliateEligible(user) {
  if (!user) return false;
  if (isAffiliateExcluded(user)) return false;
  if (user.income_programs_blocked === true) return false;
  return true;
}

function normalizeRelationshipTag(raw) {
  const tag = String(raw || 'STANDARD')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (tag === 'CLOSECONTACT' || tag === 'CLOSE_CONTACT_PERSONAL_NETWORK') {
    return 'CLOSE_CONTACT';
  }
  return RELATIONSHIP_TAGS.includes(tag) ? tag : 'STANDARD';
}

function isPersonalContactTag(tag) {
  return PERSONAL_CONTACT_TAGS.has(normalizeRelationshipTag(tag));
}

/**
 * Always returns standard program rates. relationship_tag must never alter payouts.
 */
function resolveCommissionRates(_userOrTag) {
  return STANDARD_COMMISSION_RATES.slice();
}

function resolveCommissionRate(_userOrTag) {
  return STANDARD_COMMISSION_RATE;
}

/**
 * Resolve the relationship_tag of the affiliate / sponsor behind an invite code.
 */
async function resolveInviterRelationshipTag(db, code) {
  const normalized = String(code || '')
    .trim()
    .toUpperCase();
  if (!normalized) return 'STANDARD';

  try {
    const owner = await db.query(
      `SELECT relationship_tag
       FROM users
       WHERE UPPER(COALESCE(affiliate_code, '')) = $1
          OR UPPER(COALESCE(referral_code, '')) = $1
       LIMIT 1`,
      [normalized]
    );
    if (owner.rows[0]) {
      return normalizeRelationshipTag(owner.rows[0].relationship_tag);
    }
  } catch (_) {
    // column may not exist yet
  }

  try {
    const invite = await db.query(
      `SELECT parent_code, created_by_user_id
       FROM beta_invites
       WHERE UPPER(code) = $1
       LIMIT 1`,
      [normalized]
    );
    if (!invite.rows[0]) return 'STANDARD';

    const parentCode = invite.rows[0].parent_code;
    if (parentCode) {
      const parent = await db.query(
        `SELECT relationship_tag
         FROM users
         WHERE UPPER(COALESCE(affiliate_code, '')) = UPPER($1)
            OR UPPER(COALESCE(referral_code, '')) = UPPER($1)
         LIMIT 1`,
        [parentCode]
      );
      if (parent.rows[0]) {
        return normalizeRelationshipTag(parent.rows[0].relationship_tag);
      }
    }

    if (invite.rows[0].created_by_user_id) {
      const creator = await db.query(
        `SELECT relationship_tag FROM users WHERE id = $1 LIMIT 1`,
        [invite.rows[0].created_by_user_id]
      );
      if (creator.rows[0]) {
        return normalizeRelationshipTag(creator.rows[0].relationship_tag);
      }
    }
  } catch (_) {
    // beta_invites / column optional during partial migrations
  }

  return 'STANDARD';
}

module.exports = {
  RELATIONSHIP_TAGS,
  STANDARD_COMMISSION_RATE,
  STANDARD_COMMISSION_RATES,
  FORCE_EXCLUDED_EMAILS,
  DISCLOSURE_BANNER,
  normalizeRelationshipTag,
  normalizeAffiliateTier,
  isPersonalContactTag,
  isAffiliateExcluded,
  isAffiliateEligible,
  resolveCommissionRate,
  resolveCommissionRates,
  resolveInviterRelationshipTag
};
