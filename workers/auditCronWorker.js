#!/usr/bin/env node
'use strict';

/**
 * FACTS Audit Milestone Cron Worker
 *   npm run worker              — schedule daily 08:00
 *   npm run worker -- --now     — run once
 *   npm run worker:dry          — run once with DRY_RUN email simulation
 */

require('dotenv').config();
const cron = require('node-cron');
const { checkDailyAuditMilestones } = require('../cron/auditMilestoneChecker');

const runImmediately = process.argv.includes('--now');
const isDryRun = process.argv.includes('--dry-run');

if (isDryRun) {
  process.env.DRY_RUN = 'true';
  console.log('[DRY-RUN MODE ENABLED] Emails will be simulated in the console.');
}

if (runImmediately || isDryRun) {
  console.log('[TEST MODE] Executing audit milestone check immediately...');
  checkDailyAuditMilestones()
    .then(() => {
      console.log('[TEST MODE] Execution finished successfully.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[TEST MODE ERROR] Execution failed:', error.message || error);
      process.exit(1);
    });
} else {
  console.log('[WORKER] FACTS Audit Milestone Cron Worker initialized.');

  cron.schedule('0 8 * * *', async () => {
    console.log('[WORKER] Running scheduled daily audit milestone check...');
    try {
      await checkDailyAuditMilestones();
      console.log('[WORKER] Daily audit milestone check completed successfully.');
    } catch (error) {
      console.error('[WORKER ERROR] Failed during daily audit check:', error.message || error);
    }
  });
}
