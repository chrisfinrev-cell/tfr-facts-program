'use strict';

const { Pool } = require('pg');
const { promoteFounderAdmin } = require('../lib/promoteFounderAdmin');
const { FOUNDER_ADMIN_EMAIL } = require('../config/adminAccess');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. Skip founder admin promotion.');
    return;
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });
  try {
    const result = await promoteFounderAdmin(pool);
    if (result.updated) {
      console.log('Promoted ' + result.email + ' to role ADMIN (' + result.updated + ' row).');
    } else {
      console.log('No user row for ' + FOUNDER_ADMIN_EMAIL + '. Admin status is applied when that account exists.');
    }
  } finally {
    await pool.end();
  }
}

main().catch(function (err) {
  console.error(err.message || err);
  process.exit(1);
});
