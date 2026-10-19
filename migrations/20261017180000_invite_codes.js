'use strict';

/**
 * Shared admin beta invite codes.
 * One list of 100 FIN-REV codes, visible to every administrator.
 */
module.exports = {
  name: 'invite_codes',
  up: async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(64) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
        created_by VARCHAR(255) NOT NULL,
        used_by VARCHAR(255),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        used_at TIMESTAMPTZ,
        CONSTRAINT invite_codes_status_chk CHECK (status IN ('ACTIVE', 'USED', 'REVOKED'))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS invite_codes_code_uidx
        ON invite_codes (UPPER(code))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS invite_codes_status_idx
        ON invite_codes (status)
    `);
  }
};
