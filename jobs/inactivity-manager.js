/**
 * Inactivity Manager
 *
 * Scheduled job that:
 * 1. Sends warning emails to inactive users (weekly, starting day 39 for free, day 69 for paid)
 * 2. Deletes data and marks accounts for deletion after grace period (60/90 days)
 *
 * Runs daily at 2 AM UTC.
 */

const { Pool } = require('pg');
const { sendEmail } = require('../lib/mailer');

// Email sending via Resend
async function sendInactivityWarning(email, userName, plan, daysInactive, gracePeriodDays) {
  const appUrl = process.env.APP_URL || 'https://app.factsmoney.com';
  const daysRemaining = gracePeriodDays - daysInactive;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Your FACTS Account Will Be Deleted Soon</h2>
      <p>Hi ${userName || 'there'},</p>
      <p>We haven't seen you log in for <strong>${daysInactive} days</strong>. To help protect your privacy and keep our servers running efficiently, we automatically delete data for inactive accounts.</p>

      <div style="background-color: #f5f5f5; padding: 20px; border-radius: 5px; margin: 20px 0;">
        <p><strong>Your account status:</strong></p>
        <p>Plan: <strong>${plan === 'free' ? 'Free' : 'Paid'}</strong></p>
        <p>Data will be deleted in: <strong>${daysRemaining} days</strong> (${new Date(Date.now() + daysRemaining * 24 * 60 * 60 * 1000).toLocaleDateString()})</p>
      </div>

      <p><strong>What happens if you don't log in:</strong></p>
      <ul>
        <li>All your transactions and financial data will be permanently deleted</li>
        <li>Your account will be closed</li>
        <li>This action cannot be undone</li>
      </ul>

      <p><strong>How to keep your account:</strong></p>
      <p>Simply <a href="${appUrl}/login" style="color: #0066cc;">log in to FACTS</a> before the deletion date. Logging in will reset your inactivity timer and cancel the scheduled deletion.</p>

      <p>If you no longer use FACTS or have any questions, please reply to this email and we'll help.</p>

      <p style="color: #666; font-size: 12px; margin-top: 40px;">
        FACTS Finance • Automated Account Cleanup<br>
        This is an automated message. Please don't reply with sensitive information.
      </p>
    </div>
  `;

  // Send via Resend
  try {
    const result = await sendEmail({
      to: email,
      subject: `Action Required: Your FACTS Account Will Be Deleted in ${daysRemaining} Days`,
      html: html
    });

    if (!result.sent) {
      console.error(`[Inactivity] Email send failed for ${email}:`, result.error);
      return false;
    }

    console.log(`[Inactivity] Warning email sent to ${email} (${daysInactive} days inactive)`);
    return true;
  } catch (err) {
    console.error(`[Inactivity] Error sending email to ${email}:`, err.message);
    return false;
  }
}

/**
 * Delete all user data:
 * - Transactions
 * - Allocations
 * - Custom subcategories
 * - Households/groups
 * - Any other user-created data
 */
async function deleteUserData(client, userId) {
  console.log(`[Inactivity] Deleting all data for user ${userId}`);

  try {
    // Delete user-created data (foreign key cascades will handle most)
    await client.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM user_allocations WHERE user_id = $1', [userId]);
    await client.query('DELETE FROM subcategories WHERE user_id = $1', [userId]);
    // Add other tables as they exist

    console.log(`[Inactivity] Data deleted for user ${userId}`);
    return true;
  } catch (err) {
    console.error(`[Inactivity] Error deleting data for user ${userId}:`, err.message);
    return false;
  }
}

/**
 * Main job: Process inactive accounts
 */
async function runInactivityJob(pool) {
  console.log('[Inactivity] Starting inactivity check job');
  const startTime = Date.now();

  const client = await pool.connect();
  try {
    // Constants for grace periods (in days)
    const FREE_GRACE_DAYS = 60;
    const PAID_GRACE_DAYS = 90;
    const WARNING_START_FREE = 39; // Start warning at day 39
    const WARNING_START_PAID = 69; // Start warning at day 69
    const WARNING_INTERVAL = 7; // Send weekly

    const now = new Date();
    const stats = { warned: 0, deleted: 0, errors: 0 };

    // ─── Step 1: Find users approaching deletion ───────────────────────────
    const inactiveResult = await client.query(`
      SELECT
        id,
        email,
        name,
        plan,
        last_login,
        scheduled_deletion_at,
        inactivity_warnings_sent,
        EXTRACT(DAY FROM (NOW() - COALESCE(last_login, created_at))) as days_inactive
      FROM users
      WHERE
        -- User has never logged in OR hasn't logged in recently
        (last_login IS NULL OR last_login < NOW() - INTERVAL '39 days')
        -- AND not already scheduled for deletion (or scheduled date hasn't passed)
        AND (scheduled_deletion_at IS NULL OR scheduled_deletion_at > NOW())
      ORDER BY last_login ASC NULLS FIRST
    `);

    const inactiveUsers = inactiveResult.rows;
    console.log(`[Inactivity] Found ${inactiveUsers.length} inactive users`);

    // Process each inactive user
    for (const user of inactiveUsers) {
      const daysInactive = Math.floor(user.days_inactive);
      const plan = user.plan || 'free';
      const gracePeriod = plan === 'free' ? FREE_GRACE_DAYS : PAID_GRACE_DAYS;
      const warningStart = plan === 'free' ? WARNING_START_FREE : WARNING_START_PAID;

      try {
        // ─── Case 1: User reached grace period → delete ──────────────────────
        if (daysInactive >= gracePeriod) {
          console.log(`[Inactivity] User ${user.id} (${user.email}) reached grace period (${daysInactive}/${gracePeriod} days)`);

          // Delete data
          await deleteUserData(client, user.id);

          // Mark as deleted and schedule final notification
          await client.query(
            `UPDATE users SET scheduled_deletion_at = NOW() WHERE id = $1`,
            [user.id]
          );

          // Log deletion notification
          await client.query(
            `INSERT INTO inactivity_notifications (user_id, notification_type, day_of_inactivity, plan)
             VALUES ($1, $2, $3, $4)`,
            [user.id, 'deleted', daysInactive, plan]
          );

          stats.deleted++;

          // Send final notification (optional - account deleted)
          await sendInactivityWarning(
            user.email,
            user.name,
            plan,
            daysInactive,
            gracePeriod
          );
        }
        // ─── Case 2: User in warning zone → send weekly reminders ─────────────
        else if (daysInactive >= warningStart) {
          const daysSinceWarning = 7 * (user.inactivity_warnings_sent || 0);
          const shouldSendWarning = (daysInactive - warningStart) % WARNING_INTERVAL === 0;

          if (shouldSendWarning) {
            console.log(`[Inactivity] Sending warning email to user ${user.id} (${daysInactive}/${gracePeriod} days)`);

            const sent = await sendInactivityWarning(
              user.email,
              user.name,
              plan,
              daysInactive,
              gracePeriod
            );

            if (sent) {
              // Log warning notification
              await client.query(
                `INSERT INTO inactivity_notifications (user_id, notification_type, day_of_inactivity, plan)
                 VALUES ($1, $2, $3, $4)`,
                [user.id, 'warning', daysInactive, plan]
              );

              // Increment warning counter
              await client.query(
                `UPDATE users SET inactivity_warnings_sent = inactivity_warnings_sent + 1 WHERE id = $1`,
                [user.id]
              );

              stats.warned++;
            } else {
              stats.errors++;
            }
          }
        }
      } catch (err) {
        console.error(`[Inactivity] Error processing user ${user.id}:`, err.message);
        stats.errors++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Inactivity] Complete in ${duration}s - Warned: ${stats.warned}, Deleted: ${stats.deleted}, Errors: ${stats.errors}`);
  } catch (err) {
    console.error('[Inactivity] Fatal error:', err);
  } finally {
    client.release();
  }
}

module.exports = { runInactivityJob };
