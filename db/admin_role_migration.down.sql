-- Rollback: db/admin_role_migration.sql
-- Note: does not restore deleted affiliate_houses rows.
ALTER TABLE users DROP COLUMN IF EXISTS income_programs_blocked;
ALTER TABLE users DROP COLUMN IF EXISTS is_admin;
