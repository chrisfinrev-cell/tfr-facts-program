#!/usr/bin/env node
'use strict';

/**
 * Production DB ops — schema check + programmatic JSON snapshot backup.
 * Usage: node scripts/prod-db-ops.js [migrate|backup]
 */

const { execSync } = require('child_process');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const prodEnv = path.join(__dirname, '..', '.env.production');
require('dotenv').config({ path: fs.existsSync(prodEnv) ? prodEnv : undefined });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('❌ Error: DATABASE_URL is not set in environment.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: /sslmode=require|neon\.tech/i.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined
});

async function runMigrations() {
  console.log('--------------------------------------------------');
  console.log(' RUNNING DATABASE MIGRATIONS & SCHEMA CHECKS... ');
  console.log('--------------------------------------------------');
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO public`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('  [✔] schema_migrations table verified.');

    execSync('node migrate.js', {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      stdio: 'inherit'
    });

    console.log('  [✔] All core modules schema synced successfully.');
  } catch (err) {
    console.error('❌ Migration error encountered.');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

async function backupDatabaseNodeStream() {
  console.log('--------------------------------------------------');
  console.log(' GENERATING PROGRAMMATIC DATA SNAPSHOT...');
  console.log('--------------------------------------------------');
  const backupDir = path.join(__dirname, '../backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `facts_snapshot_${timestamp}.json`);

  const client = await pool.connect();
  try {
    // Query critical tables for a clean programmatic JSON backup snapshot
    const tablesRes = await client.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema IN ('public', 'mod_plaid', 'mod_gamification', 'mod_lending_desk', 'mod_rewards', 'core')
      ORDER BY table_schema, table_name
    `);

    const snapshot = {
      created_at: new Date().toISOString(),
      tables: {}
    };

    for (const row of tablesRes.rows) {
      const schema = row.table_schema;
      const tableName = row.table_name;
      const qualified = `${schema}.${tableName}`;
      const dataRes = await client.query(
        `SELECT * FROM "${schema}"."${tableName}"`
      );
      snapshot.tables[qualified] = dataRes.rows;
      console.log(`  -> snapped ${qualified} (${dataRes.rows.length} rows)`);
    }

    fs.writeFileSync(backupFile, JSON.stringify(snapshot, null, 2));
    console.log(`  [✔] Programmatic snapshot successfully written to: ${backupFile}`);
  } catch (err) {
    console.error('❌ Snapshot backup failed securely without exposing credentials.');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const action = process.argv[2];
  if (action === 'migrate') {
    await runMigrations();
  } else if (action === 'backup') {
    await backupDatabaseNodeStream();
  } else {
    console.log('Usage: node scripts/prod-db-ops.js [migrate|backup]');
  }
}

main();
