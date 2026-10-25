'use strict';

const assert = require('assert');
const {
  signupUrlForCode,
  buildBetaInviteEmail,
  sendBetaInviteEmail
} = require('../lib/betaInviteEmail');
const { findActiveBetaInvite } = require('../lib/inviteCodes');

function fakeDb(handlers) {
  return {
    async query(sql, params) {
      const key = Object.keys(handlers).find((name) => sql.includes(name));
      if (!key) return { rows: [] };
      return handlers[key](sql, params);
    }
  };
}

async function main() {
  const signupUrl = signupUrlForCode('FACTS-7K9P-2M4X', 'https://factsmoney.com');
  assert.strictEqual(
    signupUrl,
    'https://factsmoney.com/signup.html?code=FACTS-7K9P-2M4X'
  );

  const payload = buildBetaInviteEmail({
    to: 'jane@example.com',
    name: 'Jane <Doe>',
    code: 'FACTS-7K9P-2M4X',
    signupUrl
  });
  assert.strictEqual(payload.to, 'jane@example.com');
  assert.strictEqual(payload.subject, 'Your FACTS beta invite code');
  assert.ok(payload.text.includes('FACTS-7K9P-2M4X'));
  assert.ok(payload.text.includes(signupUrl));
  assert.ok(payload.html.includes('Jane &lt;Doe&gt;'));
  assert.ok(!payload.html.includes('Jane <Doe>'));

  const previousKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const missing = await sendBetaInviteEmail({
    to: 'jane@example.com',
    code: 'FACTS-7K9P-2M4X',
    signupUrl
  });
  assert.strictEqual(missing.sent, false);
  assert.ok(/RESEND_API_KEY/.test(missing.error));

  process.env.RESEND_API_KEY = 'test-key';
  let captured = null;
  const sent = await sendBetaInviteEmail(
    { to: 'jane@example.com', name: 'Jane', code: 'FACTS-7K9P-2M4X', signupUrl },
    {
      async fetch(url, options) {
        captured = { url, options };
        return { ok: true, status: 200, async json() { return { id: 'email_123' }; } };
      }
    }
  );
  assert.strictEqual(sent.sent, true);
  assert.strictEqual(captured.url, 'https://api.resend.com/emails');
  assert.strictEqual(captured.options.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(captured.options.body);
  assert.deepStrictEqual(body.to, ['jane@example.com']);
  assert.ok(body.from);
  assert.ok(body.html.includes('FACTS-7K9P-2M4X'));
  assert.ok(body.html.includes(signupUrl));

  const rejected = await sendBetaInviteEmail(
    { to: 'jane@example.com', code: 'FACTS-7K9P-2M4X', signupUrl },
    {
      async fetch() {
        return { ok: false, status: 422, async json() { return { message: 'domain not verified' }; } };
      }
    }
  );
  assert.strictEqual(rejected.sent, false);
  assert.ok(/domain not verified/.test(rejected.error));

  const invite = await findActiveBetaInvite(fakeDb({
    beta_invites: async () => ({ rows: [{ id: 4, code: 'FACTS-AAAA-BBBB', uses_count: 0, max_uses: 1 }] })
  }), 'facts-aaaa-bbbb');
  assert.strictEqual(invite.kind, 'invite');
  assert.strictEqual(invite.row.id, 4);

  const master = await findActiveBetaInvite(fakeDb({
    beta_invites: async () => {
      const err = new Error('missing');
      err.code = '42P01';
      throw err;
    },
    beta_codes: async () => ({ rows: [{ id: 9, code: 'VIP-FOUNDER', uses_count: 1, max_uses: 5 }] })
  }), 'vip-founder');
  assert.strictEqual(master.kind, 'master');
  assert.strictEqual(master.row.code, 'VIP-FOUNDER');

  const none = await findActiveBetaInvite(fakeDb({
    beta_invites: async () => ({ rows: [] }),
    beta_codes: async () => ({ rows: [] })
  }), 'NOPE');
  assert.strictEqual(none, null);

  if (previousKey == null) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = previousKey;

  console.log('beta invite send checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
