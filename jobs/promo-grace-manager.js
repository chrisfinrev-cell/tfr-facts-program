/**
 * Promo Grace Period Manager
 *
 * Scheduled job that enforces the 14-day grace period for promo code users
 * after the launch date.
 *
 * Rules:
 *  1. After LAUNCH_DATE, promo code users (non-creator, non-paid) who have been
 *     signed up >= 30 days get promo_grace_started_at stamped.
 *  2. 14 days after promo_grace_started_at, promo_grace_expired is set to TRUE
 *     (removes Pro access).
 *  3. If the user subscribes (plan = 'paid', paid_until > NOW()) at any point,
 *     they keep Pro and are skipped by both checks.
 *
 * Runs daily at 3 AM UTC.
 */

const { sendEmail } = require('../lib/mailer');

const GRACE_PERIOD_DAYS = 14;
const MIN_SIGNUP_DAYS = 30;

/**
 * Send a grace expiry warning email (optional — fires when grace period expires).
 */
async function sendGraceExpiredEmail(email, userName) {
  const appUrl = process.env.APP_URL || 'https://app.factsmoney.com';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color:#b45309;">Your free paid access has ended</h2>
      <p>Hi ${userName || 'there'},</p>
      <p>Your 14-day free trial has now ended. Your account has been downgraded to the <strong>Free tier</strong>.</p>

      <div style="background:#fef3c7;border:1px solid #f59e0b;padding:20px;border-radius:8px;margin:20px 0;">
        <p style="margin:0;font-weight:600;">Paid features you'll lose access to:</p>
        <ul style="margin:8px 0 0 0;">
          <li>Debt payoff tools &amp; what-if scenarios</li>
          <li>Financial Independence Calculator</li>
          <li>Net Worth Dashboard</li>
          <li>CSV export</li>
          <li>Plaid bank connectivity</li>
        </ul>
      </div>

      <p>
        <strong>Your data is safe.</strong> All your transactions and settings are preserved.
        Subscribe to unlock paid features again.
      </p>

      <p style="text-align:center;margin:32px 0;">
        <a href="${appUrl}/pricing.html"
           style="background:#10b981;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:1rem;">
          Upgrade Now →
        </a>
      </p>

      <p style="color:#666;font-size:12px;margin-top:40px;">
        FACTS Finance • Subscription Notice<br>
        This is an automated message.
      </p>
    </div>
  `;

  try {
    const result = await sendEmail({
      to: email,
      subject: 'Your FACTS free trial has ended — upgrade to keep access',
      html
    });

    if (!result.sent) {
      console.error(`[PromoGrace] Email send failed for ${email}:`, result.error);
      return false;
    }
    console.log(`[PromoGrace] Grace-expired email sent to ${email}`);
    return true;
  } catch (err) {
    console.error(`[PromoGrace] Error sending email to ${email}:`, err.message);
    return false;
  }
}

/**
 * Calculate the theoretical grace period start date for a promo user.
 * grace_start = MAX(LAUNCH_DATE, created_at + 30 days)
 */
function calcGraceStart(createdAt, launchDate) {
  const thirtyDaysLater = new Date(createdAt.getTime() + MIN_SIGNUP_DAYS * 24 * 60 * 60 * 1000);
  return thirtyDaysLater > launchDate ? thirtyDaysLater : launchDate;
}

/**
 * Main job: enforce promo grace periods.
 */
async function runPromoGraceJob(pool) {
  console.log('[PromoGrace] Starting promo grace period check');
  const startTime = Date.now();

  const LAUNCH_DATE = process.env.LAUNCH_DATE
    ? new Date(process.env.LAUNCH_DATE)
    : new Date('2026-06-30T23:59:59Z');

  const now = new Date();

  // Only process after launch date
  if (now < LAUNCH_DATE) {
    console.log(`[PromoGrace] Before launch date (${LAUNCH_DATE.toISOString()}), skipping`);
    return;
  }

  const client = await pool.connect();
  try {
    const stats = { graceStarted: 0, expired: 0, errors: 0 };

    // ─── Step 1: Start grace period for eligible users ──────────────────────
    // A user is eligible when:
    //   - Has a promo code (promo_code_used IS NOT NULL)
    //   - Not a creator (permanent Pro bypass)
    //   - No active paid subscription
    //   - Grace period not yet started (promo_grace_started_at IS NULL)
    //   - Already expired (no-op if already done)
    //   - Meets 30-day minimum: MAX(LAUNCH_DATE, created_at + 30 days) <= NOW()
    const eligibleResult = await client.query(`
      SELECT id, email, name, created_at
      FROM users
      WHERE promo_code_used IS NOT NULL
        AND is_creator = false
        AND NOT (plan = 'paid' AND paid_until IS NOT NULL AND paid_until > NOW())
        AND promo_grace_started_at IS NULL
        AND promo_grace_expired = false
        AND GREATEST($1::timestamptz, created_at + ($2 || ' days')::interval) <= NOW()
    `, [LAUNCH_DATE.toISOString(), MIN_SIGNUP_DAYS]);

    for (const user of eligibleResult.rows) {
      try {
        const graceStart = calcGraceStart(new Date(user.created_at), LAUNCH_DATE);

        await client.query(
          `UPDATE users SET promo_grace_started_at = $1, updated_at = NOW() WHERE id = $2`,
          [graceStart.toISOString(), user.id]
        );

        console.log(`[PromoGrace] Grace period started for user ${user.id} (${user.email}) — grace_start: ${graceStart.toISOString()}`);
        stats.graceStarted++;
      } catch (err) {
        console.error(`[PromoGrace] Error starting grace for user ${user.id}:`, err.message);
        stats.errors++;
      }
    }

    // ─── Step 2: Expire grace periods that have run out ─────────────────────
    // Expired when:
    //   - promo_grace_started_at IS NOT NULL
    //   - promo_grace_expired = false (not already processed)
    //   - promo_grace_started_at + 14 days <= NOW()
    //   - Still no active paid subscription (if they subscribed, keep Pro)
    const expiredResult = await client.query(`
      SELECT id, email, name, promo_grace_started_at
      FROM users
      WHERE promo_code_used IS NOT NULL
        AND is_creator = false
        AND NOT (plan = 'paid' AND paid_until IS NOT NULL AND paid_until > NOW())
        AND promo_grace_started_at IS NOT NULL
        AND promo_grace_expired = false
        AND promo_grace_started_at + ($1 || ' days')::interval <= NOW()
    `, [GRACE_PERIOD_DAYS]);

    for (const user of expiredResult.rows) {
      try {
        await client.query(
          `UPDATE users SET promo_grace_expired = true, updated_at = NOW() WHERE id = $1`,
          [user.id]
        );

        console.log(`[PromoGrace] Grace expired → downgraded user ${user.id} (${user.email})`);
        stats.expired++;

        // Send downgrade notification email (non-blocking)
        sendGraceExpiredEmail(user.email, user.name).catch(err =>
          console.error(`[PromoGrace] Failed to send expiry email to ${user.email}:`, err.message)
        );
      } catch (err) {
        console.error(`[PromoGrace] Error expiring grace for user ${user.id}:`, err.message);
        stats.errors++;
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `[PromoGrace] Complete in ${duration}s — ` +
      `Grace Started: ${stats.graceStarted}, Expired: ${stats.expired}, Errors: ${stats.errors}`
    );
  } catch (err) {
    console.error('[PromoGrace] Fatal error:', err);
  } finally {
    client.release();
  }
}

module.exports = { runPromoGraceJob };
