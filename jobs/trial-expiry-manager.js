/**
 * Trial Expiry Manager
 *
 * Scheduled job that sends notification emails when 21-day free trials expire.
 * Also handles Day-7 and Day-1 warning emails.
 *
 * Rules:
 *  1. Day 7 of trial → send "14 days left" reminder
 *  2. Day 20 of trial (1 day left) → send urgent "last day" email
 *  3. Day 21+ (trial expired) → send "trial ended" email once
 *     - Pro access is automatically removed by hasProAccess() checking trial_expires_at
 *     - No DB flag needed for expiry; it's computed from trial_expires_at < NOW()
 *
 * Runs daily at 4 AM UTC.
 */

const { sendEmail } = require('../lib/mailer');

const TRIAL_DURATION_DAYS = 21;

/**
 * Send trial reminder email.
 */
async function sendTrialEmail(email, userName, type, appUrl) {
  const baseUrl = appUrl || process.env.APP_URL || 'https://app.factsmoney.com';

  let subject, html;

  if (type === 'day7') {
    subject = '🔥 14 days left in your FACTS free trial — keep the momentum!';
    html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 40px 32px; border-radius: 12px;">
        <h2 style="color:#10b981; margin-bottom:8px;">14 days left in your free trial</h2>
        <p>Hi ${userName || 'there'},</p>
        <p>You're 7 days into your FACTS free trial — nice work! You still have <strong style="color:#fde68a;">14 days</strong> of full paid access left.</p>

        <div style="background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);padding:20px;border-radius:8px;margin:20px 0;">
          <p style="margin:0 0 8px 0;font-weight:600;color:#10b981;">Features to explore before your trial ends:</p>
          <ul style="margin:0;padding-left:20px;color:#cbd5e1;">
            <li>Debt snowball vs avalanche optimizer</li>
            <li>What-if scenario planner</li>
            <li>Financial Independence Calculator</li>
            <li>Net Worth Dashboard</li>
            <li>CSV data export</li>
          </ul>
        </div>

        <p>Subscribe now and your rate is locked forever — the price you sign up at is your price, period.</p>

        <p style="text-align:center;margin:32px 0;">
          <a href="${baseUrl}/pricing.html"
             style="background:#10b981;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">
            Subscribe Now — Keep Your Access →
          </a>
        </p>

        <p style="color:#64748b;font-size:12px;margin-top:40px;">
          FACTS Finance • Trial Reminder<br>
          You're receiving this because you started a free trial.
        </p>
      </div>
    `;
  } else if (type === 'day20') {
    subject = '⏰ Last day of your FACTS free trial — don\'t lose your momentum!';
    html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 40px 32px; border-radius: 12px;">
        <h2 style="color:#f59e0b; margin-bottom:8px;">⚡ Your free trial ends tomorrow</h2>
        <p>Hi ${userName || 'there'},</p>
        <p>Your 21-day FACTS free trial expires <strong style="color:#fde68a;">tomorrow</strong>. After that, you'll be on the free tier — you'll keep all your data, but lose access to paid tools.</p>

        <div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.4);padding:20px;border-radius:8px;margin:20px 0;">
          <p style="margin:0 0 8px 0;font-weight:600;color:#f59e0b;">What you'll lose tomorrow:</p>
          <ul style="margin:0;padding-left:20px;color:#cbd5e1;">
            <li>Debt reduction program &amp; visual payoff graphs</li>
            <li>What-if scenario planner</li>
            <li>Financial freedom calculator</li>
            <li>CSV data export</li>
            <li>Bank connectivity (coming soon)</li>
          </ul>
        </div>

        <p><strong style="color:#fde68a;">Your data is safe</strong> — subscribe now and keep building momentum without interruption.</p>
        <p>Subscribe now and your rate is locked forever — no increases, no surprises. 🔒</p>

        <p style="text-align:center;margin:32px 0;">
          <a href="${baseUrl}/pricing.html"
             style="background:#f59e0b;color:#000;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1.1rem;">
            Keep My Paid Access →
          </a>
        </p>

        <p style="color:#64748b;font-size:12px;margin-top:40px;">
          FACTS Finance • Trial Expiry Notice<br>
          No action needed if you don't want to continue — your account stays free.
        </p>
      </div>
    `;
  } else if (type === 'expired') {
    subject = 'Your FACTS free trial has ended — your data is safe 💚';
    html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f172a; color: #e2e8f0; padding: 40px 32px; border-radius: 12px;">
        <h2 style="color:#94a3b8; margin-bottom:8px;">Your 21-day trial has ended</h2>
        <p>Hi ${userName || 'there'},</p>
        <p>Your FACTS free trial has ended. Your account is now on the <strong>Free tier</strong>.</p>

        <div style="background:rgba(148,163,184,0.1);border:1px solid rgba(148,163,184,0.2);padding:20px;border-radius:8px;margin:20px 0;">
          <p style="margin:0 0 4px 0;color:#10b981;font-weight:600;">✅ Your data is completely safe:</p>
          <p style="margin:0;color:#cbd5e1;font-size:0.9rem;">All transactions, allocations, budgets, and settings are preserved. We never delete your data.</p>
        </div>

        <p>Whenever you're ready to unlock paid tools again, subscribing takes 30 seconds — no setup required.</p>

        <p style="text-align:center;margin:32px 0;">
          <a href="${baseUrl}/pricing.html"
             style="background:#10b981;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">
            Upgrade Now — Keep the Momentum →
          </a>
        </p>

        <p style="color:#64748b;font-size:12px;margin-top:40px;">
          FACTS Finance • Trial Ended<br>
          No action needed. Upgrade anytime at ${baseUrl}/pricing.html
        </p>
      </div>
    `;
  }

  try {
    const result = await sendEmail({ to: email, subject, html });

    if (!result.sent) {
      console.error(`[TrialExpiry] Email send failed for ${email} (type=${type}):`, result.error);
      return false;
    }
    console.log(`[TrialExpiry] ${type} email sent to ${email}`);
    return true;
  } catch (err) {
    console.error(`[TrialExpiry] Error sending email to ${email} (type=${type}):`, err.message);
    return false;
  }
}

/**
 * Main job: send trial lifecycle emails and handle expiry notifications.
 */
async function runTrialExpiryJob(pool) {
  console.log('[TrialExpiry] Starting trial lifecycle check');
  const startTime = Date.now();

  const appUrl = process.env.APP_URL || 'https://app.factsmoney.com';
  const now = new Date();

  const client = await pool.connect();
  try {
    const stats = { day7Sent: 0, day20Sent: 0, expiredNotified: 0, errors: 0 };

    // ─── Day 7 reminder: 13-15 days remaining ───────────────────────────────
    // Send at ~day 7 (trial started 7 days ago, 14 days left)
    const day7Result = await client.query(`
      SELECT id, email, name
      FROM users
      WHERE trial_used = true
        AND trial_expires_at IS NOT NULL
        AND is_creator = false
        AND NOT (plan = 'paid' AND paid_until IS NOT NULL AND paid_until > NOW())
        AND trial_started_at + INTERVAL '7 days' <= NOW()
        AND trial_started_at + INTERVAL '8 days' > NOW()
        AND trial_expires_at > NOW()
    `);

    for (const user of day7Result.rows) {
      try {
        await sendTrialEmail(user.email, user.name, 'day7', appUrl);
        stats.day7Sent++;
      } catch (err) {
        console.error(`[TrialExpiry] Error sending day7 email to user ${user.id}:`, err.message);
        stats.errors++;
      }
    }

    // ─── Day 20 reminder: last day (expires within 24 hours) ────────────────
    const day20Result = await client.query(`
      SELECT id, email, name
      FROM users
      WHERE trial_used = true
        AND trial_expires_at IS NOT NULL
        AND is_creator = false
        AND NOT (plan = 'paid' AND paid_until IS NOT NULL AND paid_until > NOW())
        AND trial_expires_at > NOW()
        AND trial_expires_at <= NOW() + INTERVAL '24 hours'
    `);

    for (const user of day20Result.rows) {
      try {
        await sendTrialEmail(user.email, user.name, 'day20', appUrl);
        stats.day20Sent++;
      } catch (err) {
        console.error(`[TrialExpiry] Error sending day20 email to user ${user.id}:`, err.message);
        stats.errors++;
      }
    }

    // ─── Expired trials: send expiry notification (once, within 24h of expiry) ──
    // We detect expiry by: trial_expires_at passed in last 24 hours, no paid sub
    const expiredResult = await client.query(`
      SELECT id, email, name
      FROM users
      WHERE trial_used = true
        AND trial_expires_at IS NOT NULL
        AND is_creator = false
        AND NOT (plan = 'paid' AND paid_until IS NOT NULL AND paid_until > NOW())
        AND trial_expires_at <= NOW()
        AND trial_expires_at > NOW() - INTERVAL '25 hours'
    `);

    for (const user of expiredResult.rows) {
      try {
        await sendTrialEmail(user.email, user.name, 'expired', appUrl);
        stats.expiredNotified++;
      } catch (err) {
        console.error(`[TrialExpiry] Error sending expiry email to user ${user.id}:`, err.message);
        stats.errors++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `[TrialExpiry] Complete in ${duration}s — ` +
      `Day7: ${stats.day7Sent}, Day20: ${stats.day20Sent}, Expired: ${stats.expiredNotified}, Errors: ${stats.errors}`
    );
  } catch (err) {
    console.error('[TrialExpiry] Fatal error:', err);
  } finally {
    client.release();
  }
}

module.exports = { runTrialExpiryJob };
