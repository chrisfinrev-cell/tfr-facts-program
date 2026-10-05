DROP INDEX IF EXISTS users_is_affiliate_disabled_idx;
DROP INDEX IF EXISTS users_affiliate_tier_idx;
ALTER TABLE users DROP COLUMN IF EXISTS is_affiliate_disabled;
-- affiliate_tier retained (shared with cohort/VIP attribution)
