'use strict';

// Outbound email through Resend (https://resend.com).
// Requires RESEND_API_KEY. EMAIL_FROM must use a domain verified in Resend.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'FACTS <noreply@factsmoney.com>';

function emailConfigured() {
  return !!process.env.RESEND_API_KEY;
}

function defaultFrom() {
  return process.env.EMAIL_FROM || DEFAULT_FROM;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Sends one email. Never throws.
 * @param {{to: string|string[], subject: string, html?: string, text?: string, from?: string, replyTo?: string}} message
 * @returns {Promise<{sent: boolean, id?: string, error?: string}>}
 */
async function sendEmail(message, deps) {
  if (!emailConfigured()) {
    return { sent: false, error: 'Email is not configured. Set RESEND_API_KEY.' };
  }
  const { to, subject, html, text, from, replyTo } = message || {};
  if (!to || !subject || (!html && !text)) {
    return { sent: false, error: 'Email needs a recipient, subject, and body.' };
  }

  const payload = {
    from: from || defaultFrom(),
    to: Array.isArray(to) ? to : [to],
    subject,
    text: text || htmlToText(html)
  };
  if (html) payload.html = html;
  if (replyTo) payload.reply_to = replyTo;

  const fetchImpl = (deps && deps.fetch) || fetch;
  try {
    const response = await fetchImpl(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data && (data.message || data.error) ? (data.message || data.error) : `HTTP ${response.status}`;
      console.error('[mailer] Resend rejected email:', response.status, detail);
      return { sent: false, error: `The email service rejected the message (${detail}).` };
    }
    return { sent: true, id: data.id };
  } catch (err) {
    console.error('[mailer] send error:', err && err.message ? err.message : err);
    return { sent: false, error: 'Could not reach the email service.' };
  }
}

module.exports = { sendEmail, emailConfigured, defaultFrom, htmlToText };
