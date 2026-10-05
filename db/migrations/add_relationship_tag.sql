-- User self-selection / admin management: Family & Close Contact designation
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS relationship_tag VARCHAR(50) NOT NULL DEFAULT 'STANDARD';

-- Constrain known values (drop + recreate keeps migrations idempotent-friendly)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_relationship_tag_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_relationship_tag_check
      CHECK (relationship_tag IN ('STANDARD', 'FAMILY', 'CLOSE_CONTACT'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS users_relationship_tag_idx ON users (relationship_tag);

COMMENT ON COLUMN users.relationship_tag IS
  'STANDARD | FAMILY | CLOSE_CONTACT. Disclosure-only for referrals; does not alter commission rates.';
