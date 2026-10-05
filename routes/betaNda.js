const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { parseRecipientMetadata } = require('../lib/inviteCodes');
const {
  DISCLOSURE_BANNER,
  FORCE_EXCLUDED_EMAILS,
  isAffiliateEligible,
  isAffiliateExcluded,
  isPersonalContactTag,
  normalizeRelationshipTag,
  resolveCommissionRates,
  resolveInviterRelationshipTag
} = require('../lib/relationshipTags');

function getDb(req) {
  return req.app.get('db') || pool;
}

// --- HELPER: GENERATE UNIQUE 8-CHAR REFERRAL CODE ---
function generateReferralCode() {
  return 'FACTS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// --- MIDDLEWARE: ENFORCE NDA ACCEPTANCE ON PROTECTED ROUTES ---
async function enforceNda(req, res, next) {
  // If beta NDA flag is disabled globally, skip check
  if (process.env.REQUIRE_BETA_NDA === 'false') {
    return next();
  }

  // Ensure user is authenticated
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }

  // Exclude NDA page and NDA submit endpoint from redirect loop
  if (req.path === '/nda' || req.path === '/nda.html' || req.path === '/api/nda/accept') {
    return next();
  }

  if (req.session.ndaAcceptedAt) {
    return next();
  }

  try {
    const db = getDb(req);
    const result = await db.query(
      'SELECT nda_accepted_at FROM users WHERE id = $1',
      [req.session.userId]
    );
    const acceptedAt = result.rows[0] && result.rows[0].nda_accepted_at;
    if (acceptedAt) {
      req.session.ndaAcceptedAt = acceptedAt;
      return next();
    }
  } catch (err) {
    console.error('NDA enforcement check failed:', err);
  }

  return res.redirect('/nda');
}

// --- 0. GET /api/auth/invite-context ---
// Preview inviter relationship for disclosure banner (no auth required).
router.get('/api/auth/invite-context', async (req, res) => {
  const code = String(req.query.code || req.query.inviteCode || '').trim();
  if (!code) {
    return res.status(400).json({ error: 'Invite code is required.' });
  }

  const db = getDb(req);
  try {
    const inviterRelationshipTag = await resolveInviterRelationshipTag(db, code);
    const showPersonalContactDisclosure = isPersonalContactTag(inviterRelationshipTag);
    return res.json({
      success: true,
      code: code.toUpperCase(),
      inviterRelationshipTag,
      showPersonalContactDisclosure,
      disclosure: showPersonalContactDisclosure ? DISCLOSURE_BANNER : null,
      // Explicit payout parity signal for clients
      commissionRates: resolveCommissionRates(inviterRelationshipTag)
    });
  } catch (err) {
    console.error('invite-context error:', err.message);
    return res.status(500).json({ error: 'Failed to resolve invite context.' });
  }
});

// --- 1. POST /api/auth/register-beta ---
router.post('/api/auth/register-beta', async (req, res) => {
  const { email, password, inviteCode, name, fullName, relationshipTag } = req.body || {};
  const db = getDb(req);

  if (!email || !password || !inviteCode) {
    return res.status(400).json({ error: 'Email, password, and invite code are required.' });
  }

  const normalizedCode = String(inviteCode).trim().toUpperCase();
  const assignedTag = normalizeRelationshipTag(relationshipTag);
  const displayNameInput = name || fullName;

  try {
    let referrerId = null;
    let claimedInvite = null;
    let affiliateCode = null;
    let referredByCode = null;
    let affiliateTier = null;
    let inviteMetadata = {};
    let inviterRelationshipTag = 'STANDARD';

    // A) Targeted beta_invites (recipient-mapped codes)
    try {
      const inviteRes = await db.query(
        `SELECT *
         FROM beta_invites
         WHERE UPPER(code) = $1
           AND uses_count < max_uses
           AND (claimed_by_user_id IS NULL OR max_uses > 1)
         LIMIT 1`,
        [normalizedCode]
      );
      if (inviteRes.rows[0]) {
        claimedInvite = inviteRes.rows[0];
        affiliateCode = claimedInvite.code;
        referredByCode = claimedInvite.parent_code || null;
        const { tier, normalized } = parseRecipientMetadata(claimedInvite.recipient_metadata);
        inviteMetadata = normalized;
        affiliateTier = tier || 'STANDARD';

        if (referredByCode) {
          const parentUser = await db.query(
            `SELECT id, email, relationship_tag, affiliate_tier, is_affiliate_disabled, income_programs_blocked
             FROM users
             WHERE UPPER(referral_code) = UPPER($1)
                OR UPPER(affiliate_code) = UPPER($1)
             LIMIT 1`,
            [referredByCode]
          );
          if (parentUser.rows[0]) {
            if (!isAffiliateEligible(parentUser.rows[0])) {
              return res.status(400).json({
                error: 'This invite cannot be used for affiliate attribution.',
                code: 'AFFILIATE_EXCLUDED'
              });
            }
            referrerId = parentUser.rows[0].id;
            inviterRelationshipTag = normalizeRelationshipTag(parentUser.rows[0].relationship_tag);
          }
        }
      }
    } catch (inviteLookupErr) {
      console.warn('beta_invites lookup skipped:', inviteLookupErr.message);
    }

    if (!inviterRelationshipTag || inviterRelationshipTag === 'STANDARD') {
      inviterRelationshipTag = await resolveInviterRelationshipTag(db, normalizedCode);
    }

    // B) Master beta_codes
    if (!claimedInvite) {
      const masterCodeRes = await db.query(
        'SELECT * FROM beta_codes WHERE UPPER(code) = $1 AND uses_count < max_uses',
        [normalizedCode]
      );

      if (masterCodeRes.rows.length > 0) {
        await db.query('UPDATE beta_codes SET uses_count = uses_count + 1 WHERE id = $1', [
          masterCodeRes.rows[0].id
        ]);
        affiliateCode = masterCodeRes.rows[0].code;
      } else {
        // C) User referral code lineage
        const userCodeRes = await db.query(
          `SELECT id, email, monthly_invites_remaining, referral_code, relationship_tag,
                  affiliate_tier, is_affiliate_disabled, income_programs_blocked
           FROM users
           WHERE UPPER(referral_code) = $1 AND monthly_invites_remaining > 0`,
          [normalizedCode]
        );

        if (userCodeRes.rows.length === 0) {
          return res.status(400).json({ error: 'Invalid or expired invite code.' });
        }

        if (!isAffiliateEligible(userCodeRes.rows[0])) {
          return res.status(400).json({
            error: 'This referral link is not eligible for affiliate enrollment.',
            code: 'AFFILIATE_EXCLUDED'
          });
        }

        referrerId = userCodeRes.rows[0].id;
        referredByCode = userCodeRes.rows[0].referral_code;
        affiliateCode = normalizedCode;
        inviterRelationshipTag = normalizeRelationshipTag(userCodeRes.rows[0].relationship_tag);
        await db.query(
          'UPDATE users SET monthly_invites_remaining = monthly_invites_remaining - 1 WHERE id = $1',
          [referrerId]
        );
      }
    }

    // Payout parity: never use inviter relationship_tag to alter commission schedule.
    const commissionRates = resolveCommissionRates(inviterRelationshipTag);

    const emailLower = String(email).toLowerCase();
    const forceExcluded = FORCE_EXCLUDED_EMAILS.has(emailLower) || isAffiliateExcluded({
      email: emailLower,
      affiliate_tier: affiliateTier
    });
    const storedAffiliateTier = forceExcluded ? 'EXCLUDED' : affiliateTier;
    const storedAffiliateCode = forceExcluded ? null : affiliateCode;
    const storedReferredBy = forceExcluded ? null : referredByCode;
    const storedReferrerId = forceExcluded ? null : referrerId;
    const newUserReferralCode = forceExcluded ? null : generateReferralCode();

    const passwordHash = await bcrypt.hash(password, 10);
    const displayName =
      (displayNameInput && String(displayNameInput).trim()) ||
      (claimedInvite && claimedInvite.sent_to_name) ||
      null;

    let newUserRes;
    try {
      newUserRes = await db.query(
        `INSERT INTO users (
            email, name, password_hash, referral_code, referrer_id, is_beta_tester,
            affiliate_code, referred_by_code, affiliate_tier, invite_metadata, relationship_tag,
            is_affiliate_disabled, monthly_invites_remaining
          )
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9::jsonb, $10, $11, $12)
         RETURNING id, email, nda_accepted_at, affiliate_code, referred_by_code, affiliate_tier, relationship_tag`,
        [
          emailLower,
          displayName,
          passwordHash,
          newUserReferralCode,
          storedReferrerId,
          storedAffiliateCode,
          storedReferredBy,
          storedAffiliateTier,
          JSON.stringify(inviteMetadata || {}),
          assignedTag,
          forceExcluded,
          forceExcluded ? 0 : 5
        ]
      );
    } catch (columnErr) {
      console.warn('Attribution columns missing; inserting base user row.', columnErr.message);
      newUserRes = await db.query(
        `INSERT INTO users (email, name, password_hash, referral_code, referrer_id, is_beta_tester)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id, email, nda_accepted_at`,
        [emailLower, displayName, passwordHash, newUserReferralCode, storedReferrerId]
      );
    }

    const newUser = newUserRes.rows[0];

    if (claimedInvite) {
      await db.query(
        `UPDATE beta_invites
         SET uses_count = uses_count + 1,
             claimed_by_user_id = COALESCE(claimed_by_user_id, $2),
             claimed_at = COALESCE(claimed_at, NOW())
         WHERE id = $1`,
        [claimedInvite.id, newUser.id]
      );
    }

    try {
      await db.query(
        `INSERT INTO user_profiles (user_id, display_name, preferences)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (user_id) DO UPDATE
           SET display_name = COALESCE(EXCLUDED.display_name, user_profiles.display_name),
               preferences = user_profiles.preferences || EXCLUDED.preferences,
               updated_at = NOW()`,
        [
          newUser.id,
          displayName,
          JSON.stringify({ invite: inviteMetadata || {}, affiliate_tier: affiliateTier })
        ]
      );
    } catch (_) {
      // user_profiles optional
    }

    try {
      const { isAdminIncomeBlockedUser } = require('../config/adminIncomePolicy');
      const roleRes = await db.query(
        `SELECT is_admin, is_creator, email, affiliate_tier, is_affiliate_disabled, income_programs_blocked
         FROM users WHERE id = $1`,
        [newUser.id]
      );
      const eligible =
        !forceExcluded &&
        isAffiliateEligible(roleRes.rows[0]) &&
        !isAdminIncomeBlockedUser(roleRes.rows[0]);
      if (eligible) {
        await db.query(
          `INSERT INTO affiliate_houses (user_id, house_number, status) VALUES ($1, 1, 'active'), ($1, 2, 'active')
           ON CONFLICT (user_id, house_number) DO NOTHING`,
          [newUser.id]
        );
      }
    } catch (houseErr) {
      console.warn('affiliate_houses bootstrap skipped:', houseErr.message);
    }

    req.session.userId = newUser.id;
    req.session.ndaAcceptedAt = newUser.nda_accepted_at;

    const showPersonalContactDisclosure =
      !forceExcluded && isPersonalContactTag(inviterRelationshipTag);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      referralCode: forceExcluded ? null : newUserReferralCode,
      affiliateCode: forceExcluded ? null : newUser.affiliate_code || storedAffiliateCode,
      referredByCode: forceExcluded ? null : newUser.referred_by_code || storedReferredBy,
      affiliateTier: newUser.affiliate_tier || storedAffiliateTier,
      relationshipTag: newUser.relationship_tag || assignedTag,
      affiliateEligible: !forceExcluded,
      inviterRelationshipTag: forceExcluded ? null : inviterRelationshipTag,
      showPersonalContactDisclosure,
      disclosure: showPersonalContactDisclosure ? DISCLOSURE_BANNER : null,
      commissionRates: forceExcluded ? [] : commissionRates,
      requiresNda: !newUser.nda_accepted_at
    });
  } catch (err) {
    console.error('Beta registration error:', err);
    return res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

// --- 2. POST /api/nda/accept ---
router.post('/api/nda/accept', async (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  const db = getDb(req);

  try {
    const typedSignature = String(
      (req.body && (req.body.typedSignature || req.body.ndaSignature || req.body.signature)) || ''
    ).trim();
    const userAgent = String(req.headers['user-agent'] || '');
    const forwarded = req.headers['x-forwarded-for'];
    const ipAddress = (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.ip || '')
      .toString()
      .split(',')[0]
      .trim() || null;

    let result;
    try {
      result = await db.query(
        `UPDATE users
         SET nda_accepted_at = NOW(),
             nda_version = '1.0',
             nda_typed_signature = COALESCE(NULLIF($2, ''), nda_typed_signature),
             nda_user_agent = COALESCE(NULLIF($3, ''), nda_user_agent),
             nda_signed_ip = COALESCE($4, nda_signed_ip)
         WHERE id = $1
         RETURNING nda_accepted_at`,
        [req.session.userId, typedSignature, userAgent, ipAddress]
      );
    } catch (columnErr) {
      console.warn('NDA audit columns missing; recording acceptance without signature metadata.', columnErr && columnErr.message);
      result = await db.query(
        `UPDATE users
         SET nda_accepted_at = NOW(), nda_version = '1.0'
         WHERE id = $1
         RETURNING nda_accepted_at`,
        [req.session.userId]
      );
    }

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'User not found.' });
    }

    await db.query(
      `INSERT INTO nda_acceptances (user_id, accepted_at, nda_version, ip_address)
       VALUES ($1, NOW(), $2, $3)
       ON CONFLICT (user_id, nda_version) DO UPDATE SET accepted_at = NOW()`,
      [req.session.userId, 'v1', ipAddress]
    );

    // Update Session
    req.session.ndaAcceptedAt = result.rows[0].nda_accepted_at;

    return res.json({ success: true, redirectUrl: '/dashboard' });
  } catch (err) {
    console.error('NDA Acceptance Error:', err);
    return res.status(500).json({ error: 'Failed to record NDA acceptance.' });
  }
});

module.exports = { router, enforceNda };
