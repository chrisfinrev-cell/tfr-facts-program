'use strict';

/**
 * Dispatch milestone email reminders when an audit is due (Resend).
 * Supports dry-run via second arg or DRY_RUN=true.
 */

const { Resend } = require('resend');

let _resend = null;
function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/**
 * Dispatch milestone email reminders (with dry-run safety support)
 */
async function sendAuditReminderEmail(
  { userEmail, userName, milestone, accountAgeDays },
  dryRun = false
) {
  const isDryRun = dryRun || process.env.DRY_RUN === 'true';

  const milestoneTitles = {
    DAY_90: '90-Day Forensic Audit Due',
    DAY_180: '180-Day Mid-Year Forensic Audit Due',
    ANNUAL: 'Annual Comprehensive Forensic Audit Due'
  };

  const subject = `FACTS Platform: Your ${milestoneTitles[milestone] || 'Forensic Audit'} is Ready`;
  const safeName = String(userName || 'Valued Partner')
    .replace(/[<>&]/g, '')
    .slice(0, 120);

  if (isDryRun) {
    console.log('\n[DRY-RUN EMAIL SIMULATION] ========================================');
    console.log(`To: ${userEmail} (${safeName})`);
    console.log(`Subject: ${subject}`);
    console.log(`Milestone Trigger: ${milestone} (Account Age: ${accountAgeDays} days)`);
    console.log('Status: SIMULATED SUCCESS (No live email sent via Resend)');
    console.log('==================================================================\n');
    return { id: 'mock-dry-run-id-12345', dryRun: true };
  }

  const resend = getResend();
  if (!resend) {
    console.warn('[RESEND] RESEND_API_KEY not set — audit reminder skipped');
    return { skipped: true, reason: 'RESEND_API_KEY not set' };
  }
  if (!userEmail) {
    throw new Error('userEmail is required');
  }

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #f8fafc; padding: 30px; border-radius: 12px;">
      <h2 style="color: #10b981;">FACTS Forensic Audit Milestone</h2>
      <p>Hello ${safeName},</p>
      <p>Congratulations on reaching <strong>${Number(accountAgeDays) || 0} days</strong> on the FACTS platform!</p>
      <div style="background-color: #1e293b; padding: 20px; border-left: 4px solid #10b981; border-radius: 6px; margin: 20px 0;">
        <h4 style="margin: 0 0 10px 0; color: #38bdf8;">${milestoneTitles[milestone] || 'Forensic Audit Due'}</h4>
        <p style="margin: 0; font-size: 14px; color: #94a3b8;">
          It is time to upload your recent bank or credit card statements to verify your bucket allocations across
          <strong>Necessity, Reserve, Velocity, Growth, Lifestyle, and Legacy</strong>.
        </p>
      </div>
      <p>A clean forensic audit unlocks your next tier milestone and ensures 100% allocation accuracy.</p>
      <a href="${process.env.FORENSIC_AUDIT_URL || 'https://factsmoney.com/dashboard/audit'}"
         style="display: inline-block; background-color: #10b981; color: #ffffff; font-weight: bold; padding: 12px 24px; border-radius: 6px; text-decoration: none; margin-top: 15px;">
        Upload Statements Now
      </a>
      <p style="margin-top: 30px; font-size: 12px; color: #64748b;">
        The Financial Architect | FACTS Platform Security & Compliance
      </p>
    </div>
  `;

  try {
    const from =
      process.env.RESEND_FROM || 'FACTS Compliance <compliance@factsmoney.com>';
    const data = await resend.emails.send({
      from,
      to: [userEmail],
      subject,
      html: htmlContent
    });
    const id = data && (data.id || (data.data && data.data.id));
    console.log(`[RESEND SUCCESS] Audit reminder sent to ${userEmail}${id ? ` (ID: ${id})` : ''}`);
    return data;
  } catch (error) {
    console.error(`[RESEND ERROR] Failed to send email to ${userEmail}:`, error.message || error);
    throw error;
  }
}

module.exports = {
  sendAuditReminderEmail
};
