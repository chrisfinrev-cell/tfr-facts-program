/**
 * Add affiliates.name and seed T-Dagsis LLC as the master-node affiliate.
 */
module.exports = {
  name: 'affiliates_name_and_tdagsis_master_node',
  up: async (client) => {
    await client.query(`
      ALTER TABLE affiliates
        ADD COLUMN IF NOT EXISTS name VARCHAR(255)
    `);

    await client.query(`
      INSERT INTO affiliates (id, name, is_master_node, created_at)
      VALUES (1, 'T-Dagsis LLC', true, NOW())
      ON CONFLICT (id) DO UPDATE
      SET is_master_node = true, name = 'T-Dagsis LLC'
    `);
  }
};
