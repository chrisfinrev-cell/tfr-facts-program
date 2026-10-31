/**
 * Audit status columns on vault documents for checkbox → Start Forensic Audit flow.
 */
module.exports = {
  name: 'user_documents_audit_status',
  up: async (client) => {
    await client.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS audit_status VARCHAR(32) DEFAULT 'stored'`);
    await client.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS analysis_id INTEGER`);
    await client.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS audited_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS audit_headline TEXT`);
    await client.query(`ALTER TABLE user_documents ADD COLUMN IF NOT EXISTS audit_severity VARCHAR(16)`);
  }
};
