-- Affiliate-excluded personal user mode (clean end-user testing)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS affiliate_tier VARCHAR(64);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_affiliate_disabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Keep EXCLUDED in affiliate_tier; boolean mirrors for fast gating
UPDATE users
SET is_affiliate_disabled = TRUE,
    affiliate_tier = 'EXCLUDED',
    affiliate_code = NULL,
    monthly_invites_remaining = 0
WHERE LOWER(email) = 'ecci2760f@gmail.com'
   OR UPPER(COALESCE(affiliate_tier, '')) = 'EXCLUDED';

UPDATE users
SET is_affiliate_disabled = TRUE
WHERE UPPER(COALESCE(affiliate_tier, '')) = 'EXCLUDED'
  AND COALESCE(is_affiliate_disabled, FALSE) = FALSE;

CREATE INDEX IF NOT EXISTS users_affiliate_tier_idx ON users (affiliate_tier);
CREATE INDEX IF NOT EXISTS users_is_affiliate_disabled_idx ON users (is_affiliate_disabled)
  WHERE is_affiliate_disabled = TRUE;

COMMENT ON COLUMN users.affiliate_tier IS
  'STANDARD/VIP/… or EXCLUDED. EXCLUDED disables Future Generations affiliate features.';
COMMENT ON COLUMN users.is_affiliate_disabled IS
  'TRUE when affiliate_tier = EXCLUDED (or admin disabled affiliate access).';
