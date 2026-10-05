'use strict';

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'users_relationship_tag',
  up: async (client) => {
    const sqlPath = path.join(__dirname, '..', 'db', 'migrations', 'add_relationship_tag.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
  },
  down: async (client) => {
    const sqlPath = path.join(__dirname, '..', 'db', 'migrations', 'add_relationship_tag.down.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await client.query(sql);
  }
};
