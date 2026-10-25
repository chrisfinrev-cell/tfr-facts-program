/**
 * Process delayed onboarding recovery emails.
 * Run every 5 minutes by a scheduler (e.g. `node modules/mod_onboarding/cron-delayed-emails.js`).
 * Sends Emails 2 & 3 from the 3-part exit capture sequence.
 */
'use strict';

const { Pool } = require('pg');
const { sendEmail, emailConfigured } = require('../../lib/mailer');

async function processEmails(pool) {
  if (!emailConfigured()) {
    console.log('[cron-delayed-emails] RESEND_API_KEY not set, skipping');
    return;
  }

  const rows = await pool.query(
    `SELECT id, recipient, subject, body_plain
     FROM mod_onboarding.delayed_emails
     WHERE sent = false
       AND send_at <= now()
     ORDER BY send_at ASC
     LIMIT 20`
  );

  if (!rows.rows.length) {
    console.log('[cron-delayed-emails] no emails to send');
    return;
  }

  console.log(`[cron-delayed-emails] processing ${rows.rows.length} emails`);

  for (const row of rows.rows) {
    try {
      const result = await sendEmail({ to: row.recipient, subject: row.subject, text: row.body_plain });

      if (result.sent) {
        await pool.query(`UPDATE mod_onboarding.delayed_emails SET sent=true WHERE id=$1`, [row.id]);
        console.log(`[cron-delayed-emails] sent to ${row.recipient}: "${row.subject}"`);
      } else {
        console.error(`[cron-delayed-emails] failed for ${row.recipient}: ${result.error}`);
      }
    } catch (err) {
      console.error(`[cron-delayed-emails] send error for ${row.recipient}:`, err.message);
    }
  }
}

module.exports = { processEmails };

if (require.main === module) {
  if (process.env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
    });

    processEmails(pool)
      .then(() => pool.end())
      .catch(err => {
        console.error('[cron-delayed-emails] error:', err.message);
        pool.end();
        process.exit(1);
      });
  } else {
    console.log('[cron-delayed-emails] DATABASE_URL not set, skipping');
  }
}
