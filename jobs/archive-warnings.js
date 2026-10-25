/**
 * Archive Warnings Job
 *
 * Run daily to check if any archived years are approaching deletion
 * and send warnings at 90, 60, 30, 7, and 1 day intervals.
 *
 * The 5-year rolling archive keeps the current year + 4 prior years.
 * Year 6 (current year - 5) is scheduled for deletion on Jan 1 of the following year.
 *
 * Example: Running in 2026
 *   - Keep: 2022, 2023, 2024, 2025, 2026
 *   - Year to delete: 2021 (6th year back)
 *   - Deletion date: Jan 1, 2027
 *
 * Usage:
 *   node jobs/archive-warnings.js           # Check and send warnings
 *   node jobs/archive-warnings.js --dry-run # Preview without sending
 */

require('dotenv').config();
const { Pool } = require('pg');
const mailer = require('../lib/mailer');

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const isDryRun = process.argv.includes('--dry-run');
const WARNING_LEVELS = [90, 60, 30, 7, 1];

// Get the year that will be deleted and when
function getArchiveDeleteInfo() {
  const now = new Date();
  const currentYear = now.getFullYear();
  // The 6th year back is scheduled for deletion on Jan 1 of current year + 1
  const yearToDelete = currentYear - 5;
  const deletionDate = new Date(`${currentYear + 1}-01-01`);
  return { yearToDelete, deletionDate };
}

function daysUntil(date) {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

async function sendEmail(toEmail, subject, htmlBody) {
  // Use Resend if configured, otherwise just log
  if (!mailer.emailConfigured()) {
    console.log(`[Archive Warnings] EMAIL (no email provider configured): To: ${toEmail}, Subject: ${subject}`);
    return false;
  }

  const result = await mailer.sendEmail({ to: toEmail, subject, html: htmlBody });
  if (!result.sent) {
    console.error('[Archive Warnings] Email send error:', result.error);
  }
  return result.sent;
}

function buildWarningEmail(user, year, deletionDate, daysLeft, warningLevel) {
  const appUrl = process.env.APP_URL || 'https://app.factsmoney.com';
  const exportUrl = `${appUrl}/app?tab=archive&export=${year}`;
  const deletionDateStr = deletionDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const urgencyColor = warningLevel <= 7 ? '#dc2626' : warningLevel <= 30 ? '#d97706' : '#1e40af';
  const urgencyLabel = warningLevel <= 1 ? '⚠️ FINAL WARNING' : warningLevel <= 7 ? '⚠️ URGENT' : '📢 Notice';

  return {
    subject: `${urgencyLabel}: Your ${year} financial data will be deleted on ${deletionDateStr}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
        <div style="background:${urgencyColor};color:white;padding:16px 24px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;">${urgencyLabel}: ${year} Data Deletion</h2>
        </div>
        <div style="background:#f9fafb;padding:24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
          <p>Hi ${user.name || user.email},</p>
          <p>As part of our <strong>5-year rolling archive</strong>, your <strong>${year}</strong> financial data is scheduled for permanent deletion on <strong>${deletionDateStr}</strong> — that's <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''} away</strong>.</p>
          <div style="background:#fff;border:2px solid ${urgencyColor};border-radius:8px;padding:16px;margin:16px 0;">
            <strong>📥 Download your ${year} data before it's gone:</strong>
            <p style="margin:8px 0 0;">Export your complete ${year} transaction history as a CSV file.</p>
            <a href="${exportUrl}" style="display:inline-block;margin-top:12px;background:${urgencyColor};color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;">Export ${year} Data (CSV)</a>
          </div>
          <p style="color:#6b7280;font-size:14px;">Once deleted, this data cannot be recovered. Log in to your account to export and acknowledge this warning.</p>
          <p style="color:#6b7280;font-size:14px;">— The FACTS Team</p>
        </div>
      </div>
    `
  };
}

async function runArchiveWarnings() {
  const client = await pool.connect();
  try {
    const { yearToDelete, deletionDate } = getArchiveDeleteInfo();
    const daysLeft = daysUntil(deletionDate);

    console.log(`[Archive Warnings] Year to delete: ${yearToDelete}, Deletion date: ${deletionDate.toISOString().split('T')[0]}, Days left: ${daysLeft}`);

    // Determine which warning levels should be sent today
    const levelsToSend = WARNING_LEVELS.filter(level => {
      // Send when days remaining matches the level (within 1 day window)
      return daysLeft <= level && daysLeft > (level - 1 === 0 ? -1 : level - 1);
    });

    if (levelsToSend.length === 0) {
      console.log('[Archive Warnings] No warnings to send today');
      return { sent: 0, skipped: 0 };
    }

    console.log(`[Archive Warnings] Sending level(s): ${levelsToSend.join(', ')}`);

    // Get all users who have data for the year being deleted
    const usersRes = await client.query(
      `SELECT DISTINCT u.id, u.email, u.name
       FROM users u
       WHERE u.id IN (
         SELECT user_id FROM year_end_snapshots WHERE year = $1
         UNION
         SELECT user_id FROM transactions WHERE EXTRACT(YEAR FROM transaction_date) = $1
       )`,
      [yearToDelete]
    );

    console.log(`[Archive Warnings] Found ${usersRes.rows.length} users with data for ${yearToDelete}`);

    let sent = 0, skipped = 0;

    for (const user of usersRes.rows) {
      for (const warningLevel of levelsToSend) {
        // Check if already sent this warning level for this user/year
        const existing = await client.query(
          `SELECT id FROM archive_warnings
           WHERE user_id = $1 AND year_to_delete = $2 AND warning_level = $3`,
          [user.id, yearToDelete, warningLevel]
        );

        if (existing.rows.length > 0) {
          skipped++;
          continue;
        }

        if (isDryRun) {
          console.log(`[Archive Warnings] DRY RUN — would send level ${warningLevel} to user ${user.id} (${user.email})`);
          skipped++;
          continue;
        }

        // Record the warning
        await client.query(
          `INSERT INTO archive_warnings (user_id, year_to_delete, deletion_date, warning_level, sent_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (user_id, year_to_delete, warning_level) DO NOTHING`,
          [user.id, yearToDelete, deletionDate.toISOString().split('T')[0], warningLevel]
        );

        // Send email
        const { subject, html } = buildWarningEmail(user, yearToDelete, deletionDate, daysLeft, warningLevel);
        const emailSent = await sendEmail(user.email, subject, html);

        console.log(`[Archive Warnings] Sent level ${warningLevel} to user ${user.id} (${user.email}) — email: ${emailSent ? 'ok' : 'failed'}`);
        sent++;
      }
    }

    console.log(`[Archive Warnings] Done. Sent: ${sent}, Skipped: ${skipped}`);
    return { sent, skipped };
  } finally {
    client.release();
  }
}

(async () => {
  try {
    await runArchiveWarnings();
    console.log('[Archive Warnings] Job complete');
  } catch (err) {
    console.error('[Archive Warnings] Fatal error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
