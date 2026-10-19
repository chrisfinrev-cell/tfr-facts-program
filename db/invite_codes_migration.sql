-- Shared beta invite codes (InviteCode). One list of 100 codes for all administrators.

CREATE TABLE IF NOT EXISTS invite_codes (
  id SERIAL PRIMARY KEY,
  code VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(255) NOT NULL,
  used_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at TIMESTAMPTZ,
  CONSTRAINT invite_codes_status_chk CHECK (status IN ('ACTIVE', 'USED', 'REVOKED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS invite_codes_code_uidx ON invite_codes (UPPER(code));
CREATE INDEX IF NOT EXISTS invite_codes_status_idx ON invite_codes (status);
