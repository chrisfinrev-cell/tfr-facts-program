-- Rollback: db/beta_nda_migration.sql
-- Destructive: removes beta invite / NDA tracking columns and related tables.

DROP TABLE IF EXISTS affiliate_houses;

ALTER TABLE users DROP COLUMN IF EXISTS nda_version;
ALTER TABLE users DROP COLUMN IF EXISTS nda_accepted_at;
ALTER TABLE users DROP COLUMN IF EXISTS last_invite_reset_at;
ALTER TABLE users DROP COLUMN IF EXISTS lifetime_invites_issued;
ALTER TABLE users DROP COLUMN IF EXISTS monthly_invites_remaining;
ALTER TABLE users DROP COLUMN IF EXISTS is_beta_tester;
ALTER TABLE users DROP COLUMN IF EXISTS referrer_id;
ALTER TABLE users DROP COLUMN IF EXISTS referral_code;

DROP TABLE IF EXISTS beta_codes;
