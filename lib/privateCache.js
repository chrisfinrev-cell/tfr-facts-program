'use strict';

// Authenticated screens. A matching request must not be stored by the
// browser or a proxy, so Back cannot replay financial pages after logout.
const PRIVATE_PREFIXES = [
  '/app',
  '/admin',
  '/dashboard',
  '/paycheck-entry',
  '/settings',
  '/wallet',
  '/legacy-lens',
  '/household',
  '/discovery-scan',
  '/coaching',
  '/rate-radar',
  '/invites',
  '/document-vault',
  '/brokerage',
  '/scorecard',
  '/rewards',
  '/heloc',
  '/lending',
  '/phase-zero',
  '/lockout',
  '/feed',
  '/sovereign',
  '/resource-center',
  '/business-pro',
  '/level1',
  '/net-worth',
  '/future-generations',
  '/command-console',
  '/knowledge-vault',
  '/training',
  '/crypto-tracker',
  '/family',
  '/succession',
  '/vantage',
  '/receipt',
  '/shopping',
  '/ssc',
  '/junior',
  '/affiliate',
  '/benefits-masterclass',
  '/products',
  '/tier-upgrade',
  '/nda',
  '/api/'
];

const PRIVATE_CACHE_CONTROL = 'no-store, no-cache, must-revalidate, proxy-revalidate';

function normalizePath(urlPath) {
  const pathOnly = String(urlPath || '/').split('?')[0].split('#')[0];
  if (pathOnly.length > 1 && pathOnly.endsWith('/')) return pathOnly.slice(0, -1);
  return pathOnly || '/';
}

function isPrivateRequest(urlPath) {
  const pathOnly = normalizePath(urlPath).toLowerCase();
  return PRIVATE_PREFIXES.some(function (prefix) {
    if (pathOnly === prefix) return true;
    if (prefix.endsWith('/')) return pathOnly.startsWith(prefix);
    return pathOnly.startsWith(prefix + '/') || pathOnly.startsWith(prefix + '.');
  });
}

function applyPrivateCache(res) {
  res.setHeader('Cache-Control', PRIVATE_CACHE_CONTROL);
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

module.exports = {
  PRIVATE_PREFIXES,
  PRIVATE_CACHE_CONTROL,
  isPrivateRequest,
  applyPrivateCache
};
