'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { userIsAdminAccount, isFounderAdminEmail, FOUNDER_ADMIN_EMAIL } = require('../config/adminAccess');
const {
  sessionUserId,
  paycheckSaveErrorMessage,
  deductionLinkPlan,
  finiteNumber,
  paycheckAlterStatements,
  buildPaycheckInsert,
  BUCKETS
} = require('../modules/engine/paycheck-ledger');
const { processIncomeTransaction } = require('../modules/engine/facts-income-processor');

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
check('req.user.id resolves', sessionUserId({ user: { id: 15 } }) === 15);
check('session.user_id string resolves', sessionUserId({ session: { user_id: '8' } }) === 8);
check('nested user.userId resolves', sessionUserId({ session: { user: { userId: '11' } } }) === 11);
check('zero is not a session user', sessionUserId({ session: { userId: 0 } }) === null);
check('non numeric session id is rejected', sessionUserId({ session: { userId: 'abc' } }) === null);
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

check('dollar string parses to a finite decimal', finiteNumber('$1,234.50') === 1234.5);
check('plain decimal string parses', finiteNumber('10.25') === 10.25);
check('NaN becomes 0', finiteNumber(NaN) === 0);
check('non numeric text becomes 0', finiteNumber('nope') === 0);
check('blank becomes 0', finiteNumber('') === 0);
check('infinity becomes 0', finiteNumber(Infinity) === 0);
check('missing value becomes 0', finiteNumber(undefined) === 0);

const alters = paycheckAlterStatements();
const payloadColumns = [
  'total_economic_compensation',
  'deductions',
  'liquid_take_home',
  'net_liquid_take_home',
  'bucket_allocations',
  'source_name',
  'employer_match_target'
];
payloadColumns.forEach(function (name) {
  const statement = alters.find(function (sql) { return sql.indexOf(name) !== -1; });
  check('column plan adds ' + name + ' if missing', !!statement && statement.indexOf('ADD COLUMN IF NOT EXISTS') !== -1);
});
check('column plan does not drop tables', alters.every(function (sql) {
  return sql.toUpperCase().indexOf('DROP TABLE') === -1;
}));

const calculated = processIncomeTransaction({
  calculation_mode: 'GROSS',
  gross_amount: 2000,
  employer_match: 100,
  employer_match_target: 'GROWTH',
  deductions: [{ label: 'Federal/State Tax', amount: 400.12, target_bucket: 'NECESSITIES' }]
});
const built = buildPaycheckInsert(4, {
  source_name: 'Paycheck',
  calculation_mode: 'GROSS',
  gross_amount: '2,000.00',
  net_amount: 'NaN',
  employer_match: '$100.00',
  deductions: [{ label: 'Federal/State Tax', amount: '400.129', target_bucket: 'NECESSITIES' }]
}, calculated);

check('insert casts money to numeric and json', built.text.indexOf('$5::numeric') !== -1 && built.text.indexOf('$10::jsonb') !== -1 && built.text.indexOf('$13::jsonb') !== -1);
check('gross net and match are finite numbers', [built.values[4], built.values[5], built.values[6]].every(function (n) {
  return typeof n === 'number' && Number.isFinite(n);
}));
check('parsed gross is 2000', built.values[4] === 2000);
check('bad net becomes 0', built.values[5] === 0);
check('parsed employer match is 100', built.values[6] === 100);
check('economic total is a finite number', built.economic === finiteNumber(calculated.summary.total_economic_compensation) && Number.isFinite(built.economic));
check('liquid take home prefers net_liquid_take_home', built.liquid === finiteNumber(calculated.summary.net_liquid_take_home));
check('deduction amount is rounded and finite', built.deductions.length === 1 && built.deductions[0].amount === 400.13);
BUCKETS.forEach(function (bucket) {
  check(bucket + ' allocation is a finite number', typeof built.buckets[bucket] === 'number' && Number.isFinite(built.buckets[bucket]));
});
check('stored json has no NaN', built.values[9].indexOf('NaN') === -1 && built.values[12].indexOf('NaN') === -1);
check('insert binds the session user id', built.values[0] === 4);

let rejectedNullUser = false;
try {
  buildPaycheckInsert(null, { gross_amount: 1 }, calculated);
} catch (err) {
  rejectedNullUser = !!(err && err.status === 401 && err.message);
}
check('insert refuses a null user id', rejectedNullUser);

const dbMessage = 'null value in column "user_id" of relation "paycheck_entries" violates not-null constraint';
check('failure body uses error.message', paycheckSaveErrorMessage(new Error(dbMessage)) === dbMessage);
check('empty error message uses a safe string', paycheckSaveErrorMessage(new Error('')) === 'Could not save this paycheck. Try again.');
check('blank error message uses a safe string', paycheckSaveErrorMessage(new Error('   ')) === 'Could not save this paycheck. Try again.');
check('missing error uses a safe string', paycheckSaveErrorMessage(undefined) === 'Could not save this paycheck. Try again.');

const routeSrc = fs.readFileSync(path.join(__dirname, '../modules/engine/index.js'), 'utf8');
check('save route is POST /api/engine/process', routeSrc.indexOf("router.post('/process'") !== -1);
check('save with no session user stays 401', routeSrc.indexOf('body.save === true && !userId') !== -1 && routeSrc.indexOf('status(401)') !== -1);
check('save failure logs Save paycheck failed', routeSrc.indexOf('console.error("Save paycheck failed:", error)') !== -1);
check('ledger save still logs Ledger save error', routeSrc.indexOf('console.error("Ledger save error:", error)') !== -1);
check('save failure returns success false and the error message', routeSrc.indexOf('success: false') !== -1 && routeSrc.indexOf('paycheckSaveErrorMessage(error)') !== -1);
check('save success includes success true and saved_id', routeSrc.indexOf('result.success = true') !== -1 && routeSrc.indexOf('result.saved_id = entryId') !== -1);
check('process route does not use asyncRoute', routeSrc.indexOf("router.post('/process', asyncRoute(") === -1);
check('process failure does not call next', routeSrc.indexOf('next(error)') === -1 && routeSrc.indexOf('next(err)') === -1);
check('ledger save does not rethrow into the module boundary', routeSrc.indexOf('throw err') === -1 && routeSrc.indexOf('throw error') === -1);
check('route does not hardcode Server error', routeSrc.indexOf("error: 'Server error'") === -1);

const pageSrc = fs.readFileSync(path.join(__dirname, '../public/paycheck-entry.html'), 'utf8');
const submitStart = pageSrc.indexOf('async function submitPaycheck');
const submitSrc = pageSrc.slice(submitStart, pageSrc.indexOf('addDeductionRow', submitStart));
check('submitPaycheck shows data.error', submitSrc.indexOf('data.error') !== -1);
check('submitPaycheck does not discard a Server error message', submitSrc.indexOf("!== 'Server error'") === -1);
check('401 still redirects to paycheck login', submitSrc.indexOf('/login.html?next=/paycheck-entry.html') !== -1);

console.log(passed + ' checks passed');
