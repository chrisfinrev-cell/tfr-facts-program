'use strict';

const assert = require('assert');
const {
  generateInviteCodes,
  formatInviteCode,
  findInviteCode,
  findActiveInviteCode,
  redeemInviteCode,
  listActiveInviteCodes,
  ensureSharedInvitePool,
  createMasterAdminCode,
  INVITE_CODE_PREFIX,
  INVALID_INVITE_ERROR
} = require('../lib/inviteCodes');

function memoryDb() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    async query(sql, params) {
      const text = String(sql);
      if (/CREATE TABLE IF NOT EXISTS invite_codes/i.test(text) || /CREATE (UNIQUE )?INDEX IF NOT EXISTS/i.test(text)) {
        return { rows: [] };
      }
      if (/INSERT INTO invite_codes/i.test(text)) {
        const code = params[0];
        const createdBy = params[1];
        if (rows.some((row) => String(row.code).toUpperCase() === String(code).toUpperCase())) {
          const err = new Error('duplicate');
          err.code = '23505';
          throw err;
        }
        const row = {
          id: nextId++,
          code,
          status: 'ACTIVE',
          created_by: createdBy,
          used_by: null,
          created_at: new Date(),
          used_at: null
        };
        rows.push(row);
        return { rows: [row] };
      }
      if (/SELECT COUNT\(\*\)::int AS n FROM invite_codes WHERE status = 'ACTIVE'/i.test(text)) {
        return { rows: [{ n: rows.filter((row) => row.status === 'ACTIVE').length }] };
      }
      if (/FROM invite_codes[\s\S]*WHERE UPPER\(code\) = \$1/i.test(text) && /UPDATE/i.test(text) === false) {
        const match = rows.find((row) => String(row.code).toUpperCase() === String(params[0]).toUpperCase());
        return { rows: match ? [match] : [] };
      }
      if (/UPDATE invite_codes/i.test(text)) {
        const match = rows.find(
          (row) => String(row.code).toUpperCase() === String(params[0]).toUpperCase() && row.status === 'ACTIVE'
        );
        if (!match) return { rows: [] };
        match.status = 'USED';
        match.used_by = params[1];
        match.used_at = new Date();
        return { rows: [match] };
      }
      if (/FROM invite_codes/i.test(text) && /WHERE status = \$1/i.test(text)) {
        return { rows: rows.filter((row) => row.status === params[0]) };
      }
      if (/FROM invite_codes/i.test(text)) {
        return { rows: rows.slice() };
      }
      return { rows: [] };
    }
  };
}

async function main() {
  const sample = formatInviteCode();
  assert.ok(new RegExp(`^${INVITE_CODE_PREFIX}-[A-Z0-9]{4}-[A-Z0-9]{4}$`).test(sample), sample);

  const db = memoryDb();
  const batch = await generateInviteCodes(db, 100, 'FIN-REV', 'admin@factsmoney.com');
  assert.strictEqual(batch.length, 100);
  const unique = new Set(batch.map((row) => row.code));
  assert.strictEqual(unique.size, 100);
  batch.forEach((row) => {
    assert.ok(/^FIN-REV-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(row.code), row.code);
    assert.strictEqual(row.status, 'ACTIVE');
    assert.strictEqual(row.createdBy, 'admin@factsmoney.com');
    assert.strictEqual(row.usedBy, null);
  });

  const secondAdmin = await ensureSharedInvitePool(db, 'other-admin@factsmoney.com');
  assert.strictEqual(secondAdmin.created.length, 0);
  assert.strictEqual(secondAdmin.codes.filter((row) => row.status === 'ACTIVE').length, 100);

  const code = batch[0].code;
  const found = await findActiveInviteCode(db, code.toLowerCase());
  assert.ok(found);
  assert.strictEqual(found.code, code);

  const redeemed = await redeemInviteCode(db, code, '42');
  assert.strictEqual(redeemed.status, 'USED');
  assert.strictEqual(redeemed.usedBy, '42');
  assert.ok(redeemed.usedAt);

  const reused = await findActiveInviteCode(db, code);
  assert.strictEqual(reused, null);
  const usedRow = await findInviteCode(db, code);
  assert.strictEqual(usedRow.status, 'USED');
  assert.strictEqual(INVALID_INVITE_ERROR, 'Invalid or already used invite code.');

  const twice = await redeemInviteCode(db, code, '99');
  assert.strictEqual(twice, null);

  const active = await listActiveInviteCodes(db);
  assert.strictEqual(active.length, 99);
  assert.ok(active.every((row) => row.status === 'ACTIVE'));

  const topped = await ensureSharedInvitePool(db, 'admin@factsmoney.com');
  assert.strictEqual(topped.created.length, 1);
  assert.strictEqual(topped.codes.filter((row) => row.status === 'ACTIVE').length, 100);

  const masterRows = [];
  const masterDb = {
    async query(sql, params) {
      if (/CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE|beta_invites|beta_referral|invite_codes/i.test(sql) && !/INSERT INTO beta_codes|UPDATE beta_codes|FROM beta_codes/i.test(sql)) {
        return { rows: [] };
      }
      if (/FROM beta_codes/i.test(sql) && /WHERE UPPER\(code\)/i.test(sql)) {
        const hit = masterRows.find((row) => String(row.code).toUpperCase() === String(params[0]).toUpperCase());
        return { rows: hit ? [hit] : [] };
      }
      if (/UPDATE beta_codes/i.test(sql)) {
        const row = masterRows.find((item) => item.id === params[0]);
        row.max_uses += params[1];
        return { rows: [row] };
      }
      if (/INSERT INTO beta_codes/i.test(sql)) {
        const row = {
          id: masterRows.length + 1,
          code: params[0],
          max_uses: params[1],
          uses_count: 0,
          created_at: new Date(),
          created_by: params[2],
          created_by_user_id: params[3],
          name: params[4]
        };
        masterRows.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    }
  };
  const master = await createMasterAdminCode(masterDb, {
    code: 'vip-founder-2026',
    maxUses: 5,
    createdBy: 'admin@factsmoney.com',
    createdByUserId: 1
  });
  assert.strictEqual(master.code, 'VIP-FOUNDER-2026');
  assert.strictEqual(master.max_uses, 5);
  assert.strictEqual(master.created, true);
  const again = await createMasterAdminCode(masterDb, { codeName: 'VIP-FOUNDER-2026', maxUses: 3 });
  assert.strictEqual(again.created, false);
  assert.strictEqual(again.max_uses, 8);

  console.log('invite code checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
