-- Rollback: db/beta_invites_migration.sql
DROP INDEX IF EXISTS users_referred_by_code_idx;
DROP INDEX IF EXISTS users_affiliate_code_idx;
ALTER TABLE users DROP COLUMN IF EXISTS invite_metadata;
ALTER TABLE users DROP COLUMN IF EXISTS affiliate_tier;
ALTER TABLE users DROP COLUMN IF EXISTS referred_by_code;
ALTER TABLE users DROP COLUMN IF EXISTS affiliate_code;

DROP TABLE IF EXISTS beta_invites;
