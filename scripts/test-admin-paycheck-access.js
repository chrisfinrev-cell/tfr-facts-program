'use strict';

const assert = require('assert');
const { userIsAdminAccount, isFounderAdminEmail, FOUNDER_ADMIN_EMAIL } = require('../config/adminAccess');
const { sessionUserId, deductionLinkPlan } = require('../modules/engine/paycheck-ledger');

let passed = 0;
function check(name, ok) {
  assert.ok(ok, name);
  passed += 1;
  console.log('ok ' + name);
}

check('founder email is the admin account', isFounderAdminEmail('Chris.FinRev@gmail.com'));
check('other emails are not the founder account', isFounderAdminEmail('owner@example.com') === false);

check('allowlisted email is admin', userIsAdminAccount({ email: FOUNDER_ADMIN_EMAIL, is_admin: false }));
check('role ADMIN is admin', userIsAdminAccount({ email: 'member@example.com', role: 'ADMIN' }));
check('role SUPER_ADMIN is admin', userIsAdminAccount({ email: 'member@example.com', role: 'super_admin' }));
check('plain member is not admin', userIsAdminAccount({ email: 'member@example.com', role: 'member', is_admin: false }) === false);

check('session userId resolves', sessionUserId({ session: { userId: 42 } }) === 42);
check('nested session user resolves', sessionUserId({ session: { user: { id: '7' } } }) === 7);
check('req.userId resolves', sessionUserId({ userId: 9 }) === 9);
check('missing session does not invent an id', sessionUserId({}) === null);

const uuidLinks = deductionLinkPlan('uuid', [
  { name: 'entry_id', udt: 'uuid', nullable: false },
  { name: 'paycheck_id', udt: 'int4', nullable: true }
]);
check('uuid ledger uses entry_id', uuidLinks.length === 1 && uuidLinks[0] === 'entry_id');

const intLinks = deductionLinkPlan('int4', [
  { name: 'entry_id', udt: 'uuid', nullable: true },
  { name: 'paycheck_id', udt: 'int4', nullable: false }
]);
check('serial ledger uses paycheck_id', intLinks.length === 1 && intLinks[0] === 'paycheck_id');

console.log(passed + ' checks passed');
