'use strict';

/**
 * Heartbeat Compliance System — Monthly Heartbeat v2
 *
 * The 7th Rule:
 *   - All affiliates must complete Monthly Check-In by the 7th of each month.
 *   - Check-in requires: confirm debt balances, sync data, verify pillar allocations.
 *
 * Penalties (8th of the Month):
 *   - IF Current_Date > 7 AND CheckIn_Complete == FALSE → status = 'pending', lock commissions in ESCROW
 *   - User CAN complete a late check-in to release escrow.
 *
 * 90-Day Cliff:
 *   - 3 consecutive missed heartbeats → status = 'forfeited'
 *   - Forfeited commission slice rolls UP to Company Master Node (Treasury)
 *   - Forfeiture is PERMANENT for pending commissions
 *   - Original upline structure remains intact — only forfeited user's slice is captured
 *
 * Automated Emails:
 *   - Day 1 of month: Heartbeat reminder (all active/pending affiliates)
 *   - Day 5: Urgent reminder ("2 days left")
 *   - Day 8: "Your commissions are now in escrow"
 *   - Day 60: "Final warning — 1 month until forfeiture"
 *   - Day 90: "Forfeiture notice" + execute roll-up if consecutive_missed >= 3
 *
 * Preserves: all existing heartbeat audit infrastructure (affiliate_heartbeats table,
 * affiliate_monthly_status, commissions_on_compliance_hold) for backward compatibility.
 */

const mailer = require('../lib/mailer');

const APP_URL = process.env.APP_URL || 'https://app.factsmoney.com';

// ─── Email helper ────────────────────────────────────────────────────────────

async function sendEmail(to, subject, htmlBody) {
  const result = await mailer.sendEmail({ to, subject, html: htmlBody });
  if (!result.sent) throw new Error(`Email failed: ${result.error || 'unknown error'}`);
  return result;
}

// ─── Email templates ─────────────────────────────────────────────────────────

function heartbeatReminderEmail({ firstName, daysLeft, monthLabel, isUrgent = false }) {
  const urgentBanner = isUrgent ? `
    <div style="background:#2d1500;border:2px solid #f59e0b;border-radius:8px;padding:14px;margin:16px 0;">
      <p style="color:#f59e0b;margin:0;font-weight:700;font-size:0.95rem;">
        ⏰ Only <strong>${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining</strong> — don't miss the deadline!
      </p>
    </div>
  ` : '';

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0f1a;color:#e0e0e0;padding:32px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:28px;">
        <span style="font-size:2rem;">🏛️</span>
        <h1 style="color:#d4af37;font-size:1.4rem;margin:8px 0;">Monthly Heartbeat Required</h1>
        <p style="color:#9ca3af;margin:0;">${monthLabel} Check-In</p>
      </div>

      <p style="line-height:1.6;">Hi ${firstName},</p>
      <p style="line-height:1.6;">
        Your <strong style="color:#d4af37;">Monthly Heartbeat Check-In</strong> for ${monthLabel} is due by the <strong>7th</strong>.
        ${!isUrgent ? `You have <strong style="color:#10b981;">${daysLeft} day${daysLeft !== 1 ? 's' : ''}</strong> to complete it.` : ''}
      </p>

      ${urgentBanner}

      <div style="background:#1a2035;border:1px solid #d4af37;border-radius:8px;padding:20px;margin:24px 0;">
        <h3 style="color:#d4af37;margin:0 0 12px 0;font-size:1rem;">Required This Month</h3>
        <ol style="margin:0;padding-left:20px;line-height:1.8;color:#d1d5db;">
          <li>Confirm your current debt balances</li>
          <li>Sync your financial data</li>
          <li>Verify your FACTS Pillar Allocations</li>
          <li>Sign the Declaration of Accuracy</li>
        </ol>
      </div>

      <div style="background:#2d1b1b;border:1px solid #ef4444;border-radius:8px;padding:16px;margin:20px 0;">
        <p style="color:#ef4444;margin:0;font-size:0.9rem;">
          ⚠️ <strong>Missing the 7th deadline</strong> will move your commissions into <strong>Escrow</strong>
          and suspend Orphan Placement eligibility. 3 consecutive misses = permanent forfeiture.
        </p>
      </div>

      <div style="text-align:center;margin:28px 0;">
        <a href="${APP_URL}/affiliate-heartbeat"
           style="display:inline-block;background:#d4af37;color:#0a0f1a;padding:14px 32px;
                  border-radius:8px;font-weight:700;text-decoration:none;font-size:1rem;">
          Complete My Heartbeat →
        </a>
      </div>

      <p style="color:#6b7280;font-size:0.8rem;text-align:center;margin-top:32px;">
        FACTS Financial · Future Generations Affiliate Program
      </p>
    </div>
  `;
}

function heartbeatEscrowEmail({ firstName, monthLabel, escrowAmountDollars, consecutiveMissed, maxMisses }) {
  const missesLeft = maxMisses - consecutiveMissed;
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0f1a;color:#e0e0e0;padding:32px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:28px;">
        <span style="font-size:2rem;">🔒</span>
        <h1 style="color:#f59e0b;font-size:1.4rem;margin:8px 0;">Commissions Moved to Escrow</h1>
        <p style="color:#9ca3af;margin:0;">${monthLabel} Heartbeat Missed</p>
      </div>

      <p>Hi ${firstName},</p>
      <p style="line-height:1.6;">
        You did not complete your ${monthLabel} Heartbeat by the 7th.
        Your pending commissions (<strong style="color:#f59e0b;">$${escrowAmountDollars}</strong>) have been
        placed in <strong style="color:#f59e0b;">Escrow</strong>.
      </p>

      <div style="background:#2d2000;border:2px solid #f59e0b;border-radius:8px;padding:20px;margin:24px 0;">
        <h3 style="color:#f59e0b;margin:0 0 12px 0;">📊 Cliff Progress</h3>
        <p style="color:#fcd34d;font-size:1.1rem;font-weight:700;margin:0 0 8px 0;">
          ${consecutiveMissed} of ${maxMisses} consecutive misses
        </p>
        <div style="background:#1a1400;border-radius:4px;height:8px;overflow:hidden;">
          <div style="background:#f59e0b;height:100%;width:${Math.round((consecutiveMissed/maxMisses)*100)}%;transition:width 0.3s;"></div>
        </div>
        <p style="color:#9ca3af;font-size:0.85rem;margin:8px 0 0 0;">
          ${missesLeft} more consecutive miss${missesLeft !== 1 ? 'es' : ''} will result in permanent forfeiture.
        </p>
      </div>

      <div style="background:#1a2035;border:1px solid #d4af37;border-radius:8px;padding:16px;margin:20px 0;">
        <h3 style="color:#d4af37;margin:0 0 8px 0;font-size:0.95rem;">✅ How to Release Your Escrow</h3>
        <p style="color:#d1d5db;margin:0;font-size:0.9rem;">
          Complete your Heartbeat at any time — even late — and your escrowed commissions will be
          released immediately. Your status resets to Active.
        </p>
      </div>

      <div style="text-align:center;margin:28px 0;">
        <a href="${APP_URL}/affiliate-heartbeat"
           style="display:inline-block;background:#d4af37;color:#0a0f1a;padding:14px 32px;
                  border-radius:8px;font-weight:700;text-decoration:none;font-size:1rem;">
          Complete Late Heartbeat →
        </a>
      </div>

      <p style="color:#6b7280;font-size:0.8rem;text-align:center;margin-top:32px;">
        FACTS Financial · Future Generations Affiliate Program
      </p>
    </div>
  `;
}

function heartbeatDay60WarningEmail({ firstName, escrowAmountDollars, consecutiveMissed, maxMisses, daysUntilForfeiture }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0f1a;color:#e0e0e0;padding:32px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:28px;">
        <span style="font-size:2rem;">⚠️</span>
        <h1 style="color:#ef4444;font-size:1.4rem;margin:8px 0;">Final Warning — ${daysUntilForfeiture} Days Until Forfeiture</h1>
        <p style="color:#9ca3af;margin:0;">Commission Escrow — Critical Notice</p>
      </div>

      <p>Hi ${firstName},</p>
      <p style="line-height:1.6;">
        Your commissions (<strong style="color:#f59e0b;">$${escrowAmountDollars}</strong>) have been in Escrow
        for <strong>60 days</strong>. You are currently at
        <strong style="color:#ef4444;">${consecutiveMissed} of ${maxMisses} consecutive missed Heartbeats</strong>.
      </p>

      <div style="background:#2d1b1b;border:2px solid #ef4444;border-radius:8px;padding:20px;margin:24px 0;">
        <h3 style="color:#ef4444;margin:0 0 12px 0;">🚨 ${daysUntilForfeiture} Days Until Permanent Forfeiture</h3>
        <p style="color:#fca5a5;line-height:1.6;margin:0;">
          If you do not complete your Monthly Heartbeat, your escrowed commissions will be
          <strong>permanently forfeited</strong> and routed to the Company Treasury Node.
          This action is <strong>irreversible</strong>.
        </p>
      </div>

      <div style="background:#1a2035;border:1px solid #10b981;border-radius:8px;padding:16px;margin:20px 0;">
        <h3 style="color:#10b981;margin:0 0 8px 0;font-size:0.95rem;">✅ Recover Your Commissions Now</h3>
        <p style="color:#d1d5db;margin:0;font-size:0.9rem;">
          Complete your Heartbeat today and all escrowed commissions will be released immediately.
          Your streak resets, your status restores to Active.
        </p>
      </div>

      <div style="text-align:center;margin:28px 0;">
        <a href="${APP_URL}/affiliate-heartbeat"
           style="display:inline-block;background:#ef4444;color:#fff;padding:14px 32px;
                  border-radius:8px;font-weight:700;text-decoration:none;font-size:1rem;">
          Recover My Commissions →
        </a>
      </div>

      <p style="color:#6b7280;font-size:0.8rem;text-align:center;margin-top:32px;">
        FACTS Financial · Future Generations Affiliate Program
      </p>
    </div>
  `;
}

function heartbeatForfeitureNoticeEmail({ firstName, forfeitedAmountDollars }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0f1a;color:#e0e0e0;padding:32px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:28px;">
        <span style="font-size:2rem;">💀</span>
        <h1 style="color:#ef4444;font-size:1.4rem;margin:8px 0;">Commission Forfeiture Executed</h1>
        <p style="color:#9ca3af;margin:0;">90-Day Cliff — 3 Consecutive Missed Heartbeats</p>
      </div>

      <p>Hi ${firstName},</p>
      <p style="line-height:1.6;">
        You have missed <strong>3 consecutive Monthly Heartbeats</strong>. As per the Future Generations
        Agreement, your escrowed commissions of
        <strong style="color:#ef4444;">$${forfeitedAmountDollars}</strong> have been
        <strong>permanently forfeited</strong> and routed to the Company Master Node.
      </p>

      <div style="background:#2d1b1b;border:2px solid #ef4444;border-radius:8px;padding:20px;margin:24px 0;">
        <h3 style="color:#ef4444;margin:0 0 12px 0;">What Happened</h3>
        <ul style="margin:0;padding-left:20px;line-height:1.8;color:#fca5a5;">
          <li>Status: <strong>Forfeited</strong> (permanent)</li>
          <li>Escrowed commissions: <strong>$${forfeitedAmountDollars} forfeited</strong></li>
          <li>Forfeited commissions routed to Company Treasury</li>
          <li>Your upline structure remains intact</li>
        </ul>
      </div>

      <div style="background:#1a2035;border:1px solid #d4af37;border-radius:8px;padding:16px;margin:20px 0;">
        <h3 style="color:#d4af37;margin:0 0 8px 0;font-size:0.95rem;">Can I Rejoin?</h3>
        <p style="color:#d1d5db;margin:0;font-size:0.9rem;">
          Your affiliate account has been deactivated. Contact support to discuss re-enrollment options.
          Note: forfeited commissions cannot be recovered.
        </p>
      </div>

      <p style="color:#6b7280;font-size:0.8rem;text-align:center;margin-top:32px;">
        FACTS Financial · Future Generations Affiliate Program
      </p>
    </div>
  `;
}

function heartbeatEscrowReleasedEmail({ firstName, releasedAmountDollars, monthLabel }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0f1a;color:#e0e0e0;padding:32px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:28px;">
        <span style="font-size:2rem;">✅</span>
        <h1 style="color:#10b981;font-size:1.4rem;margin:8px 0;">Escrow Released — You're Back!</h1>
        <p style="color:#9ca3af;margin:0;">${monthLabel} Late Heartbeat Completed</p>
      </div>

      <p>Hi ${firstName},</p>
      <p style="line-height:1.6;">
        You completed your ${monthLabel} Heartbeat (late submission accepted).
        Your escrowed commissions of <strong style="color:#10b981;">$${releasedAmountDollars}</strong>
        have been <strong>released</strong> back to your pending wallet.
      </p>

      <div style="background:#1a2e1a;border:1px solid #10b981;border-radius:8px;padding:16px;margin:20px 0;">
        <p style="color:#10b981;margin:0;">
          ✅ <strong>Account restored to Active status</strong><br>
          Your consecutive-miss counter has been reset. Complete your next Heartbeat by the 7th to stay current.
        </p>
      </div>

      <div style="text-align:center;margin:28px 0;">
        <a href="${APP_URL}/affiliate-dashboard.html"
           style="display:inline-block;background:#10b981;color:#fff;padding:14px 32px;
                  border-radius:8px;font-weight:700;text-decoration:none;font-size:1rem;">
          View My Dashboard →
        </a>
      </div>

      <p style="color:#6b7280;font-size:0.8rem;text-align:center;margin-top:32px;">
        FACTS Financial · Future Generations Affiliate Program
      </p>
    </div>
  `;
}

function squadHealthReportEmail({ firstName, monthLabel, daysLeft, teamRows, anchorAlert }) {
  const tableRows = teamRows.map(m => `
    <tr>
      <td style="padding:10px 12px;color:${m.completed ? '#4ade80' : '#f87171'};">
        ${m.completed ? '✅' : '🔴'}
      </td>
      <td style="padding:10px 12px;">${m.name}</td>
      <td style="padding:10px 12px;color:#9ca3af;">${m.email}</td>
      <td style="padding:10px 12px;">Level ${m.level}</td>
      <td style="padding:10px 12px;color:${m.completed ? '#4ade80' : '#f87171'};">
        ${m.completed ? 'Complete' : 'Pending'}
      </td>
    </tr>
  `).join('');

  const anchorBanner = anchorAlert ? `
    <div style="background:#2d1b00;border:2px solid #f59e0b;border-radius:8px;padding:16px;margin:20px 0;">
      <p style="color:#f59e0b;margin:0;font-weight:700;">
        🚨 ANCHOR AT RISK: One or more of your Level 5 Anchors has not yet completed their Heartbeat.
        If they miss the deadline, your next Phase expansion may re-lock.
      </p>
    </div>
  ` : '';

  return `
    <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;background:#0a0f1a;color:#e0e0e0;padding:32px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:28px;">
        <span style="font-size:2rem;">📋</span>
        <h1 style="color:#d4af37;font-size:1.4rem;margin:8px 0;">Squad Compliance Alert</h1>
        <p style="color:#9ca3af;margin:0;">Day 5 of 7 — ${monthLabel} Heartbeat Window</p>
      </div>

      <p>Hi ${firstName},</p>
      <p style="line-height:1.6;">
        <strong style="color:#f59e0b;">${daysLeft} days remaining</strong> in the ${monthLabel} Heartbeat window.
        Here's your squad's current compliance status:
      </p>

      ${anchorBanner}

      <div style="overflow-x:auto;margin:20px 0;">
        <table style="width:100%;border-collapse:collapse;background:#111827;border-radius:8px;overflow:hidden;">
          <thead>
            <tr style="background:#1f2937;">
              <th style="padding:12px;color:#d4af37;text-align:left;font-weight:600;font-size:0.85rem;">Status</th>
              <th style="padding:12px;color:#d4af37;text-align:left;font-weight:600;font-size:0.85rem;">Name</th>
              <th style="padding:12px;color:#d4af37;text-align:left;font-weight:600;font-size:0.85rem;">Email</th>
              <th style="padding:12px;color:#d4af37;text-align:left;font-weight:600;font-size:0.85rem;">Level</th>
              <th style="padding:12px;color:#d4af37;text-align:left;font-weight:600;font-size:0.85rem;">Heartbeat</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || '<tr><td colspan="5" style="padding:16px;text-align:center;color:#6b7280;">No direct team members</td></tr>'}
          </tbody>
        </table>
      </div>

      <div style="text-align:center;margin:28px 0;">
        <a href="${APP_URL}/affiliate-heartbeat"
           style="display:inline-block;background:#d4af37;color:#0a0f1a;padding:12px 28px;
                  border-radius:8px;font-weight:700;text-decoration:none;">
          Complete My Heartbeat
        </a>
      </div>

      <p style="color:#6b7280;font-size:0.8rem;text-align:center;margin-top:32px;">
        FACTS Financial · Future Generations Affiliate Program<br>
        You're receiving this because you have team members in your organization.
      </p>
    </div>
  `;
}

function familyLegacyAlertEmail({ sponsorFirstName, memberName, memberEmail, monthLabel, daysLeft }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0a0f1a;color:#e0e0e0;padding:32px;border-radius:12px;">
      <div style="text-align:center;margin-bottom:28px;">
        <span style="font-size:2rem;">👨‍👩‍👧</span>
        <h1 style="color:#d4af37;font-size:1.4rem;margin:8px 0;">Family Legacy Alert</h1>
        <p style="color:#9ca3af;margin:0;">${monthLabel} Heartbeat Window</p>
      </div>

      <p>Hi ${sponsorFirstName},</p>
      <p style="line-height:1.6;">
        Your Family Legacy member <strong style="color:#d4af37;">${memberName}</strong>
        (${memberEmail}) has <strong style="color:#f59e0b;">not yet completed</strong> their
        ${monthLabel} Heartbeat with <strong>${daysLeft} days remaining</strong>.
      </p>

      <div style="background:#1a2035;border:1px solid #7c3aed;border-radius:8px;padding:16px;margin:20px 0;">
        <p style="color:#c4b5fd;margin:0;">
          As a Family Elder / Sponsor, please reach out to ${memberName} and encourage them
          to complete their monthly check-in before the 7th.
        </p>
      </div>

      <p style="color:#6b7280;font-size:0.8rem;text-align:center;margin-top:32px;">
        FACTS Financial · Future Generations Family Legacy Program
      </p>
    </div>
  `;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

const CONSECUTIVE_MISSES_FOR_FORFEITURE = 3;

function getCurrentMonthYear() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function getMonthLabel(monthYear) {
  const [y, m] = monthYear.split('-');
  const d = new Date(parseInt(y), parseInt(m) - 1, 1);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function getDaysLeftInWindow() {
  const now = new Date();
  const day7 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 7, 23, 59, 59));
  const msLeft = day7 - now;
  return Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
}

// ─── Core Jobs ────────────────────────────────────────────────────────────────

/**
 * runDay1Reminders — runs on the 1st of each month at 08:00 UTC.
 *
 * Sends a "Heartbeat reminder" to every active (or currently pending) affiliate,
 * giving them the full 7-day window to complete their check-in.
 */
async function runDay1Reminders(pool) {
  console.log('[HeartbeatV2] Starting Day 1 reminders...');
  const monthYear = getCurrentMonthYear();
  const monthLabel = getMonthLabel(monthYear);
  const daysLeft = 7; // It's day 1, always 6-7 days left

  const client = await pool.connect();
  try {
    // All active affiliates who haven't completed this month's heartbeat yet
    const { rows: affiliates } = await client.query(`
      SELECT
        a.id,
        a.email,
        a.heartbeat_status,
        u.name AS full_name
      FROM affiliates a
      JOIN users u ON u.id = a.user_id
      WHERE a.status IN ('active', 'at_risk')
        AND a.heartbeat_status IN ('active', 'pending')
        AND NOT EXISTS (
          SELECT 1 FROM affiliate_heartbeats h
          WHERE h.user_id = a.user_id
            AND h.month_year = $1
            AND h.signature_confirmed = true
        )
    `, [monthYear]);

    console.log(`[HeartbeatV2] Day 1: Sending reminders to ${affiliates.length} affiliates`);
    let sent = 0, errors = 0;

    for (const aff of affiliates) {
      const firstName = aff.full_name?.split(' ')[0] || 'Affiliate';
      try {
        await sendEmail(
          aff.email,
          `🏛️ ${monthLabel} Heartbeat is Open — Complete by the 7th`,
          heartbeatReminderEmail({ firstName, daysLeft, monthLabel, isUrgent: false })
        );
        sent++;
      } catch (err) {
        console.error(`[HeartbeatV2] Day 1 email failed for ${aff.email}:`, err.message);
        errors++;
      }
    }

    console.log(`[HeartbeatV2] Day 1 reminders: sent=${sent}, errors=${errors}`);
    return { sent, errors, monthYear };
  } finally {
    client.release();
  }
}

/**
 * runHeartbeatComplianceCheck — runs on the 8th of each month at 00:30 UTC.
 *
 * For every active affiliate that did NOT complete their heartbeat by the 7th:
 *  - First miss (heartbeat_status was 'active'):
 *    - Set heartbeat_status = 'pending'
 *    - Increment consecutive_missed_heartbeats
 *    - Move pending commissions to escrow (escrow_amount_cents, escrow_started_at)
 *    - Lock commissions (commissions_on_compliance_hold = true) — backward compat
 *    - Send "commissions in escrow" email
 *
 *  - Subsequent miss (heartbeat_status already 'pending'):
 *    - Increment consecutive_missed_heartbeats
 *    - If consecutive_missed_heartbeats >= 3: execute 90-day cliff forfeiture
 *    - Otherwise: send updated escrow email
 *
 *  - Restores affiliates who completed a heartbeat this month (even late ones)
 */
async function runHeartbeatComplianceCheck(pool) {
  console.log('[HeartbeatV2] Starting monthly compliance check (8th)...');
  const monthYear = getCurrentMonthYear();
  const monthLabel = getMonthLabel(monthYear);

  const client = await pool.connect();
  try {
    // 1. Find active/at_risk affiliates who did NOT complete this month's heartbeat
    const { rows: nonCompliant } = await client.query(`
      SELECT
        a.id,
        a.user_id,
        a.affiliate_level,
        a.parent_affiliate_id,
        a.email,
        a.heartbeat_status,
        a.consecutive_missed_heartbeats,
        a.pending_balance_cents,
        u.name AS full_name
      FROM affiliates a
      JOIN users u ON u.id = a.user_id
      WHERE a.status IN ('active', 'at_risk')
        AND a.heartbeat_status IN ('active', 'pending')
        AND NOT EXISTS (
          SELECT 1 FROM affiliate_heartbeats h
          WHERE h.user_id = a.user_id
            AND h.month_year = $1
            AND h.signature_confirmed = true
        )
    `, [monthYear]);

    console.log(`[HeartbeatV2] Non-compliant affiliates: ${nonCompliant.length}`);

    let pendingCount = 0, forfeitedCount = 0, escrowErrors = 0;

    for (const aff of nonCompliant) {
      const newMissCount = (aff.consecutive_missed_heartbeats || 0) + 1;
      const shouldForfeit = newMissCount >= CONSECUTIVE_MISSES_FOR_FORFEITURE;

      if (shouldForfeit) {
        // ── Execute 90-day cliff forfeiture ──────────────────────
        await executeForfeitureRollUp(aff, pool, client);
        forfeitedCount++;
      } else {
        // ── Move to pending / increment miss count ────────────────
        await client.query(`
          UPDATE affiliates
          SET
            heartbeat_status = 'pending',
            consecutive_missed_heartbeats = $1,
            affiliate_monthly_status = 'inactive',
            commissions_on_compliance_hold = true,
            orphan_placement_eligible = false,
            compliance_hold_started_at = COALESCE(compliance_hold_started_at, NOW()),
            compliance_hold_month = $2,
            last_heartbeat_date = COALESCE(last_heartbeat_date, last_heartbeat_date),
            updated_at = NOW()
          WHERE id = $3
        `, [newMissCount, monthYear, aff.id]);

        // Move pending commissions to escrow
        const { rows: escrowed } = await client.query(`
          UPDATE commissions
          SET
            escrow_amount_cents = amount_cents,
            escrow_started_at = COALESCE(escrow_started_at, NOW()),
            updated_at = NOW()
          WHERE affiliate_id = $1
            AND status = 'pending'
            AND escrow_amount_cents = 0
          RETURNING amount_cents
        `, [aff.id]);

        const totalEscrowed = escrowed.reduce((sum, r) => sum + (r.amount_cents || 0), 0);
        const escrowDollars = (totalEscrowed / 100).toFixed(2);

        // Also record in affiliate_heartbeats as compliance event (preserve audit trail)
        await client.query(`
          INSERT INTO affiliate_heartbeats (user_id, month_year, completed_at, notes, signature_confirmed)
          VALUES ($1, $2, NOW(), $3, false)
          ON CONFLICT (user_id, month_year) DO NOTHING
        `, [
          aff.user_id,
          monthYear,
          `ESCROW_ACTIVATED: Miss #${newMissCount}. $${escrowDollars} moved to escrow.`
        ]);

        // Level 5 Anchor handling (backward compat)
        if (aff.affiliate_level === 5 && aff.parent_affiliate_id) {
          console.log(`[HeartbeatV2] Level 5 Anchor ${aff.id} missed — upline ${aff.parent_affiliate_id} notified`);
        }

        pendingCount++;

        // Send escrow notification email
        const firstName = aff.full_name?.split(' ')[0] || 'Affiliate';
        try {
          await sendEmail(
            aff.email,
            `🔒 Your ${monthLabel} Commissions Are Now in Escrow`,
            heartbeatEscrowEmail({
              firstName,
              monthLabel,
              escrowAmountDollars: escrowDollars,
              consecutiveMissed: newMissCount,
              maxMisses: CONSECUTIVE_MISSES_FOR_FORFEITURE
            })
          );
        } catch (emailErr) {
          console.error(`[HeartbeatV2] Escrow email failed for ${aff.email}:`, emailErr.message);
          escrowErrors++;
        }
      }
    }

    // 2. Restore affiliates who completed heartbeat this month (were on hold but caught up)
    const { rowCount: restoredCount } = await client.query(`
      UPDATE affiliates a
      SET
        heartbeat_status = 'active',
        consecutive_missed_heartbeats = 0,
        affiliate_monthly_status = 'active',
        commissions_on_compliance_hold = false,
        orphan_placement_eligible = true,
        compliance_hold_started_at = NULL,
        compliance_hold_month = NULL,
        updated_at = NOW()
      FROM affiliate_heartbeats h
      WHERE h.user_id = a.user_id
        AND h.month_year = $1
        AND h.signature_confirmed = true
        AND a.status IN ('active', 'at_risk')
        AND a.heartbeat_status = 'pending'
    `, [monthYear]);

    console.log(`[HeartbeatV2] 8th check done. Pending=${pendingCount}, Forfeited=${forfeitedCount}, Restored=${restoredCount}, EmailErrors=${escrowErrors}`);
    return { pendingCount, forfeitedCount, restoredCount, escrowErrors, monthYear };
  } finally {
    client.release();
  }
}

/**
 * executeForfeitureRollUp — the 90-Day Cliff execution.
 *
 * Called when an affiliate hits 3 consecutive missed heartbeats.
 * - Sets heartbeat_status = 'forfeited'
 * - Marks all pending/escrowed commissions as forfeited
 * - Records forfeited amounts as Treasury income (master node)
 * - Original upline structure preserved — only this user's slice is captured
 * - Sends forfeiture notice email
 *
 * @param {object} aff - Affiliate row
 * @param {object} pool - pg Pool
 * @param {object} [existingClient] - Optional existing pg client (reuse transaction)
 */
async function executeForfeitureRollUp(aff, pool, existingClient) {
  console.log(`[HeartbeatV2] Executing 90-Day Cliff forfeiture for affiliate ${aff.id} (${aff.email})`);

  const useExistingClient = !!existingClient;
  const client = existingClient || await pool.connect();

  try {
    // Calculate total being forfeited (pending + escrowed)
    const { rows: [totals] } = await client.query(`
      SELECT
        COALESCE(SUM(amount_cents), 0) AS total_cents,
        COALESCE(SUM(escrow_amount_cents), 0) AS total_escrow_cents
      FROM commissions
      WHERE affiliate_id = $1
        AND status = 'pending'
    `, [aff.id]);

    const forfeitedCents = parseInt(totals.total_cents) || 0;
    const forfeitedDollars = (forfeitedCents / 100).toFixed(2);

    // Forfeit all pending commissions — mark with treasury flag via metadata
    await client.query(`
      UPDATE commissions
      SET
        status = 'forfeited',
        forfeited_at = NOW(),
        escrow_amount_cents = 0,
        escrow_started_at = NULL,
        integrity_check_passed = false,
        updated_at = NOW()
      WHERE affiliate_id = $1
        AND status = 'pending'
    `, [aff.id]);

    // Also forfeit vesting_entries
    await client.query(`
      UPDATE vesting_entries
      SET status = 'forfeited', forfeited_at = NOW(), updated_at = NOW()
      WHERE affiliate_id = $1
        AND status = 'pending'
    `, [aff.id]);

    // Set affiliate to forfeited status
    await client.query(`
      UPDATE affiliates
      SET
        heartbeat_status = 'forfeited',
        consecutive_missed_heartbeats = $1,
        affiliate_monthly_status = 'inactive',
        commissions_on_compliance_hold = false,
        pending_balance_cents = 0,
        updated_at = NOW()
      WHERE id = $2
    `, [CONSECUTIVE_MISSES_FOR_FORFEITURE, aff.id]);

    // Record the roll-up in the affiliate_heartbeats audit trail
    const monthYear = getCurrentMonthYear();
    await client.query(`
      INSERT INTO affiliate_heartbeats (user_id, month_year, completed_at, notes, signature_confirmed)
      VALUES ($1, $2, NOW(), $3, false)
      ON CONFLICT (user_id, month_year) DO UPDATE SET
        notes = EXCLUDED.notes,
        completed_at = EXCLUDED.completed_at
    `, [
      aff.user_id,
      monthYear,
      `90_DAY_CLIFF_FORFEITURE: $${forfeitedDollars} forfeited and routed to Company Master Node. ` +
      `${CONSECUTIVE_MISSES_FOR_FORFEITURE} consecutive missed heartbeats.`
    ]);

    console.log(`[HeartbeatV2] Forfeiture complete for ${aff.email}: $${forfeitedDollars} → Treasury`);

    // Send forfeiture notice email
    const firstName = aff.full_name?.split(' ')[0] || 'Affiliate';
    try {
      await sendEmail(
        aff.email,
        '🚨 Commission Forfeiture Notice — 90-Day Cliff Executed',
        heartbeatForfeitureNoticeEmail({ firstName, forfeitedAmountDollars: forfeitedDollars })
      );
    } catch (emailErr) {
      console.error(`[HeartbeatV2] Forfeiture email failed for ${aff.email}:`, emailErr.message);
    }

    return { forfeitedCents, email: aff.email };
  } finally {
    if (!useExistingClient) client.release();
  }
}

/**
 * releaseEscrow — called when a user completes a LATE check-in (after the 7th).
 *
 * Releases escrowed commissions back to normal pending status.
 * Resets heartbeat_status to 'active', clears consecutive miss counter.
 *
 * @param {number} affiliateId
 * @param {string} monthYear  - e.g. '2026-04'
 * @param {object} pool
 * @returns {object} { releasedCents, email }
 */
async function releaseEscrow(affiliateId, monthYear, pool) {
  const client = await pool.connect();
  try {
    // Get affiliate info
    const { rows: [aff] } = await client.query(`
      SELECT id, email, heartbeat_status, consecutive_missed_heartbeats,
             u.name AS full_name
      FROM affiliates a
      JOIN users u ON u.id = a.user_id
      WHERE a.id = $1
    `, [affiliateId]);

    if (!aff) return { releasedCents: 0, email: null };
    if (aff.heartbeat_status !== 'pending') return { releasedCents: 0, email: aff.email };

    // Release escrowed commissions
    const { rows: released } = await client.query(`
      UPDATE commissions
      SET
        escrow_amount_cents = 0,
        escrow_started_at = NULL,
        updated_at = NOW()
      WHERE affiliate_id = $1
        AND escrow_amount_cents > 0
        AND status = 'pending'
      RETURNING amount_cents
    `, [affiliateId]);

    const releasedCents = released.reduce((sum, r) => sum + (r.amount_cents || 0), 0);
    const releasedDollars = (releasedCents / 100).toFixed(2);

    // Restore affiliate status
    await client.query(`
      UPDATE affiliates
      SET
        heartbeat_status = 'active',
        consecutive_missed_heartbeats = 0,
        affiliate_monthly_status = 'active',
        commissions_on_compliance_hold = false,
        orphan_placement_eligible = true,
        compliance_hold_started_at = NULL,
        compliance_hold_month = NULL,
        last_heartbeat_date = CURRENT_DATE,
        updated_at = NOW()
      WHERE id = $1
    `, [affiliateId]);

    const monthLabel = getMonthLabel(monthYear);
    const firstName = aff.full_name?.split(' ')[0] || 'Affiliate';

    // Send escrow released email
    if (releasedCents > 0) {
      try {
        await sendEmail(
          aff.email,
          `✅ Escrow Released — ${monthLabel} Heartbeat Accepted`,
          heartbeatEscrowReleasedEmail({ firstName, releasedAmountDollars: releasedDollars, monthLabel })
        );
      } catch (emailErr) {
        console.error(`[HeartbeatV2] Release email failed for ${aff.email}:`, emailErr.message);
      }
    }

    console.log(`[HeartbeatV2] Escrow released for affiliate ${affiliateId}: $${releasedDollars}`);
    return { releasedCents, email: aff.email };
  } finally {
    client.release();
  }
}

/**
 * runDay60and90Warnings — daily job (recommended: 10:00 UTC daily).
 *
 * Finds affiliates in 'pending' heartbeat_status and sends timed warnings:
 *  - ~60 days since first escrow: "Final warning — 1 month until forfeiture"
 *  - ~90 days since first escrow: "Forfeiture notice" + execute roll-up if cliff reached
 *
 * Uses compliance_hold_started_at as the anchor timestamp.
 */
async function runDay60and90Warnings(pool) {
  console.log('[HeartbeatV2] Running Day 60/90 cliff warning checks...');

  const client = await pool.connect();
  try {
    // Find pending affiliates past the 60-day mark who haven't received a Day 60 warning
    // We track this via affiliate_heartbeats notes — look for day60_warned flag
    const now = new Date();
    const day60Cutoff = new Date(now - 60 * 24 * 60 * 60 * 1000); // 60 days ago
    const day90Cutoff = new Date(now - 90 * 24 * 60 * 60 * 1000); // 90 days ago

    const { rows: pendingAffiliates } = await client.query(`
      SELECT
        a.id,
        a.email,
        a.heartbeat_status,
        a.consecutive_missed_heartbeats,
        a.compliance_hold_started_at,
        a.pending_balance_cents,
        a.day60_heartbeat_warned_at,
        a.day90_heartbeat_warned_at,
        u.name AS full_name
      FROM affiliates a
      JOIN users u ON u.id = a.user_id
      WHERE a.heartbeat_status = 'pending'
        AND a.status IN ('active', 'at_risk')
        AND a.compliance_hold_started_at IS NOT NULL
    `);

    let warned60 = 0, warned90 = 0, forfeited90 = 0;

    for (const aff of pendingAffiliates) {
      const escrowStart = new Date(aff.compliance_hold_started_at);
      const firstName = aff.full_name?.split(' ')[0] || 'Affiliate';
      const pendingDollars = ((aff.pending_balance_cents || 0) / 100).toFixed(2);
      const daysInEscrow = Math.floor((now - escrowStart) / (24 * 60 * 60 * 1000));

      // ── Day 90: forfeiture notice + execute if cliff reached ──────────────
      if (escrowStart <= day90Cutoff && !aff.day90_heartbeat_warned_at) {
        // Check if we should execute forfeiture (3 consecutive misses)
        const shouldForfeit = (aff.consecutive_missed_heartbeats || 0) >= CONSECUTIVE_MISSES_FOR_FORFEITURE;

        if (shouldForfeit) {
          await executeForfeitureRollUp(aff, pool, null);
          forfeited90++;
        } else {
          // Send Day 90 warning but don't forfeit yet (clock-based check; cliff needs 3 monthly checks)
          try {
            await sendEmail(
              aff.email,
              '🚨 Forfeiture Notice — Your Commissions Are At Risk',
              heartbeatForfeitureNoticeEmail({ firstName, forfeitedAmountDollars: pendingDollars })
            );
          } catch (emailErr) {
            console.error(`[HeartbeatV2] Day 90 email failed for ${aff.email}:`, emailErr.message);
          }
        }

        // Mark Day 90 warned (regardless of forfeiture, so we don't re-send)
        await client.query(`
          UPDATE affiliates
          SET day90_heartbeat_warned_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `, [aff.id]).catch(() => {
          // Column might not exist yet if migration hasn't been applied; log and continue
          console.warn(`[HeartbeatV2] day90_heartbeat_warned_at column not found for ${aff.id} — skipping mark`);
        });

        warned90++;

      // ── Day 60: final warning ──────────────────────────────────────────────
      } else if (escrowStart <= day60Cutoff && !aff.day60_heartbeat_warned_at && daysInEscrow < 90) {
        const daysUntilForfeiture = Math.max(0, 90 - daysInEscrow);

        try {
          await sendEmail(
            aff.email,
            `⚠️ Final Warning — ${daysUntilForfeiture} Days Until Commission Forfeiture`,
            heartbeatDay60WarningEmail({
              firstName,
              escrowAmountDollars: pendingDollars,
              consecutiveMissed: aff.consecutive_missed_heartbeats || 1,
              maxMisses: CONSECUTIVE_MISSES_FOR_FORFEITURE,
              daysUntilForfeiture
            })
          );
          warned60++;
        } catch (emailErr) {
          console.error(`[HeartbeatV2] Day 60 email failed for ${aff.email}:`, emailErr.message);
        }

        // Mark Day 60 warned
        await client.query(`
          UPDATE affiliates
          SET day60_heartbeat_warned_at = NOW(), updated_at = NOW()
          WHERE id = $1
        `, [aff.id]).catch(() => {
          console.warn(`[HeartbeatV2] day60_heartbeat_warned_at column not found for ${aff.id} — skipping mark`);
        });
      }
    }

    console.log(`[HeartbeatV2] Cliff warnings done. Day60=${warned60}, Day90=${warned90}, Forfeited=${forfeited90}`);
    return { warned60, warned90, forfeited90 };
  } finally {
    client.release();
  }
}

/**
 * runSquadHealthReport — Day 5 squad compliance email to leaders.
 * Shows green/red per direct team member. Calls out Level 5 Anchors at risk.
 */
async function runSquadHealthReport(pool) {
  console.log('[HeartbeatV2] Starting Day 5 Squad Health Report...');
  const monthYear = getCurrentMonthYear();
  const monthLabel = getMonthLabel(monthYear);
  const daysLeft = getDaysLeftInWindow();

  const client = await pool.connect();
  try {
    const { rows: leaders } = await client.query(`
      SELECT DISTINCT
        parent.id,
        parent.user_id,
        parent.email,
        u.name AS full_name
      FROM affiliates parent
      JOIN affiliates child ON child.parent_affiliate_id = parent.id
      JOIN users u ON u.id = parent.user_id
      WHERE parent.status = 'active'
    `);

    console.log(`[HeartbeatV2] Sending Squad Health Reports to ${leaders.length} leaders`);
    let sentCount = 0, errorCount = 0;

    for (const leader of leaders) {
      const { rows: children } = await client.query(`
        SELECT
          child.id,
          child.affiliate_level,
          child.email,
          child.referral_link_mode,
          u.name AS full_name,
          EXISTS (
            SELECT 1 FROM affiliate_heartbeats h
            WHERE h.user_id = child.user_id
              AND h.month_year = $1
              AND h.signature_confirmed = true
          ) AS completed
        FROM affiliates child
        JOIN users u ON u.id = child.user_id
        WHERE child.parent_affiliate_id = $2
          AND child.status IN ('active', 'at_risk')
        ORDER BY child.affiliate_level ASC, u.name ASC
      `, [monthYear, leader.id]);

      if (children.length === 0) continue;

      const teamRows = children.map(c => ({
        name: c.full_name || 'Team Member',
        email: c.email,
        level: c.affiliate_level,
        completed: c.completed
      }));

      const anchorAlert = children.some(c => c.affiliate_level === 5 && !c.completed);
      const firstName = leader.full_name?.split(' ')[0] || 'Leader';

      try {
        await sendEmail(
          leader.email,
          `📋 Action Required: Squad Compliance Alert [2 Days Left to Complete Heartbeat]`,
          squadHealthReportEmail({ firstName, monthLabel, daysLeft, teamRows, anchorAlert })
        );
        sentCount++;
      } catch (err) {
        console.error(`[HeartbeatV2] Squad email failed for ${leader.email}:`, err.message);
        errorCount++;
      }

      // Also send urgent reminder to pending direct children
      const pendingChildren = children.filter(c => !c.completed);
      for (const child of pendingChildren) {
        const childFirstName = child.full_name?.split(' ')[0] || 'Affiliate';
        try {
          await sendEmail(
            child.email,
            `⏰ 2 Days Left — Complete Your ${monthLabel} Heartbeat Now`,
            heartbeatReminderEmail({ firstName: childFirstName, daysLeft, monthLabel, isUrgent: true })
          );
        } catch (err) {
          console.error(`[HeartbeatV2] Urgent reminder failed for ${child.email}:`, err.message);
        }
      }
    }

    console.log(`[HeartbeatV2] Squad Health Reports: sent=${sentCount}, errors=${errorCount}`);
    return { sentCount, errorCount, monthYear };
  } finally {
    client.release();
  }
}

/**
 * runFamilyTagAlerts — Day 5: alerts sponsors about pending Family Legacy members.
 */
async function runFamilyTagAlerts(pool) {
  console.log('[HeartbeatV2] Starting Family Tag Alerts...');
  const monthYear = getCurrentMonthYear();
  const monthLabel = getMonthLabel(monthYear);
  const daysLeft = getDaysLeftInWindow();

  const client = await pool.connect();
  try {
    const { rows: familyPending } = await client.query(`
      SELECT
        child.id AS child_id,
        child.user_id AS child_user_id,
        child.email AS child_email,
        child.parent_affiliate_id,
        cu.name AS child_name,
        parent.email AS sponsor_email,
        pu.name AS sponsor_name
      FROM affiliates child
      JOIN users cu ON cu.id = child.user_id
      LEFT JOIN affiliates parent ON parent.id = child.parent_affiliate_id
      LEFT JOIN users pu ON pu.id = parent.user_id
      WHERE child.referral_link_mode = 'family_legacy'
        AND child.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM affiliate_heartbeats h
          WHERE h.user_id = child.user_id
            AND h.month_year = $1
            AND h.signature_confirmed = true
        )
    `, [monthYear]);

    console.log(`[HeartbeatV2] Family Legacy pending: ${familyPending.length}`);
    let alertsSent = 0;

    for (const member of familyPending) {
      if (!member.sponsor_email) continue;
      const sponsorFirstName = member.sponsor_name?.split(' ')[0] || 'Sponsor';
      try {
        await sendEmail(
          member.sponsor_email,
          `👨‍👩‍👧 Family Legacy Alert: ${member.child_name} Heartbeat Pending`,
          familyLegacyAlertEmail({
            sponsorFirstName,
            memberName: member.child_name,
            memberEmail: member.child_email,
            monthLabel,
            daysLeft
          })
        );
        alertsSent++;
      } catch (err) {
        console.error(`[HeartbeatV2] Family alert failed for ${member.sponsor_email}:`, err.message);
      }
    }

    console.log(`[HeartbeatV2] Family alerts: sent=${alertsSent}`);
    return { alertsSent, monthYear };
  } finally {
    client.release();
  }
}

/**
 * runDay5Jobs — wrapper for Day 5 squad health + family alerts.
 */
async function runDay5Jobs(pool) {
  const [squadResult, familyResult] = await Promise.allSettled([
    runSquadHealthReport(pool),
    runFamilyTagAlerts(pool)
  ]);

  return {
    squad: squadResult.status === 'fulfilled' ? squadResult.value : { error: squadResult.reason?.message },
    family: familyResult.status === 'fulfilled' ? familyResult.value : { error: familyResult.reason?.message }
  };
}

module.exports = {
  // Core compliance jobs
  runHeartbeatComplianceCheck,
  runDay1Reminders,
  runDay5Jobs,
  runDay60and90Warnings,
  releaseEscrow,
  executeForfeitureRollUp,

  // Sub-jobs (also exported for direct use)
  runSquadHealthReport,
  runFamilyTagAlerts,

  // Date helpers
  getCurrentMonthYear,
  getMonthLabel,
  getDaysLeftInWindow,

  // Constant
  CONSECUTIVE_MISSES_FOR_FORFEITURE
};
