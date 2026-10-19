'use strict';

const assert = require('assert');
const { isPrivateRequest, applyPrivateCache, PRIVATE_CACHE_CONTROL } = require('../lib/privateCache');

let passed = 0;
function check(name, ok) {
  assert.ok(ok, name);
  passed += 1;
  console.log('ok ' + name);
}

check('app is private', isPrivateRequest('/app'));
check('app html is private', isPrivateRequest('/app.html'));
check('admin is private', isPrivateRequest('/admin'));
check('paycheck entry is private', isPrivateRequest('/paycheck-entry.html'));
check('api routes are private', isPrivateRequest('/api/auth/me'));
check('logout api is private', isPrivateRequest('/api/auth/logout'));
check('login page is public', isPrivateRequest('/login') === false);
check('login html is public', isPrivateRequest('/login.html') === false);
check('signup is public', isPrivateRequest('/signup.html') === false);
check('home is public', isPrivateRequest('/') === false);

const headers = {};
applyPrivateCache({
  setHeader: function (name, value) { headers[name] = value; }
});
check('cache-control is no-store', headers['Cache-Control'] === PRIVATE_CACHE_CONTROL);
check('pragma is no-cache', headers.Pragma === 'no-cache');
check('expires is zero', headers.Expires === '0');

console.log(passed + ' checks passed');
