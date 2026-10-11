/**
 * Price Change Notifier
 *
 * Sends rate-change warning emails to active paid subscribers
 * at 60, 30, 15, 7, and 1 day before a price bump effective date.
 *
 * Runs daily at 9 AM UTC.
 */

const { sendEmail } = require('../lib/mailer');

const APP_URL = process.env.APP_URL || 'https://app.factsmoney.com';

// Notice milestones in days
const NOTICE_DAYS = [60, 30, 15, 7, 1];

/**
 * Send a rate-change notice email to a user
 */
async function sendRateChangeEmail(email, userName, {
  noticeDays,
  currentRateCents,
  newRateCents,
  planType,
  effectiveDate
}) {
  const html = buildRateChangeEmailHtml({
    userName,
    noticeDays,
    currentRateCents,
    newRateCents,
    planType,
    effectiveDate
  });

  try {
    const result = await sendEmail({
      to: email,
      subject: buildSubjectLine(noticeDays, planType, currentRateCents, newRateCents, effectiveDate),
      html
    });

    if (!result.sent) {
      console.error(`[PriceNotifier] Email send failed for ${email}: ${result.error}`);
      return false;
    }

    console.log(`[PriceNotifier] ${noticeDays}-day notice sent to ${email}`);
    return true;
  } catch (err) {
    console.error(`[PriceNotifier] Error sending to ${email}:`, err.message);
    return false;
  }
}

function buildSubjectLine(noticeDays, planType, currentRateCents, newRateCents, effectiveDate) {
  const currentStr = formatCents(currentRateCents, planType);
  const newStr = formatCents(newRateCents, planType);
  const dateStr = new Date(effectiveDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  if (noticeDays === 1) {
    return `Final reminder: Your FACTS rate changes tomorrow (${dateStr})`;
  }
  if (noticeDays <= 7) {
    return `${noticeDays} days left at your current rate — FACTS pricing update`;
  }
  return `Your FACTS rate is changing on ${dateStr} — ${noticeDays} days' notice`;
}

function formatCents(cents, planType) {
  const dollars = (cents / 100).toFixed(2);
  if (planType === 'annual') {
    const monthly = (cents / 100 / 12).toFixed(2);
    return `$${dollars}/year ($${monthly}/mo)`;
  }
  return `$${dollars}/month`;
}

function buildRateChangeEmailHtml({ userName, noticeDays, currentRateCents, newRateCents, planType, effectiveDate }) {
  const currentStr = formatCents(currentRateCents, planType);
  const newStr = formatCents(newRateCents, planType);
  const dateStr = new Date(effectiveDate).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });
  const shortDate = new Date(effectiveDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const urgencyColor = noticeDays <= 7 ? '#ef4444' : noticeDays <= 15 ? '#f59e0b' : '#3b82f6';
  const urgencyBg = noticeDays <= 7 ? '#fef2f2' : noticeDays <= 15 ? '#fffbeb' : '#eff6ff';

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:32px;">
      <h1 style="color:#10b981;font-size:24px;font-weight:700;margin:0;">
        FACTS <span style="color:#64748b;font-weight:400;font-size:14px;">by Financial Revolution</span>
      </h1>
    </div>

    <!-- Notice badge -->
    <div style="background:${urgencyBg};border:1px solid ${urgencyColor};border-radius:8px;padding:12px 20px;margin-bottom:24px;text-align:center;">
      <span style="color:${urgencyColor};font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:1px;">
        ${noticeDays === 1 ? '⚠️ Final Reminder' : `${noticeDays}-Day Notice`}
      </span>
    </div>

    <!-- Main card -->
    <div style="background:#ffffff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.1);margin-bottom:24px;">

      <p style="color:#374151;font-size:16px;margin:0 0 16px;">
        Hi ${userName || 'there'},
      </p>

      <p style="color:#374151;font-size:16px;line-height:1.6;margin:0 0 24px;">
        We want to be transparent with you: <strong>your subscription rate is changing on ${shortDate}</strong>.
        Here's exactly what's happening:
      </p>

      <!-- Rate comparison -->
      <div style="background:#f8fafc;border-radius:8px;padding:20px;margin-bottom:24px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
          <div style="text-align:center;flex:1;">
            <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 4px;">Current Rate</p>
            <p style="color:#10b981;font-size:22px;font-weight:700;margin:0;">${currentStr}</p>
          </div>
          <div style="display:flex;align-items:center;padding:0 16px;color:#64748b;font-size:20px;">→</div>
          <div style="text-align:center;flex:1;">
            <p style="color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 4px;">New Rate (${shortDate})</p>
            <p style="color:#1e293b;font-size:22px;font-weight:700;margin:0;">${newStr}</p>
          </div>
        </div>
      </div>

      <p style="color:#374151;font-size:15px;line-height:1.6;margin:0 0 16px;">
        <strong>Your options before ${shortDate}:</strong>
      </p>
      <ul style="color:#374151;font-size:15px;line-height:1.8;padding-left:20px;margin:0 0 24px;">
        <li>Do nothing — your subscription automatically transitions to the new rate</li>
        <li>Switch from monthly to annual (or vice versa) to lock in a different rate</li>
        <li>Cancel before ${shortDate} to avoid being charged the new rate</li>
      </ul>

      <div style="text-align:center;margin-top:24px;">
        <a href="${APP_URL}/pricing.html"
          style="background:#10b981;color:#000;padding:14px 32px;border-radius:8px;
                 font-weight:700;text-decoration:none;font-size:15px;display:inline-block;">
          View Your Subscription →
        </a>
      </div>
    </div>

    <!-- Footer -->
    <p style="color:#94a3b8;font-size:12px;text-align:center;line-height:1.6;">
      FACTS Finance · <a href="${APP_URL}" style="color:#94a3b8;">app.factsmoney.com</a><br>
      You're receiving this because you have an active paid subscription.<br>
      To cancel, visit your subscription settings in the app.
    </p>

  </div>
</body>
</html>
  `.trim();
}

/**
 * Main job: check for upcoming rate changes and send notices
 */
async function runPriceChangeNotifierJob(pool) {
  console.log('[PriceNotifier] Starting price change notification check');
  const startTime = Date.now();
  const stats = { notified: 0, skipped: 0, errors: 0 };

  const client = await pool.connect();
  try {
    // Get any upcoming price bumps
    const bumpsResult = await client.query(`
      SELECT * FROM price_bump_history
      WHERE effective_date > NOW()::date
      ORDER BY effective_date ASC
    `);

    if (bumpsResult.rows.length === 0) {
      console.log('[PriceNotifier] No upcoming price bumps, nothing to do');
      return stats;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const bump of bumpsResult.rows) {
      const effectiveDate = new Date(bump.effective_date);
      effectiveDate.setHours(0, 0, 0, 0);
      const daysUntil = Math.round((effectiveDate - today) / (1000 * 60 * 60 * 24));

      console.log(`[PriceNotifier] Bump ${bump.id} (${bump.effective_date}): ${daysUntil} days away`);

      // Check if today falls on one of our notice milestones
      if (!NOTICE_DAYS.includes(daysUntil)) {
        continue;
      }

      console.log(`[PriceNotifier] Sending ${daysUntil}-day notices for bump ${bump.id}`);

      // Find active paid subscribers who need this notice.
      const usersQuery = await client.query(`
        SELECT
          u.id,
          u.email,
          u.name,
          u.subscription_plan_type
        FROM users u
        WHERE u.plan = 'paid'
          AND u.paid_until > NOW()
          AND NOT EXISTS (
            SELECT 1 FROM price_change_notifications pcn
            WHERE pcn.user_id = u.id
              AND pcn.price_bump_id = $1
              AND pcn.notice_days = $2
          )
      `, [bump.id, daysUntil]);

      console.log(`[PriceNotifier] Found ${usersQuery.rows.length} users to notify for bump ${bump.id} (${daysUntil}-day notice)`);

      for (const user of usersQuery.rows) {
        try {
          const planType = user.subscription_plan_type || 'monthly';

          // Use current standard rate (Individual pricing)
          const currentRate = planType === 'annual' ? 14900 : 1499;
          const newRate = planType === 'annual' ? bump.annual_rate_cents : bump.monthly_rate_cents;

          const sent = await sendRateChangeEmail(user.email, user.name, {
            noticeDays: daysUntil,
            currentRateCents: currentRate,
            newRateCents: newRate,
            planType,
            effectiveDate: bump.effective_date
          });

          if (sent) {
            // Record this notification to prevent duplicates
            await client.query(`
              INSERT INTO price_change_notifications
                (user_id, email, price_bump_id, notice_days, sent_at)
              VALUES ($1, $2, $3, $4, NOW())
              ON CONFLICT (user_id, price_bump_id, notice_days) DO NOTHING
            `, [user.id, user.email, bump.id, daysUntil]);

            stats.notified++;
          } else {
            stats.errors++;
          }
        } catch (err) {
          console.error(`[PriceNotifier] Error processing user ${user.id}:`, err.message);
          stats.errors++;
        }
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[PriceNotifier] Done in ${elapsed}ms — notified: ${stats.notified}, skipped: ${stats.skipped}, errors: ${stats.errors}`);
    return stats;
  } finally {
    client.release();
  }
}

module.exports = { runPriceChangeNotifierJob };
