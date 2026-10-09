'use strict';

const EMAIL_ENDPOINT = 'https://polsia.com/api/proxy/email/send';

function appBaseUrl() {
  const fromEnv = process.env.APP_URL || process.env.PUBLIC_APP_URL;
  if (fromEnv) return String(fromEnv).replace(/\/$/, '');
  return 'https://factsmoney.com';
}

function signupUrlForCode(code, baseUrl) {
  const base = String(baseUrl || appBaseUrl()).replace(/\/$/, '');
  return `${base}/signup.html?code=${encodeURIComponent(String(code || '').trim())}`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildBetaInviteEmail({ to, name, code, signupUrl }) {
  const safeName = name ? String(name).trim() : '';
  const safeCode = String(code || '').trim();
  const greeting = safeName ? `Hi ${safeName},` : 'Hi,';
  const text = [
    greeting,
    '',
    'You have a FACTS beta invite.',
    '',
    `Your code: ${safeCode}`,
    '',
    `Create your account: ${signupUrl}`,
    '',
    'The signup page will fill this code in for you. If it does not, paste it into the invite code field.',
    '',
    'If you were not expecting this, you can ignore this email.'
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#0a0f1a;color:#e8e0d4;padding:32px 24px;border-radius:12px;">
      <div style="font-size:22px;font-weight:700;color:#c9a84c;letter-spacing:-0.5px;margin-bottom:20px;">FACTS</div>
      <h1 style="font-size:22px;font-weight:700;margin:0 0 12px;color:#e8e0d4;">Your beta invite</h1>
      <p style="font-size:15px;color:#a89a7e;line-height:1.6;margin:0 0 16px;">${escapeHtml(greeting)}</p>
      <p style="font-size:15px;color:#a89a7e;line-height:1.6;margin:0 0 8px;">Use this code to create your FACTS beta account:</p>
      <p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:20px;font-weight:700;color:#c9a84c;letter-spacing:0.04em;margin:0 0 24px;">${escapeHtml(safeCode)}</p>
      <a href="${escapeHtml(signupUrl)}" style="display:inline-block;background:#c9a84c;color:#0a0f1a;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px;text-decoration:none;">Create your account</a>
      <p style="font-size:13px;color:#6b5c44;line-height:1.6;margin:24px 0 0;">Or paste this link into your browser:<br><a href="${escapeHtml(signupUrl)}" style="color:#c9a84c;">${escapeHtml(signupUrl)}</a></p>
    </div>
  `;

  return {
    to,
    subject: 'Your FACTS beta invite code',
    body: text,
    html,
    transactional: true
  };
}

async function sendBetaInviteEmail(options, deps) {
  if (!process.env.POLSIA_API_KEY) {
    return {
      sent: false,
      error: 'Email is not configured. Set POLSIA_API_KEY, then send the code again from Beta Invites.'
    };
  }

  const fetchImpl = (deps && deps.fetch) || fetch;
  const payload = buildBetaInviteEmail(options);

  try {
    const response = await fetchImpl(EMAIL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.POLSIA_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch (_) {
        detail = '';
      }
      console.error('Beta invite email failed:', response.status, detail);
      return { sent: false, error: 'The email service rejected the beta invite.' };
    }

    return { sent: true };
  } catch (err) {
    console.error('Beta invite email error:', err && err.message ? err.message : err);
    return { sent: false, error: 'Could not reach the email service.' };
  }
}

module.exports = {
  EMAIL_ENDPOINT,
  appBaseUrl,
  signupUrlForCode,
  buildBetaInviteEmail,
  sendBetaInviteEmail
};
