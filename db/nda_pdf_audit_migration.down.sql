-- Rollback: db/nda_pdf_audit_migration.sql
ALTER TABLE users DROP COLUMN IF EXISTS nda_typed_signature;
ALTER TABLE users DROP COLUMN IF EXISTS nda_user_agent;
ALTER TABLE users DROP COLUMN IF EXISTS nda_signed_ip;
