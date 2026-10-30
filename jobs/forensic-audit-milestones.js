#!/usr/bin/env node
'use strict';

/**
 * Daily Forensic Audit Milestone Cron
 * Finds CLEAN affiliates due for DAY_90 / DAY_180 / ANNUAL reminders and emails them via Resend.
 *
 * PM2: cron_restart "15 14 * * *" (2:15 PM UTC) — see ecosystem.config.js
 */

const { Pool } = require('pg');
const { sendAuditReminderEmail } = require('../services/auditEmailService');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === 'production' || /sslmode=require|neon\.tech/i.test(process.env.DATABASE_URL || '')
      ? { rejectUnauthorized: false }
      : false
});

async function checkDailyAuditMilestones() {
  console.log('[MILESTONE CRON] Checking for due forensic audits...');
  if (!process.env.DATABASE_URL) {
    console.error('[MILESTONE CRON] DATABASE_URL not set — aborting');
    return { checked: 0, sent: 0 };
  }

  const client = await pool.connect();
  let checked = 0;
  let sent = 0;

  try {
    // Query users whose account age matches milestone triggers and are clean
    // Email lives on users (and sometimes affiliates.email on older schemas) — prefer users join
    const result = await client.query(`
      SELECT
        a.id,
        u.email AS email,
        COALESCE(
          NULLIF(split_part(COALESCE(u.name, ''), ' ', 1), ''),
          'Partner'
        ) AS first_name,
        COALESCE(a.account_created_at, a.created_at, u.created_at, NOW()) AS account_created_at,
        COALESCE(a.audit_cadence, 'INITIAL') AS audit_cadence,
        COALESCE(a.last_audit_status, 'PENDING') AS last_audit_status
      FROM affiliates a
      LEFT JOIN users u ON u.id = a.user_id
      WHERE COALESCE(a.last_audit_status, 'PENDING') = 'CLEAN'
    `);

    for (const user of result.rows) {
      checked += 1;
      if (!user.email) {
        console.warn(`[MILESTONE CRON] Skipping affiliate ${user.id} — no email`);
        continue;
      }

      const ageInDays = Math.floor(
        (Date.now() - new Date(user.account_created_at).getTime()) / (1000 * 60 * 60 * 24)
      );

      let dueMilestone = null;
      if (ageInDays >= 90 && ageInDays < 180 && user.audit_cadence === 'DAY_90') {
        dueMilestone = 'DAY_90';
      } else if (ageInDays >= 180 && ageInDays < 365 && user.audit_cadence === 'DAY_180') {
        dueMilestone = 'DAY_180';
      } else if (ageInDays >= 365 && user.audit_cadence === 'ANNUAL') {
        dueMilestone = 'ANNUAL';
      }

      if (!dueMilestone) continue;

      try {
        await sendAuditReminderEmail({
          userEmail: user.email,
          userName: user.first_name,
          milestone: dueMilestone,
          accountAgeDays: ageInDays
        });
        sent += 1;
        console.log(
          `[MILESTONE CRON] Reminder queued for affiliate=${user.id} milestone=${dueMilestone} age=${ageInDays}`
        );
      } catch (mailErr) {
        console.error(
          `[MILESTONE CRON] Email failed for affiliate=${user.id}:`,
          mailErr.message || mailErr
        );
      }
    }

    console.log(`[MILESTONE CRON] Done. checked=${checked} sent=${sent}`);
    return { checked, sent };
  } catch (error) {
    console.error('[MILESTONE CRON ERROR]', error.message || error);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    await checkDailyAuditMilestones();
    process.exitCode = 0;
  } catch (_) {
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main();
}

module.exports = { checkDailyAuditMilestones };
