DROP INDEX IF EXISTS users_relationship_tag_idx;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_relationship_tag_check;
ALTER TABLE users DROP COLUMN IF EXISTS relationship_tag;
