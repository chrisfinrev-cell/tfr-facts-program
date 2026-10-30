'use strict';

const { sendEmail, emailConfigured } = require('./mailer');

/** Default Resend "from" for beta invite mail (domain must be verified in Resend). */
const DEFAULT_BETA_FROM = 'The Financial Revolution <beta@factsmoney.com>';
const BETA_INVITE_SUBJECT =
  'Private Invitation: Welcome to the Inner Circle of The Financial Revolution 🔒';
const MISSING_KEY_ERROR =
  'Email is not configured. Set RESEND_API_KEY, then send the code again from Beta Invites.';

function appBaseUrl() {
  const fromEnv = process.env.APP_URL || process.env.PUBLIC_APP_URL;
  if (fromEnv) return String(fromEnv).replace(/\/$/, '');
  return 'https://app.factsmoney.com';
}

function signupUrlForCode(code, baseUrl) {
  const base = String(baseUrl || appBaseUrl()).replace(/\/$/, '');
  return `${base}/signup.html?code=${encodeURIComponent(String(code || '').trim())}`;
}

function betaInviteFrom() {
  const fromEnv = process.env.BETA_EMAIL_FROM || process.env.BETA_INVITE_FROM;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  return DEFAULT_BETA_FROM;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildBetaInviteEmail({ to, name, code, signupUrl, userName }) {
  // Template vars: userName / inviteCode (name + code accepted as aliases from admin routes)
  const userNameRaw = (userName != null && String(userName).trim())
    ? String(userName).trim()
    : (name ? String(name).trim() : '');
  const displayName = userNameRaw || 'Pilot Participant';
  const inviteCode = String(code || '').trim();
  const portalUrl = String(signupUrl || `${appBaseUrl()}/signup.html`).trim();
  const safeDisplayName = escapeHtml(displayName);
  const safeInviteCode = escapeHtml(inviteCode);
  const safePortalUrl = escapeHtml(portalUrl);

  const text = [
    `Hi ${displayName},`,
    '',
    'You have been hand-selected for private, early-access entry into The Financial Revolution—a closed-door pilot of the Financial Allocation Control & Tracking System (FACTS).',
    '',
    'This is a strictly controlled, highly limited rollout reserved for an elite circle of participants. Your direct insights and critical eye will shape the final architecture of the platform before our public introduction.',
    '',
    'Your Private Access Code:',
    inviteCode,
    '',
    `Access the private portal: ${portalUrl}`,
    '',
    'Step-by-Step Pilot Instructions:',
    '1. Activate Your Account — sign up via the portal link, enter your credentials, and input your exclusive access code when prompted.',
    '2. Complete Phase Zero Onboarding — establish your baseline parameters and configure your custom six-bucket allocation percentages.',
    '3. Inspect Your Six-Bucket Ledger — verify that your core ledger structure and default allocation buckets have initialized.',
    '4. Stress-Test Core Capabilities — log sample transactions, evaluate budget categories, and explore debt and vault modules.',
    '5. Report Friction or Anomalies Instantly — use the in-app feedback tool to send bug reports or insights to engineering triage.',
    '',
    'If you need assistance, reply to this email or contact beta@factsmoney.com.',
    '',
    'Thank you for lending your expertise to this endeavor. Welcome to the inner circle.',
    '',
    'Best regards,',
    'The Financial Architect',
    'The Financial Revolution'
  ].join('\n');

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome to The Financial Revolution</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0d1117; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #e6edf3;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d1117; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 600px; background-color: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">

          <!-- Header -->
          <tr>
            <td style="padding-bottom: 24px; border-bottom: 1px solid #30363d;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 700; color: #58a6ff; letter-spacing: -0.5px;">THE FINANCIAL REVOLUTION</h1>
              <p style="margin: 4px 0 0 0; font-size: 13px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px;">Financial Allocation Control &amp; Tracking System (FACTS)</p>
            </td>
          </tr>

          <!-- Main Body -->
          <tr>
            <td style="padding-top: 24px; font-size: 15px; line-height: 1.6; color: #c9d1d9;">
              <p style="margin-top: 0;">Hi <strong>${safeDisplayName}</strong>,</p>

              <p>You have been hand-selected for private, early-access entry into <strong>The Financial Revolution</strong>—a closed-door pilot of the Financial Allocation Control &amp; Tracking System (FACTS).</p>

              <p>This is a strictly controlled, highly limited rollout reserved for an elite circle of participants. Your direct insights and critical eye will shape the final architecture of the platform before our public introduction.</p>

              <!-- Credentials Box -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #0d1117; border: 1px dashed #30363d; border-radius: 6px; margin: 24px 0;">
                <tr>
                  <td style="padding: 20px;">
                    <p style="margin: 0 0 8px 0; font-size: 12px; font-weight: 600; color: #8b949e; text-transform: uppercase;">Your Private Access Code</p>
                    <p style="margin: 0 0 16px 0; font-family: monospace; font-size: 20px; font-weight: 700; color: #3fb950; letter-spacing: 2px;">${safeInviteCode}</p>

                    <a href="${safePortalUrl}" target="_blank" style="display: inline-block; background-color: #238636; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; font-size: 14px;">Access Private Portal &rarr;</a>
                  </td>
                </tr>
              </table>

              <h3 style="color: #f0f6fc; font-size: 16px; margin-top: 28px; margin-bottom: 12px; border-bottom: 1px solid #21262d; padding-bottom: 8px;">Step-by-Step Pilot Instructions</h3>

              <ol style="padding-left: 20px; margin: 0 0 24px 0;">
                <li style="margin-bottom: 10px;"><strong>Activate Your Account:</strong> Access the private portal via the signup link above, enter your credentials, and input your exclusive access code when prompted.</li>
                <li style="margin-bottom: 10px;"><strong>Complete Phase Zero Onboarding:</strong> Upon entry, you will be guided through our private Phase Zero setup sequence. Establish your baseline parameters and configure your custom six-bucket allocation percentages.</li>
                <li style="margin-bottom: 10px;"><strong>Inspect Your Six-Bucket Ledger:</strong> Once onboarding is finalized, verify that your core ledger structure and default allocation buckets have initialized seamlessly.</li>
                <li style="margin-bottom: 10px;"><strong>Stress-Test Core Capabilities:</strong> Test the system by logging sample transactions, evaluating budget categories, and exploring the debt and vault modules under real-world conditions.</li>
                <li style="margin-bottom: 10px;"><strong>Report Friction or Anomalies Instantly:</strong> Use the integrated in-app feedback tool directly inside your dashboard to transmit bug reports or insights straight to our engineering triage desk.</li>
              </ol>

              <hr style="border: 0; border-top: 1px solid #30363d; margin: 28px 0;">

              <!-- Footer Support -->
              <p style="margin: 0 0 16px 0; font-size: 14px; color: #8b949e;">
                If you require assistance or encounter any gate restrictions, reply directly to this communication or contact our private pilot desk at <a href="mailto:beta@factsmoney.com" style="color: #58a6ff; text-decoration: none;">beta@factsmoney.com</a>.
              </p>

              <p style="margin: 0; font-size: 14px; color: #c9d1d9;">
                Thank you for lending your expertise to this endeavor. Welcome to the inner circle.
              </p>

              <p style="margin: 20px 0 0 0; font-size: 14px; color: #f0f6fc;">
                Best regards,<br>
                <strong>The Financial Architect</strong><br>
                <span style="color: #8b949e; font-size: 13px;">The Financial Revolution</span>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    to,
    from: betaInviteFrom(),
    replyTo: 'beta@factsmoney.com',
    subject: BETA_INVITE_SUBJECT,
    text,
    html
  };
}

async function sendBetaInviteEmail(options, deps) {
  if (!emailConfigured()) {
    console.error('[betaInviteEmail] RESEND_API_KEY is not set — invite email not sent');
    return {
      sent: false,
      error: MISSING_KEY_ERROR
    };
  }
  const payload = buildBetaInviteEmail(options || {});
  const result = await sendEmail(payload, deps);
  if (!result.sent) {
    console.error(
      '[betaInviteEmail] send failed to=%s from=%s error=%s',
      payload.to,
      payload.from,
      result.error || 'unknown'
    );
  }
  return result;
}

module.exports = {
  appBaseUrl,
  signupUrlForCode,
  buildBetaInviteEmail,
  sendBetaInviteEmail,
  betaInviteFrom,
  DEFAULT_BETA_FROM,
  BETA_INVITE_SUBJECT,
  MISSING_KEY_ERROR
};
