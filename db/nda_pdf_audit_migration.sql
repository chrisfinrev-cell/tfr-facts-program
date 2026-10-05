-- NDA PDF audit fields (typed signature, IP, user-agent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS nda_typed_signature TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nda_user_agent TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nda_signed_ip VARCHAR(64);
