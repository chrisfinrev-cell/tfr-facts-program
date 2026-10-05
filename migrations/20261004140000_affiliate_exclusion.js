'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'affiliate_exclusion',
  up: async (client) => {
    const sqlPath = path.join(__dirname, '..', 'db', 'migrations', 'add_affiliate_exclusion.sql');
    await client.query(fs.readFileSync(sqlPath, 'utf8'));
  },
  down: async (client) => {
    const sqlPath = path.join(__dirname, '..', 'db', 'migrations', 'add_affiliate_exclusion.down.sql');
    await client.query(fs.readFileSync(sqlPath, 'utf8'));
  }
};
