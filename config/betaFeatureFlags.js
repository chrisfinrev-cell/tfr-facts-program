'use strict';

/**
 * Beta feature configuration helpers.
 * Wire into module-loader / server.js before enabling for testers.
 *
 * Env:
 *   BETA_MODE=true
 *   BETA_DISABLED_MODULES=mod_lending_desk,mod_sweep,mod_affiliate
 *   REQUIRE_BETA_NDA=true|false
 */

function isBetaMode(env = process.env) {
  return String(env.BETA_MODE || '').toLowerCase() === 'true';
}

function disabledModules(env = process.env) {
  return String(env.BETA_DISABLED_MODULES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isModuleDisabledForBeta(moduleId, env = process.env) {
  if (!isBetaMode(env)) return false;
  return disabledModules(env).includes(moduleId);
}

function requireBetaNda(env = process.env) {
  return String(env.REQUIRE_BETA_NDA || 'true').toLowerCase() !== 'false';
}

/** High-risk surfaces that should usually stay off for first beta cohorts. */
const DEFAULT_BETA_HIGH_RISK = [
  'mod_lending_desk',
  'mod_sweep',
  'mod_affiliate',
  'mod_rewards'
];

module.exports = {
  isBetaMode,
  disabledModules,
  isModuleDisabledForBeta,
  requireBetaNda,
  DEFAULT_BETA_HIGH_RISK
};
