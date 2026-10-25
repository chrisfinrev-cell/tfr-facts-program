/**
 * Affiliate System Background Jobs
 *
 * Run this script periodically (daily via cron) to:
 * 1. Approve commissions after Net-30 window
 * 2. Monitor grace periods and send dunning emails
 * 3. Forfeit commissions and revoke affiliate status after Day 21
 * 4. Execute downline compression on termination
 *
 * Usage (standalone): node jobs/affiliate-jobs.js
 * Usage (scheduled):  require('./jobs/affiliate-jobs').runAffiliateJobs(pool)
 */

const { Pool } = require('pg');
const mailer = require('../lib/mailer');

const VESTING_DAYS = 30;         // 30-day pending wallet — vesting window after referral signup (updated from 90d)
const GRACE_PERIOD_DAYS = 21;    // 21-day grace for SUBSCRIPTION PAYMENT FAILURES only (not heartbeat)
const DAY_7 = 7;
const DAY_14 = 14;
const DAY_21 = 21;
const GOOD_STANDING_DAYS = 30;   // Days of continuous Pro membership required before bonuses unlock
const INACTIVITY_DAYS = 60;      // All affiliates must log in within this window or status is paused
const REQUIRED_HEARTBEATS = 3;   // Must complete 3 consecutive monthly Heartbeat Audits before first release

// ── Forfeiture Model Summary ────────────────────────────────────────────────
// Two distinct forfeiture paths exist:
//
//  1. PAYMENT FAILURE PATH (handled here, in affiliate-jobs.js):
//     Subscription payment fails → 21-day grace → Day 21: forfeit + revoke.
//     Dunning emails at Day 7, Day 14, Day 21.
//
//  2. HEARTBEAT COMPLIANCE PATH (handled in server.js HeartbeatV2 schedulers):
//     Miss monthly Heartbeat (7th of month) → commissions locked in ESCROW (Day 8).
//     Complete late → escrow releases instantly.
//     3 consecutive misses (90-DAY CLIFF) → permanent forfeiture, commissions
//     rolled up to Company Master Node. Irreversible.
//
// The 90-day cliff is the PRIMARY forfeiture mechanism under the current rules.
// The 21-day grace applies only to subscription payment resolution.

const APP_URL = process.env.APP_URL || 'https://app.factsmoney.com';

// Email sending via Resend
async function sendEmail(to, subject, htmlBody) {
  const result = await mailer.sendEmail({ to, subject, html: htmlBody });
  if (!result.sent) {
    throw new Error(`Email send failed: ${result.error || 'unknown error'}`);
  }
  return result;
}

// ─── Email Templates ──────────────────────────────────────

function getWelcomeEmail(affiliateCode) {
  return {
    subject: '🌿 Welcome to Future Generations (Affiliate)!',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0f1a;color:#f0f0f0;padding:32px;border-radius:12px;">
        <h2 style="color:#d4af37;">Welcome to Future Generations (Affiliate)!</h2>
        <p>You're now an official Future Generations member. Here's everything you need to know:</p>

        <h3 style="color:#d4af37;">Your Referral Link:</h3>
        <p><strong>${APP_URL}/pricing.html?ref=${affiliateCode}</strong></p>

        <h3 style="color:#d4af37;">Commission Structure:</h3>
        <ul>
          <li><strong>16%</strong> commission (Level 1 — Direct Enroller)</li>
          <li><strong>8%</strong> commission (Level 2 — Sponsor 1)</li>
          <li><strong>4%</strong> commission (Level 3 — Sponsor 2)</li>
          <li><strong>2%</strong> commission (Level 4 — Sponsor 3)</li>
          <li><strong>1%</strong> commission (Level 5 — Sponsor 4)</li>
        </ul>

        <h3 style="color:#d4af37;">Payout Details:</h3>
        <ul>
          <li>Minimum payout: $50.00</li>
          <li><strong>30-Day Pending Wallet</strong> — all commissions vest for 30 days after referral signup before release</li>
          <li>3 consecutive monthly Heartbeat Audits required before first release (Day 31)</li>
          <li>After Day 31: a steady monthly river of releases begins</li>
          <li>Request payouts anytime once you reach $50 in approved balance</li>
        </ul>

        <h3 style="color:#d4af37;">3:1 Merit Gate — How Company Placements Work:</h3>
        <p>The Future Generations system uses a <strong>3:1 Merit Gate</strong>. You may receive up to 3 company-gifted orphan placements over your lifetime (at Slots 1, 5, and 9) — but only when you earn them through merit:</p>
        <ul>
          <li>Slot 1: Awarded when you qualify for orphan placement</li>
          <li>Slot 5: Requires ≥3 active personal recruits before receiving your 2nd gift</li>
          <li>Slot 9: Phase 3 depth gate required before your 3rd gift</li>
        </ul>
        <p><strong>No auto-fill.</strong> Company placements are not automatic safety nets — they are merit-based rewards distributed through the Master Valve queue.</p>

        <h3 style="color:#d4af37;">Heartbeat Compliance &amp; the 90-Day Cliff:</h3>
        <p>Your Future Generations status depends on completing your <strong>monthly Heartbeat Audit</strong> (due on the 7th of each month):</p>
        <ul>
          <li><strong>Miss the 7th:</strong> Your commissions are locked in <strong>escrow</strong> beginning the 8th. You can still complete late and release escrow instantly.</li>
          <li><strong>3 consecutive missed heartbeats (90-day cliff):</strong> Your pending and escrowed commissions are <strong>permanently forfeited</strong> and rolled up to the Company Master Node. This is irreversible.</li>
        </ul>
        <p>There is no grace period for heartbeat failures — stay current every month to protect your earnings.</p>

        <h3 style="color:#d4af37;">Payment Failure Grace Period:</h3>
        <p>If your paid subscription payment fails, you have <strong>21 days</strong> to resolve it. After 21 days, your pending commissions are permanently forfeited and affiliate status is revoked.</p>

        <p style="margin-top:24px;"><a href="${APP_URL}/affiliate-dashboard.html" style="background:#d4af37;color:#0a0f1a;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:700;">View Your Dashboard</a></p>

        <p style="color:#64748b;font-size:12px;margin-top:24px;border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;">
          <strong>Disclosure:</strong> FACTS is an educational platform. We are not a bank, RIA, or broker-dealer. We do not guarantee outcomes. All financial decisions are made solely by the user. As a Future Generations affiliate, you earn commissions when others subscribe using your referral link. You must disclose this material connection whenever you promote FACTS.
        </p>

        <p>— The FACTS Team</p>
      </div>
    `
  };
}

function getReferralConversionEmail(referredEmail, commissionAmount) {
  return {
    subject: '💰 Your Referral Just Converted!',
    html: `
      <h2>Great news!</h2>
      <p><strong>${referredEmail}</strong> just signed up for a paid plan using your referral link.</p>

      <h3>Commission Earned:</h3>
      <p style="font-size: 24px; font-weight: bold; color: #10b981;">$${(commissionAmount / 100).toFixed(2)}</p>

      <p>This commission enters your <strong>30-Day Pending Wallet</strong>. After 30 days — and once you've completed 3 monthly Heartbeat Audits — it will automatically release to your approved balance.</p>

      <p><a href="${APP_URL}/affiliate-dashboard.html">View Your Dashboard</a></p>

      <p>Keep sharing!</p>
      <p>— The FACTS Team</p>
    `
  };
}

function getCommissionApprovedEmail(totalApproved) {
  return {
    subject: '✅ Commissions Approved — Funds Released!',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #10b981;">Your commissions are now approved!</h2>
        <p><strong style="font-size:20px;">$${(totalApproved / 100).toFixed(2)}</strong> has been moved to your approved balance.</p>
        <p>You can request a payout once your approved balance reaches $50.00.</p>
        <p><a href="${APP_URL}/affiliate-dashboard.html" style="background:#10b981;color:white;padding:10px 20px;text-decoration:none;border-radius:6px;font-weight:bold;">View Your Wallet</a></p>
        <p>— The FACTS Team</p>
      </div>
    `
  };
}

/**
 * Day 91 First Release — the lump-sum celebration email.
 * Sent once per affiliate on their very first vesting release.
 * @param {number} releasedCents - Total released in this first batch
 * @param {number} heartbeatsCompleted - How many audits they completed
 */
function getDay91CelebrationEmail(releasedCents, heartbeatsCompleted) {
  const amount = (releasedCents / 100).toFixed(2);
  return {
    subject: '🎉 Your Pending Wallet Has Been Released! Day 31 Is Here.',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0a0f1a; color: #f0f0f0; padding: 32px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 32px;">
          <div style="font-size: 64px; margin-bottom: 16px;">🎉</div>
          <h1 style="color: #d4af37; font-size: 28px; margin: 0;">Day 31 Is Here!</h1>
          <p style="color: #a0a0a0; margin-top: 8px;">Your 30-day vesting period has completed successfully.</p>
        </div>

        <div style="background: linear-gradient(135deg, #1a2e1a, #0d1f0d); border: 2px solid #10b981; border-radius: 10px; padding: 24px; text-align: center; margin-bottom: 24px;">
          <p style="color: #10b981; font-size: 14px; font-weight: 600; margin: 0 0 8px 0; letter-spacing: 1px; text-transform: uppercase;">Released to Your Approved Wallet</p>
          <p style="color: #10b981; font-size: 48px; font-weight: 800; margin: 0;">$${amount}</p>
          <p style="color: #a0a0a0; font-size: 13px; margin: 8px 0 0 0;">Your first month of commissions — released!</p>
        </div>

        <div style="background: rgba(212, 175, 55, 0.1); border: 1px solid rgba(212, 175, 55, 0.3); border-radius: 8px; padding: 16px; margin-bottom: 24px;">
          <h3 style="color: #d4af37; margin: 0 0 12px 0; font-size: 16px;">✅ Integrity Check Passed</h3>
          <ul style="color: #c0c0c0; font-size: 14px; margin: 0; padding-left: 20px; line-height: 1.8;">
            <li>Active paid subscriber: <strong style="color: #10b981;">Confirmed</strong></li>
            <li>Heartbeat Audits completed: <strong style="color: #10b981;">${heartbeatsCompleted} / 3 ✓</strong></li>
            <li>Good standing maintained: <strong style="color: #10b981;">Confirmed</strong></li>
          </ul>
        </div>

        <p style="color: #c0c0c0; font-size: 14px; line-height: 1.6;">
          This is the <strong style="color: #d4af37;">Day 31 Release</strong> — you just received your first month of commissions! From here on, your wallet becomes a steady river: old commissions releasing every 30 days as new ones enter vesting.
        </p>

        <p style="color: #a0a0a0; font-size: 13px; margin-top: 16px;">
          Minimum $50 approved balance required to request payout. Net-30 schedule applies.
        </p>

        <div style="text-align: center; margin-top: 28px;">
          <a href="${APP_URL}/affiliate-dashboard.html"
             style="background: #d4af37; color: #0a0f1a; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 800; font-size: 16px; display: inline-block;">
            View Your Wallet 💰
          </a>
        </div>

        <p style="color: #555; font-size: 12px; text-align: center; margin-top: 24px;">— The FACTS Team</p>
      </div>
    `
  };
}

/**
 * Day 7 dunning email — gentle reminder.
 * @param {Date|string} paymentFailedDate  - When the payment first failed (grace_period_started_at)
 * @param {Date|string} gracePeriodEnds    - When the grace period expires
 */
function getDay7WarningEmail(paymentFailedDate, gracePeriodEnds) {
  const failedDateStr = new Date(paymentFailedDate).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
  return {
    subject: 'Action Required: Your Future Generations Status',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #dc2626;">Action Required: Your Future Generations Status</h2>

        <p>Your subscription payment failed on <strong>${failedDateStr}</strong>. You have <strong>14 days remaining</strong> to resolve this before your pending commissions and Affiliate status are forfeited.</p>

        <p>Update your payment method now to protect your legacy.</p>

        <h3>During the Grace Period:</h3>
        <ul>
          <li>You still have access to paid features</li>
          <li>Commissions continue to accrue (marked as "At Risk")</li>
          <li>You cannot receive new Orphan Placements in your organization</li>
        </ul>

        <p style="margin: 24px 0;">
          <a href="${APP_URL}/pricing.html"
             style="background-color: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Update Payment
          </a>
        </p>

        <p style="color: #666; font-size: 14px;">Grace Period Ends: ${new Date(gracePeriodEnds).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>

        <p>— The FACTS Team</p>
      </div>
    `
  };
}

/**
 * Day 14 dunning email — urgent warning.
 * @param {number} pendingBalanceCents  - Current pending balance in cents
 * @param {Date|string} gracePeriodEnds - When the grace period expires
 */
function getDay14WarningEmail(pendingBalanceCents, gracePeriodEnds) {
  const pendingAmount = (pendingBalanceCents / 100).toFixed(2);
  return {
    subject: '⚠️ Warning: 7 Days Until Deactivation',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #dc2626;">⚠️ Warning: 7 Days Until Deactivation</h2>

        <p>Your Future Generations node is at risk of <strong>permanent deactivation</strong>. You have <strong>7 days left</strong>.</p>

        <p>Your pending balance of <strong style="color: #dc2626;">$${pendingAmount}</strong> and your entire organizational position will be <strong>permanently forfeited</strong> if payment is not resolved.</p>

        <p>Update your payment method immediately.</p>

        <p style="margin: 24px 0;">
          <a href="${APP_URL}/pricing.html"
             style="background-color: #dc2626; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Update Payment Now
          </a>
        </p>

        <p style="color: #666; font-size: 14px;">Grace Period Ends: ${new Date(gracePeriodEnds).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</p>

        <p>— The FACTS Team</p>
      </div>
    `
  };
}

/**
 * Day 21 final notice email — sent after forfeiture executes.
 * @param {number} forfeitedCents - Amount forfeited in cents
 */
function getDay21FinalNoticeEmail(forfeitedCents) {
  const forfeitedAmount = (forfeitedCents / 100).toFixed(2);
  return {
    subject: 'Deactivation: Your Future Generations Status Has Been Revoked',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #dc2626;">Your Future Generations Status Has Been Revoked</h2>

        <p>Your subscription payment remained unresolved for 21 days. The following actions have been taken:</p>

        <ol>
          <li>Your pending commissions of <strong>$${forfeitedAmount}</strong> have been forfeited.</li>
          <li>Your affiliate status has been <strong>permanently revoked</strong>.</li>
          <li>Your organization has been reassigned to your sponsor.</li>
        </ol>

        <h3>Want to Rejoin?</h3>
        <p>You can reactivate your paid subscription and rejoin Future Generations anytime. However, your previous organizational position and pending commissions cannot be restored.</p>

        <p style="margin: 24px 0;">
          <a href="${APP_URL}/pricing.html"
             style="background-color: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
            Reactivate Subscription
          </a>
        </p>

        <p>— The FACTS Team</p>
      </div>
    `
  };
}

// ─── Job 0a: Track good standing ──────────────────────────
//
// Rules:
//  - Active affiliate + active Pro subscription → start clock if not started
//  - Clock running for 30+ days → mark good_standing_achieved_at (bonus collection unlocked)
//  - Subscription lapses (handled in checkPaymentFailures/forfeitAndRevoke) → reset clock
async function trackGoodStanding(pool) {
  console.log('Running: Track good standing...');
  try {
    // 1. Active affiliates with active Pro who haven't started the clock → start it
    await pool.query(
      `UPDATE affiliates a
       SET good_standing_started_at = NOW(), updated_at = NOW()
       FROM users u
       WHERE a.user_id = u.id
         AND a.status = 'active'
         AND u.paid_until > NOW()
         AND a.good_standing_started_at IS NULL`,
      []
    );

    // 2. Active affiliates whose clock has been running 30+ days → mark achieved
    const now = new Date();
    const achievedCutoff = new Date(now);
    achievedCutoff.setDate(achievedCutoff.getDate() - GOOD_STANDING_DAYS);

    const achievedResult = await pool.query(
      `UPDATE affiliates a
       SET good_standing_achieved_at = NOW(), updated_at = NOW()
       FROM users u
       WHERE a.user_id = u.id
         AND a.status = 'active'
         AND u.paid_until > NOW()
         AND a.good_standing_started_at IS NOT NULL
         AND a.good_standing_started_at <= $1
         AND a.good_standing_achieved_at IS NULL
       RETURNING a.email`,
      [achievedCutoff]
    );

    for (const row of achievedResult.rows) {
      console.log(`Good standing achieved for ${row.email} — bonuses now unlocked.`);
    }

    // Forfeit pending commissions earned BEFORE good_standing_achieved_at
    // (no retroactive collection — bonuses only accrue after achieving good standing)
    if (achievedResult.rowCount > 0) {
      const forfeitResult = await pool.query(
        `UPDATE commissions c
         SET status = 'forfeited', forfeited_at = NOW(), updated_at = NOW()
         FROM affiliates a
         WHERE c.affiliate_id = a.id
           AND c.status = 'pending'
           AND a.good_standing_achieved_at IS NOT NULL
           AND c.earned_at < a.good_standing_achieved_at`
      );
      if (forfeitResult.rowCount > 0) {
        // Zero out the pending balance for these forfeitures
        await pool.query(
          `UPDATE affiliates a
           SET pending_balance_cents = GREATEST(0,
             pending_balance_cents - (
               SELECT COALESCE(SUM(amount_cents), 0)
               FROM commissions c
               WHERE c.affiliate_id = a.id
                 AND c.status = 'forfeited'
                 AND c.forfeited_at >= NOW() - INTERVAL '5 minutes'
             )
           ), updated_at = NOW()
           WHERE a.good_standing_achieved_at IS NOT NULL`
        );
        console.log(`Forfeited ${forfeitResult.rowCount} pre-good-standing commission(s).`);
      }
    }

    console.log(`Good standing tracking complete. ${achievedResult.rowCount} affiliate(s) newly achieved good standing.`);
  } catch (err) {
    console.error('trackGoodStanding error:', err.message);
  }
}

// ─── Job 0b: 60-day inactivity check ──────────────────────
//
// Pause active affiliates who haven't logged in within the past 60 days.
// Paused affiliates self-reactivate by logging back in.
async function checkInactivityRequirement(pool) {
  console.log(`Running: Check 60-day inactivity rule for all affiliates...`);
  try {
    const loginCutoff = new Date();
    loginCutoff.setDate(loginCutoff.getDate() - INACTIVITY_DAYS);

    // Pause active affiliates who haven't logged in within the 60-day window
    const pausedResult = await pool.query(
      `UPDATE affiliates a
       SET status = 'paused', paused_at = NOW(), updated_at = NOW()
       FROM users u
       WHERE a.user_id = u.id
         AND a.status = 'active'
         AND (u.last_login IS NULL OR u.last_login < $1)
       RETURNING a.id, a.email`,
      [loginCutoff]
    );

    for (const aff of pausedResult.rows) {
      console.log(`Affiliate ${aff.email} paused: no login in ${INACTIVITY_DAYS} days.`);
    }

    // Reactivate paused affiliates who have logged in recently with active Pro
    const reactivatedResult = await pool.query(
      `UPDATE affiliates a
       SET status = 'active', paused_at = NULL, updated_at = NOW()
       FROM users u
       WHERE a.user_id = u.id
         AND a.status = 'paused'
         AND u.last_login >= $1
         AND u.paid_until > NOW()
       RETURNING a.email`,
      [loginCutoff]
    );

    for (const aff of reactivatedResult.rows) {
      console.log(`Affiliate ${aff.email} reactivated: logged in within the last ${INACTIVITY_DAYS} days.`);
    }

    console.log(`Inactivity check done. Paused: ${pausedResult.rowCount}, Reactivated: ${reactivatedResult.rowCount}.`);
  } catch (err) {
    console.error('checkInactivityRequirement error:', err.message);
  }
}

// ─── Full Integrity Check ──────────────────────────────────
//
// Runs before releasing any pending commissions.
// Returns { passed: bool, reason: string, heartbeatsCompleted: number }
async function runIntegrityCheck(affiliateId, affiliateEmail, pool) {
  const now = new Date();

  // 1. Active Pro subscriber check
  const proResult = await pool.query(
    `SELECT u.paid_until FROM affiliates a
     JOIN users u ON u.id = a.user_id
     WHERE a.id = $1`,
    [affiliateId]
  );
  if (!proResult.rows.length) {
    return { passed: false, reason: 'affiliate_not_found', heartbeatsCompleted: 0 };
  }
  const paidUntil = proResult.rows[0].paid_until;
  if (!paidUntil || new Date(paidUntil) <= now) {
    return { passed: false, reason: 'pro_subscription_lapsed', heartbeatsCompleted: 0 };
  }

  // 2. Three consecutive monthly Heartbeat Audits
  //    Check last 3 calendar months (e.g. Jan/Feb/Mar for April run)
  const months = [];
  for (let i = 1; i <= 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    // month_year format: "2025-03" (YYYY-MM)
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push(ym);
  }

  const hbResult = await pool.query(
    `SELECT COUNT(DISTINCT month_year) AS completed_count
     FROM affiliate_heartbeats ah
     JOIN affiliates a ON a.user_id = ah.user_id
     WHERE a.id = $1
       AND ah.month_year = ANY($2)
       AND ah.signature_confirmed = true`,
    [affiliateId, months]
  );
  const heartbeatsCompleted = parseInt(hbResult.rows[0]?.completed_count || 0);

  if (heartbeatsCompleted < REQUIRED_HEARTBEATS) {
    console.log(
      `[IntegrityCheck] ${affiliateEmail}: only ${heartbeatsCompleted}/${REQUIRED_HEARTBEATS} heartbeats ` +
      `in ${months.join(', ')} — commissions held pending.`
    );
    return { passed: false, reason: 'insufficient_heartbeats', heartbeatsCompleted };
  }

  // All checks passed
  return { passed: true, reason: 'all_checks_passed', heartbeatsCompleted };
}

// ─── Job 1: Approve commissions after 30-day vesting ──────
//
// The Full Integrity Check runs before releasing ANY commissions:
//   ✅ Active Pro subscriber
//   ✅ 3 consecutive monthly Heartbeat Audits completed
//   ✅ Affiliate status = active (not at_risk, revoked, paused)
//   ✅ Commission earned AFTER good_standing_achieved_at
//
// If checks fail: commissions stay pending until next daily run.
// On first-ever release: sends Day 31 celebration email.
async function approveCommissions(pool) {
  console.log('Running: Approve commissions after 30-day vesting...');

  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - VESTING_DAYS);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Find commissions that have passed their 30-day vesting window.
      // Eligible conditions:
      //   - status = 'pending'
      //   - earned_at <= 30 days ago
      //   - Affiliate is ACTIVE
      //   - Affiliate has achieved good standing
      //   - Commission earned AFTER good_standing_achieved_at
      const commissionsResult = await client.query(
        `SELECT c.id, c.affiliate_id, c.amount_cents, a.email,
                a.first_release_sent_at, a.good_standing_achieved_at
         FROM commissions c
         JOIN affiliates a ON a.id = c.affiliate_id
         WHERE c.status = 'pending'
           AND c.earned_at <= $1
           AND a.status = 'active'
           AND a.good_standing_achieved_at IS NOT NULL
           AND c.earned_at >= a.good_standing_achieved_at`,
        [cutoffDate]
      );

      if (commissionsResult.rows.length === 0) {
        console.log('No commissions ready for 30-day vesting release.');
        await client.query('ROLLBACK');
        return;
      }

      // Group by affiliate
      const byAffiliate = {};
      for (const comm of commissionsResult.rows) {
        if (!byAffiliate[comm.affiliate_id]) {
          byAffiliate[comm.affiliate_id] = {
            email: comm.email,
            first_release_sent_at: comm.first_release_sent_at,
            good_standing_achieved_at: comm.good_standing_achieved_at,
            total: 0,
            commissions: []
          };
        }
        byAffiliate[comm.affiliate_id].total += comm.amount_cents;
        byAffiliate[comm.affiliate_id].commissions.push(comm.id);
      }

      let totalApproved = 0;
      let totalHeld = 0;

      // Run integrity check per affiliate before releasing
      for (const affiliateId in byAffiliate) {
        const { email, first_release_sent_at, total, commissions } = byAffiliate[affiliateId];

        const integrity = await runIntegrityCheck(parseInt(affiliateId), email, pool);

        // Mark integrity check result on commissions (non-blocking metadata)
        await client.query(
          `UPDATE commissions
           SET integrity_check_passed = $1,
               integrity_check_at = NOW(),
               updated_at = NOW()
           WHERE id = ANY($2)`,
          [integrity.passed, commissions]
        );

        if (!integrity.passed) {
          console.log(
            `[Vesting] HELD $${(total / 100).toFixed(2)} for ${email}: ${integrity.reason} ` +
            `(${integrity.heartbeatsCompleted}/${REQUIRED_HEARTBEATS} heartbeats)`
          );
          totalHeld += total;
          continue;
        }

        // ── All checks passed — release funds ──────────────────────
        await client.query(
          `UPDATE commissions
           SET status = 'approved', approved_at = NOW(), updated_at = NOW()
           WHERE id = ANY($1)`,
          [commissions]
        );

        await client.query(
          `UPDATE affiliates
           SET pending_balance_cents = GREATEST(0, pending_balance_cents - $1),
               approved_balance_cents = approved_balance_cents + $1,
               updated_at = NOW()
           WHERE id = $2`,
          [total, affiliateId]
        );

        // Update vesting_entries to reflect approval
        await client.query(
          `UPDATE vesting_entries
           SET status = 'approved', approved_at = NOW(), updated_at = NOW()
           WHERE commission_id = ANY($1)`,
          [commissions]
        );

        console.log(`[Vesting] RELEASED $${(total / 100).toFixed(2)} for ${email}`);
        totalApproved += total;

        // Send appropriate email
        try {
          const isFirstRelease = !first_release_sent_at;

          if (isFirstRelease) {
            // Day 91 Lump Sum Celebration
            const emailContent = getDay91CelebrationEmail(total, integrity.heartbeatsCompleted);
            await sendEmail(email, emailContent.subject, emailContent.html);

            await client.query(
              `UPDATE affiliates
               SET first_release_sent_at = NOW(),
                   first_release_amount_cents = $1,
                   updated_at = NOW()
               WHERE id = $2`,
              [total, affiliateId]
            );
            console.log(`[Vesting] Sent Day 91 celebration email to ${email}`);
          } else {
            // Standard rolling release email
            const emailContent = getCommissionApprovedEmail(total);
            await sendEmail(email, emailContent.subject, emailContent.html);
          }
        } catch (emailErr) {
          console.error(`Failed to send vesting release email to ${email}:`, emailErr.message);
        }
      }

      await client.query('COMMIT');
      console.log(
        `[Vesting] Cycle complete. Released: $${(totalApproved / 100).toFixed(2)} | ` +
        `Held (integrity check): $${(totalHeld / 100).toFixed(2)}`
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('approveCommissions error:', err.message);
  }
}

// ─── Job 2: Monitor grace periods and send dunning emails ──
async function monitorGracePeriods(pool) {
  console.log('Running: Monitor grace periods...');

  try {
    // Get all affiliates with an active grace period
    const affiliatesResult = await pool.query(
      `SELECT a.*, u.paid_until
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.status = 'at_risk' AND a.grace_period_ends_at IS NOT NULL`
    );

    for (const affiliate of affiliatesResult.rows) {
      const now = new Date();
      const gracePeriodEnds = new Date(affiliate.grace_period_ends_at);
      const daysElapsed = Math.floor(
        (now - new Date(affiliate.grace_period_started_at)) / (1000 * 60 * 60 * 24)
      );
      const daysRemaining = Math.ceil((gracePeriodEnds - now) / (1000 * 60 * 60 * 24));

      // ── 1. Payment resolved → clear grace period ───────
      const paidUntil = affiliate.paid_until ? new Date(affiliate.paid_until) : null;
      if (paidUntil && paidUntil > now) {
        await pool.query(
          `UPDATE affiliates
           SET status = 'active',
               grace_period_started_at = NULL,
               grace_period_ends_at = NULL,
               day_7_email_sent_at = NULL,
               day_14_email_sent_at = NULL,
               day_21_email_sent_at = NULL,
               updated_at = NOW()
           WHERE id = $1`,
          [affiliate.id]
        );
        console.log(`Grace period cleared for ${affiliate.email} (payment resolved)`);
        continue;
      }

      // ── 2. Day 21+ → Forfeit & revoke ──────────────────
      if (daysRemaining <= 0) {
        await forfeitAndRevoke(affiliate, pool);
        continue;
      }

      // ── 3. Day 7 email (send once, when ≥7 days elapsed) ───
      // Send as soon as Day 7 threshold is crossed (14 days remaining)
      if (daysElapsed >= DAY_7 && !affiliate.day_7_email_sent_at) {
        console.log(`Sending Day 7 warning to ${affiliate.email}`);
        try {
          const emailContent = getDay7WarningEmail(
            affiliate.grace_period_started_at,
            gracePeriodEnds
          );
          await sendEmail(affiliate.email, emailContent.subject, emailContent.html);
          await pool.query(
            'UPDATE affiliates SET day_7_email_sent_at = NOW(), updated_at = NOW() WHERE id = $1',
            [affiliate.id]
          );
        } catch (err) {
          console.error(`Failed to send Day 7 email to ${affiliate.email}:`, err.message);
        }
      }

      // ── 4. Day 14 email (send once, when ≥14 days elapsed) ─
      // Include pending balance so affiliate knows what's at stake
      if (daysElapsed >= DAY_14 && !affiliate.day_14_email_sent_at) {
        console.log(`Sending Day 14 warning to ${affiliate.email}`);
        try {
          const pendingCents = parseInt(affiliate.pending_balance_cents) || 0;
          const emailContent = getDay14WarningEmail(pendingCents, gracePeriodEnds);
          await sendEmail(affiliate.email, emailContent.subject, emailContent.html);
          await pool.query(
            'UPDATE affiliates SET day_14_email_sent_at = NOW(), updated_at = NOW() WHERE id = $1',
            [affiliate.id]
          );
        } catch (err) {
          console.error(`Failed to send Day 14 email to ${affiliate.email}:`, err.message);
        }
      }
    }

    console.log('Grace period monitoring complete.');
  } catch (err) {
    console.error('monitorGracePeriods error:', err.message);
  }
}

// ─── Job 3: Detect new payment failures ───────────────────
//
// Finds active affiliates whose Pro subscription has lapsed and
// starts the 21-day grace period countdown.
async function checkPaymentFailures(pool) {
  console.log('Running: Check for payment failures...');

  try {
    // Find active affiliates whose subscription has expired
    const affiliatesResult = await pool.query(
      `SELECT a.*, u.paid_until
       FROM affiliates a
       JOIN users u ON u.id = a.user_id
       WHERE a.status = 'active' AND (u.paid_until IS NULL OR u.paid_until < NOW())`
    );

    for (const affiliate of affiliatesResult.rows) {
      const gracePeriodEnds = new Date();
      gracePeriodEnds.setDate(gracePeriodEnds.getDate() + GRACE_PERIOD_DAYS);

      // Payment lapsed → grace period starts AND good standing clock resets.
      // If they resolve payment, the 30-day clock must restart from scratch.
      await pool.query(
        `UPDATE affiliates
         SET status = 'at_risk',
             grace_period_started_at = NOW(),
             grace_period_ends_at = $1,
             good_standing_started_at = NULL,
             good_standing_achieved_at = NULL,
             updated_at = NOW()
         WHERE id = $2`,
        [gracePeriodEnds, affiliate.id]
      );

      console.log(`Grace period started for ${affiliate.email} (ends: ${gracePeriodEnds.toISOString()})`);
    }

    console.log(`Payment failure check complete. ${affiliatesResult.rowCount} affiliate(s) entered grace period.`);
  } catch (err) {
    console.error('checkPaymentFailures error:', err.message);
  }
}

// ─── Helper: Forfeit, revoke, and compress downline ────────
//
// Called when Day 21 expires without payment resolution.
// Actions:
//   1. Forfeit all pending commissions
//   2. Set status = 'revoked', pending_balance = 0
//   3. Compress downline: reassign direct children to the revoked affiliate's parent
//   4. Send final notice email with forfeited amount
async function forfeitAndRevoke(affiliate, pool) {
  console.log(`[GracePeriod] Forfeiting commissions and revoking affiliate ${affiliate.email}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Calculate forfeited amount before zeroing
    const pendingResult = await client.query(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total_forfeited
       FROM commissions
       WHERE affiliate_id = $1 AND status = 'pending'`,
      [affiliate.id]
    );
    const forfeitedCents = parseInt(pendingResult.rows[0].total_forfeited) || 0;

    // 2. Forfeit all pending commissions
    await client.query(
      `UPDATE commissions
       SET status = 'forfeited', forfeited_at = NOW(), updated_at = NOW()
       WHERE affiliate_id = $1 AND status = 'pending'`,
      [affiliate.id]
    );

    // 3. Revoke affiliate — reset good standing clock and zero pending balance
    await client.query(
      `UPDATE affiliates
       SET status = 'revoked',
           pending_balance_cents = 0,
           good_standing_started_at = NULL,
           good_standing_achieved_at = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [affiliate.id]
    );

    // 4. Downline compression
    // Reassign all direct children to the revoked affiliate's parent (upline).
    // If the revoked affiliate has no parent (Level 1 / Master Node), children
    // become Level 1 affiliates with parent_affiliate_id = NULL.
    const parentId = affiliate.parent_affiliate_id || null;

    // Determine new level for children:
    //   - If parent exists: children move to parent.level + 1
    //   - If no parent: children become Level 1
    let newChildLevel = 1;
    if (parentId) {
      const parentResult = await client.query(
        'SELECT affiliate_level FROM affiliates WHERE id = $1',
        [parentId]
      );
      if (parentResult.rows.length > 0) {
        newChildLevel = (parseInt(parentResult.rows[0].affiliate_level) || 1) + 1;
        newChildLevel = Math.min(newChildLevel, 5); // Cap at level 5
      }
    }

    // Reassign direct children
    const compressionResult = await client.query(
      `UPDATE affiliates
       SET parent_affiliate_id = $1,
           affiliate_level = $2,
           updated_at = NOW()
       WHERE parent_affiliate_id = $3
       RETURNING id, email`,
      [parentId, newChildLevel, affiliate.id]
    );

    if (compressionResult.rowCount > 0) {
      console.log(
        `[Compression] Reassigned ${compressionResult.rowCount} direct report(s) from ` +
        `${affiliate.email} → ${parentId ? `affiliate #${parentId} (level ${newChildLevel})` : 'Master Node (level 1)'}`
      );
      for (const child of compressionResult.rows) {
        console.log(`  └─ ${child.email} (id: ${child.id}) now at level ${newChildLevel}`);
      }
    } else {
      console.log(`[Compression] ${affiliate.email} had no direct reports to reassign.`);
    }

    // 5. Send final notice email
    try {
      const emailContent = getDay21FinalNoticeEmail(forfeitedCents);
      await sendEmail(affiliate.email, emailContent.subject, emailContent.html);
      await client.query(
        'UPDATE affiliates SET day_21_email_sent_at = NOW() WHERE id = $1',
        [affiliate.id]
      );
    } catch (err) {
      console.error(`Failed to send Day 21 email to ${affiliate.email}:`, err.message);
    }

    await client.query('COMMIT');
    console.log(
      `[GracePeriod] ${affiliate.email} revoked. ` +
      `Forfeited: $${(forfeitedCents / 100).toFixed(2)}. ` +
      `Downline compressed: ${compressionResult.rowCount} node(s) moved.`
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── 4x5 PHASE DEPTH GATE CHECKER ─────────────────────────
//
// Checks if all 4 legs in each affiliate's current phase have an active member
// at 5 hops below them. Updates phase_N_depth_gate_met accordingly.
// Advances current_phase when gate is met AND personals >= phase * 3.
// RE-LOCKS phases if a previously-met leg drops below 5 deep.
//
async function checkAndUpdateDepthGates(pool) {
  console.log('Running: Check and update 4x5 phase depth gates...');

  // Helper: check if a leg's subtree has an active member at targetDepth hops
  async function checkLegDepth(legId, targetDepth) {
    const result = await pool.query(`
      WITH RECURSIVE leg_tree AS (
        SELECT id, parent_affiliate_id, status, is_ghost_slot, 1 AS depth
        FROM affiliates
        WHERE id = $1

        UNION ALL

        SELECT a.id, a.parent_affiliate_id, a.status, a.is_ghost_slot, lt.depth + 1
        FROM affiliates a
        JOIN leg_tree lt ON a.parent_affiliate_id = lt.id
        WHERE lt.depth < $2
          AND a.status != 'revoked'
      )
      SELECT
        MAX(depth) AS max_depth,
        BOOL_OR(depth = $2 AND status != 'revoked' AND is_ghost_slot = false) AS reached_target
      FROM leg_tree
    `, [legId, targetDepth]);

    if (!result.rows.length) return { isDeepEnough: false, maxDepth: 0 };
    const row = result.rows[0];
    return {
      isDeepEnough: row.reached_target === true,
      maxDepth: parseInt(row.max_depth) || 0
    };
  }

  try {
    const affiliatesResult = await pool.query(`
      SELECT a.id, a.email, a.current_phase, a.personal_recruit_count,
             a.phase_1_depth_gate_met, a.phase_2_depth_gate_met,
             a.phase_3_depth_gate_met, a.phase_4_depth_gate_met, a.phase_5_depth_gate_met
      FROM affiliates a
      WHERE a.status = 'active'
        AND a.is_ghost_slot = false
      ORDER BY a.id ASC
    `);

    let phaseAdvances = 0;
    let gatesUpdated = 0;
    let relocks = 0;

    for (const aff of affiliatesResult.rows) {
      const phase = aff.current_phase || 1;

      // Get direct children ordered by leg_position
      const legsResult = await pool.query(`
        SELECT id, leg_position
        FROM affiliates
        WHERE parent_affiliate_id = $1
          AND status != 'revoked'
        ORDER BY COALESCE(leg_position, id) ASC
        LIMIT 20
      `, [aff.id]);

      const allLegs = legsResult.rows;
      const phaseStartIdx = (phase - 1) * 4;
      const phaseLegs = allLegs.slice(phaseStartIdx, phaseStartIdx + 4);

      const fieldName = `phase_${phase}_depth_gate_met`;
      const currentGateMet = aff[fieldName] === true;

      // Gate cannot be met without all 4 legs
      if (phaseLegs.length < 4) {
        if (currentGateMet) {
          await pool.query(
            `UPDATE affiliates SET ${fieldName} = false, updated_at = NOW() WHERE id = $1`,
            [aff.id]
          );
          relocks++;
          console.log(`[DepthGate] Phase ${phase} RE-LOCKED for ${aff.email} (only ${phaseLegs.length}/4 legs)`);
        }
        continue;
      }

      // Check all 4 legs for 5-deep active chain
      let allLegsDeep = true;
      for (const leg of phaseLegs) {
        const { isDeepEnough } = await checkLegDepth(leg.id, 5);
        if (!isDeepEnough) {
          allLegsDeep = false;
          break;
        }
      }

      // Update if changed
      if (allLegsDeep !== currentGateMet) {
        await pool.query(
          `UPDATE affiliates SET ${fieldName} = $1, updated_at = NOW() WHERE id = $2`,
          [allLegsDeep, aff.id]
        );
        gatesUpdated++;

        if (!allLegsDeep && currentGateMet) {
          relocks++;
          console.log(`[DepthGate] Phase ${phase} RE-LOCKED for ${aff.email} (leg dropped below 5 deep)`);
        } else if (allLegsDeep && !currentGateMet) {
          console.log(`[DepthGate] Phase ${phase} gate MET for ${aff.email} ✅`);
        }
      }

      // Phase advancement: gate met + personals >= phase * 3
      const personalsRequired = phase * 3;
      const personalsActual = aff.personal_recruit_count || 0;

      if (allLegsDeep && personalsActual >= personalsRequired && phase < 5) {
        const advResult = await pool.query(
          `UPDATE affiliates SET current_phase = current_phase + 1, updated_at = NOW()
           WHERE id = $1 AND current_phase = $2 RETURNING current_phase`,
          [aff.id, phase]
        );
        if (advResult.rowCount > 0) {
          phaseAdvances++;
          console.log(`[DepthGate] 🎉 ${aff.email} → Phase ${phase + 1}! (${personalsActual} personals)`);
        }
      }
    }

    console.log(
      `[DepthGate] Done. Checked: ${affiliatesResult.rows.length}, ` +
      `Updates: ${gatesUpdated}, Advances: ${phaseAdvances}, Re-locks: ${relocks}`
    );
  } catch (err) {
    console.error('checkAndUpdateDepthGates error:', err.message);
  }
}

// ─── Succession Probation Monitoring ──────────────────────
//
// Checks 30/60/90-day compliance deadlines for post-transfer successors:
//   - Day 30: Must be a Pro subscriber (commissions held if missed)
//   - Day 60: Must complete FACTS Certification
//   - Day 90: Node deactivated + downline compressed to master if still non-compliant
async function checkSuccessionProbation(pool) {
  console.log('Running: Check succession probation compliance...');

  try {
    const { rows: cases } = await pool.query(`
      SELECT st.id,
             st.probation_status,
             st.probation_pro_deadline,
             st.probation_cert_deadline,
             st.probation_deactivation_deadline,
             st.new_affiliate_user_id,
             st.affiliate_id,
             u.plan AS successor_plan,
             u.email AS successor_email,
             u.is_facts_certified AS successor_certified
        FROM succession_transfers st
        JOIN users u ON u.id = st.new_affiliate_user_id
       WHERE st.status = 'executed'
         AND st.probation_status NOT IN ('compliant', 'deactivated')
    `);

    const now = new Date();
    let updated = 0;

    for (const c of cases) {
      const proMet = c.successor_plan === 'paid';
      const certMet = !!c.successor_certified;
      const proDeadlinePassed  = now > new Date(c.probation_pro_deadline);
      const certDeadlinePassed = now > new Date(c.probation_cert_deadline);
      const deactDeadlinePassed = now > new Date(c.probation_deactivation_deadline);

      let newStatus = c.probation_status;

      if (proMet && certMet) {
        // Fully compliant — unlock affiliate
        newStatus = 'compliant';
        await pool.query(
          `UPDATE affiliates SET status = 'active', updated_at = NOW()
            WHERE id = $1 AND status = 'on_hold'`,
          [c.affiliate_id]
        );
        console.log(`[Succession] Transfer #${c.id}: ${c.successor_email} is compliant. Node active.`);
      } else if (deactDeadlinePassed) {
        // 90-day deadline passed — deactivate node and compress downline
        newStatus = 'deactivated';
        await pool.query(
          `UPDATE affiliates SET status = 'revoked', updated_at = NOW() WHERE id = $1`,
          [c.affiliate_id]
        );
        // Compress downline to master (parent = NULL)
        await pool.query(
          `UPDATE affiliates SET parent_affiliate_id = NULL, updated_at = NOW()
            WHERE parent_affiliate_id = $1`,
          [c.affiliate_id]
        );
        console.log(`[Succession] Transfer #${c.id}: ${c.successor_email} deactivated at 90-day deadline. Downline compressed.`);
        try {
          await sendEmail(
            c.successor_email,
            'Your Future Generations Position Has Been Deactivated',
            `<p>Your inherited Future Generations affiliate position has been deactivated because compliance requirements were not met within 90 days.</p>
             <ul>
               ${!proMet ? '<li>Paid subscriber requirement (due day 30): <strong>NOT MET</strong></li>' : ''}
               ${!certMet ? '<li>FACTS Certification requirement (due day 60): <strong>NOT MET</strong></li>' : ''}
             </ul>
             <p>Your organization has been reassigned to the Master Node. Contact support if you believe this is an error.</p>`
          );
        } catch (emailErr) {
          console.error(`Failed to send deactivation email to ${c.successor_email}:`, emailErr.message);
        }
      } else if (proDeadlinePassed && !proMet && newStatus !== 'on_hold') {
        // 30-day Pro deadline passed — hold commissions
        newStatus = 'on_hold';
        await pool.query(
          `UPDATE affiliates SET status = 'paused', updated_at = NOW()
            WHERE id = $1 AND status = 'active'`,
          [c.affiliate_id]
        );
        console.log(`[Succession] Transfer #${c.id}: ${c.successor_email} missed paid subscription deadline. Commissions held.`);
        try {
          await sendEmail(
            c.successor_email,
            'Action Required: Upgrade Now to Maintain Your Future Generations Position',
            `<p>Your inherited Future Generations affiliate position requires an active paid subscription.</p>
             <p>Your 30-day grace period has expired. <strong>Your commissions are now on hold.</strong></p>
             <p>You still have until <strong>${new Date(c.probation_cert_deadline).toLocaleDateString()}</strong> to complete FACTS Certification and until <strong>${new Date(c.probation_deactivation_deadline).toLocaleDateString()}</strong> before your node is permanently deactivated.</p>
             <p><a href="${APP_URL}/settings">Upgrade Now →</a></p>`
          );
        } catch (emailErr) {
          console.error(`Failed to send Pro-deadline email to ${c.successor_email}:`, emailErr.message);
        }
      } else if (proMet && newStatus === 'pending') {
        newStatus = 'pro_met';
      } else if (certMet && newStatus === 'pro_met') {
        newStatus = 'cert_met';
      }

      if (newStatus !== c.probation_status) {
        await pool.query(
          `UPDATE succession_transfers SET probation_status = $1, updated_at = NOW() WHERE id = $2`,
          [newStatus, c.id]
        );
        updated++;
      }
    }

    console.log(`Succession probation check complete. ${cases.length} case(s) checked, ${updated} updated.`);
  } catch (err) {
    console.error('checkSuccessionProbation error:', err.message);
  }
}

// ── MASTER VALVE: Weekly Recalculation ────────────────────────────────────────
//
// Recomputes the Master Valve cycle length based on the current number of active
// direct legs from the Company Master Node.  Runs at most once per 6 days (weekly).
//
// Startup  (1-20  legs): cycle=5  — company keeps 1 of every 5 orphans
// Growth   (21-50 legs): cycle=3  — company keeps 1 of every 3 orphans
// Sovereign (51+  legs): cycle=50 — company keeps 1 of every 50 orphans
async function recalculateMasterValve(pool) {
  console.log('Running: Master Valve recalculation...');
  try {
    // Check if recalc is needed (weekly cadence — skip if run within 6 days)
    const configResult = await pool.query(
      'SELECT last_valve_recalc_at FROM orphan_placement_config WHERE id = 1'
    );
    if (configResult.rows.length > 0 && configResult.rows[0].last_valve_recalc_at) {
      const daysSinceLast = (Date.now() - new Date(configResult.rows[0].last_valve_recalc_at)) / (1000 * 60 * 60 * 24);
      if (daysSinceLast < 6) {
        console.log(`[MasterValve] Skipping — recalculated ${daysSinceLast.toFixed(1)} days ago (weekly cadence)`);
        return;
      }
    }

    // Count active direct legs from the master node
    const legResult = await pool.query(`
      SELECT COUNT(*) AS leg_count
      FROM affiliates a
      JOIN affiliates master ON master.is_master_node = true
      WHERE a.parent_affiliate_id = master.id
        AND a.status = 'active'
        AND a.is_ghost_slot = false
    `);
    const legCount = parseInt(legResult.rows[0]?.leg_count || 0);

    // Look up the matching valve tier
    const ratioResult = await pool.query(`
      SELECT label, company_keep_ratio, field_ratio
      FROM master_valve_ratio
      WHERE leg_count_min <= $1
        AND (leg_count_max IS NULL OR leg_count_max >= $1)
      ORDER BY leg_count_min DESC
      LIMIT 1
    `, [legCount]);

    let tier = 'startup';
    let cycleLength = 5; // Default: startup (4 field + 1 corp per cycle)

    if (ratioResult.rows.length > 0) {
      const row = ratioResult.rows[0];
      tier = row.label;
      cycleLength = row.company_keep_ratio + row.field_ratio;
    }

    await pool.query(`
      UPDATE orphan_placement_config
      SET current_cycle_length  = $1,
          current_valve_tier    = $2,
          last_valve_recalc_at  = NOW(),
          updated_at            = NOW()
      WHERE id = 1
    `, [cycleLength, tier]);

    console.log(`[MasterValve] Updated → Tier: ${tier} | Legs: ${legCount} | Cycle: ${cycleLength} (1 corp per ${cycleLength})`);
  } catch (err) {
    console.error('recalculateMasterValve error:', err.message);
  }
}

// ── MERIT GATE: Silent 14-Day Slot 1 Auto-Fill ─────────────────────────────────
//
// ⛔ DISABLED — The 3:1 Merit Gate no longer includes an auto-fill safety net.
// All company gift slots (1, 5, 9) are awarded strictly through merit-based queue
// placement. There is no timed fallback or safety-net auto-fill for any slot.
//
// This function is preserved for historical reference but is NOT called by
// runAffiliateJobs(). Do not re-enable without explicit compliance review.
//
// Original behavior (retired):
//   Backend-only safety net. If an eligible affiliate had been waiting for their
//   Slot 1 company gift for 14+ days without a natural placement, silently assign
//   one orphan subscriber from the pool.
//   INTERNAL ONLY — no notifications, no user-facing messaging, no public docs.
//   Only fired for Slot 1 (company_gifts_received = 0).
async function runSilentAutoFill(pool) {
  console.log('Running: Silent Slot 1 auto-fill check (14-day safety net)...');
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 14);

    // Find affiliates whose Slot 1 gift hasn't arrived in 14+ days
    const eligibleAffiliates = await pool.query(`
      SELECT a.id, a.user_id, a.affiliate_level, a.email
      FROM affiliates a
      WHERE a.status = 'active'
        AND a.is_ghost_slot = false
        AND a.orphan_placement_eligible = true
        AND a.company_gifts_received = 0
        AND a.next_orphan_slot = 1
        AND a.slot1_gift_waiting_since IS NOT NULL
        AND a.slot1_gift_waiting_since <= $1
      ORDER BY a.slot1_gift_waiting_since ASC
    `, [cutoffDate]);

    if (eligibleAffiliates.rows.length === 0) {
      console.log('[AutoFill] No affiliates need auto-fill today.');
      return;
    }

    console.log(`[AutoFill] ${eligibleAffiliates.rows.length} affiliate(s) eligible for Slot 1 auto-fill`);

    for (const aff of eligibleAffiliates.rows) {
      // Find the oldest orphan in the pool (ready_to_place first, then waiting_upgrade)
      const orphanResult = await pool.query(`
        SELECT user_id
        FROM orphan_pool
        WHERE status IN ('ready_to_place', 'waiting_upgrade')
        ORDER BY
          CASE status WHEN 'ready_to_place' THEN 0 ELSE 1 END,
          created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);

      if (orphanResult.rows.length === 0) {
        console.log('[AutoFill] Orphan pool is empty — stopping auto-fill run.');
        break;
      }

      const orphanUserId = orphanResult.rows[0].user_id;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Get orphan user's email
        const orphanUser = await client.query(
          'SELECT email FROM users WHERE id = $1', [orphanUserId]
        );
        if (orphanUser.rows.length === 0) {
          await client.query('ROLLBACK');
          continue;
        }

        const orphanEmail = orphanUser.rows[0].email;

        // Check orphan isn't already in affiliates
        const existingAff = await client.query(
          'SELECT id FROM affiliates WHERE user_id = $1', [orphanUserId]
        );
        if (existingAff.rows.length === 0) {
          const orphanLevel = (aff.affiliate_level || 1) + 1;
          const orphanNextPos = await getNextLegPositionFromPool(aff.id, client);
          await client.query(
            `INSERT INTO affiliates
               (user_id, email, referral_code, status, parent_affiliate_id, affiliate_level,
                placement_method, is_ghost_slot, leg_position, good_standing_started_at, created_at)
             VALUES ($1, $2, NULL, 'active', $3, $4, 'orphan', false, $5, NOW(), NOW())`,
            [orphanUserId, orphanEmail, aff.id, orphanLevel, orphanNextPos]
          );
          await client.query(
            `UPDATE users SET referred_by_user_id = $1 WHERE id = $2 AND referred_by_user_id IS NULL`,
            [aff.user_id, orphanUserId]
          );
        }

        // Mark orphan placed (mark as placed regardless of whether they already had an affiliate record)
        await client.query(
          `UPDATE orphan_pool
           SET status = 'placed', placement_affiliate_id = $1, placement_slot = 1, placed_at = NOW()
           WHERE user_id = $2`,
          [aff.id, orphanUserId]
        );

        // Advance affiliate's orphan slot: Slot 1 → Slot 5 (next company gift)
        await client.query(
          `UPDATE affiliates
           SET orphans_received       = orphans_received + 1,
               company_gifts_received = company_gifts_received + 1,
               next_orphan_slot       = 5,
               orphan_waiting_since   = NOW(),
               slot1_gift_waiting_since = NULL,
               updated_at             = NOW()
           WHERE id = $1`,
          [aff.id]
        );

        // Audit log — flagged as auto_fill and merit_gate_passed = false (bypassed natural queue)
        await client.query(
          `INSERT INTO assignment_log
             (orphan_user_id, assigned_affiliate_id, slot_number, destination,
              valve_tier, active_legs_at_time, is_auto_fill, merit_gate_passed)
           VALUES ($1, $2, 1, 'auto_fill', NULL, NULL, true, false)`,
          [orphanUserId, aff.id]
        );

        await client.query('COMMIT');
        console.log(`[AutoFill] Slot 1 filled for affiliate ${aff.email} (id: ${aff.id}) ← orphan user ${orphanUserId}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[AutoFill] Error filling slot for affiliate ${aff.id}:`, err.message);
      } finally {
        client.release();
      }
    }

    console.log('[AutoFill] Silent Slot 1 auto-fill run complete.');
  } catch (err) {
    console.error('runSilentAutoFill error:', err.message);
  }
}

// Helper: get next leg position from within an existing transaction client
async function getNextLegPositionFromPool(affiliateId, client) {
  const result = await client.query(
    `SELECT COALESCE(MAX(leg_position), 0) + 1 AS next_pos FROM affiliates WHERE parent_affiliate_id = $1`,
    [affiliateId]
  );
  return result.rows[0]?.next_pos || 1;
}

// ─── Main orchestrator ─────────────────────────────────────
async function runAffiliateJobs(pool) {
  console.log('=== Starting Affiliate Jobs ===');
  console.log(`Time: ${new Date().toISOString()}`);

  await trackGoodStanding(pool);          // Advance or unlock good standing clock for Pro affiliates
  await checkInactivityRequirement(pool); // Pause/reactivate affiliates based on 60-day login activity
  await checkPaymentFailures(pool);        // Start grace period for expired Pro subs
  await monitorGracePeriods(pool);         // Send dunning emails; forfeit + compress on Day 21
  await approveCommissions(pool);          // Approve Net-30 commissions (good-standing-gated)
  await checkSuccessionProbation(pool);    // Monitor 30/60/90-day compliance for succession successors
  await checkAndUpdateDepthGates(pool);   // 4x5: check leg depth gates, advance phases, re-lock if needed
  await recalculateMasterValve(pool);     // Weekly: update orphan distribution ratio based on active legs
  // runSilentAutoFill DISABLED — 3:1 Merit Gate does not include auto-fill.
  // Slot 1 (and all company gift slots) are awarded only through merit-based queue placement.
  // Any orphan that waits indefinitely stays in the queue until a naturally eligible affiliate claims it.

  console.log('=== Affiliate Jobs Complete ===\n');
}

// ─── Standalone script entry point ────────────────────────
// When run directly (node jobs/affiliate-jobs.js), use own pool and exit when done.
if (require.main === module) {
  const standalonePool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  runAffiliateJobs(standalonePool)
    .catch(err => {
      console.error('Job execution failed:', err);
      process.exit(1);
    })
    .finally(() => standalonePool.end());
}

// Note: runSilentAutoFill is exported for reference only — it is NOT called by runAffiliateJobs.
// The 3:1 Merit Gate does not include auto-fill. Slot assignments are merit-based queue placements only.
module.exports = { runAffiliateJobs, checkAndUpdateDepthGates, recalculateMasterValve };
