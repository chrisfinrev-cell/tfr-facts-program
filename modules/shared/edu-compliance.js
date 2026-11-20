/**
 * Shared educational / regulatory framing for FACTS modules.
 * Keep copy aligned with public/legal-disclaimer.js and Terms of Service.
 *
 * FACTS is an educational SaaS only — not advice, not custodial, not a regulated
 * financial institution, RIA, broker-dealer, lender, or credit repair organization.
 *
 * Architecture posture (code-enforced intent):
 * - Non-custodial: never hold, transmit, escrow, or intermediate user funds
 * - Deterministic educational math / logging only — not advice directives
 * - No credit-bureau dispute transmission (CROA)
 * - No trade / order execution (not a broker-dealer)
 */

'use strict';

const EDUCATIONAL_DISCLAIMER =
  'FACTS is a strictly educational and informational platform. ' +
  'It does not provide financial, investment, tax, legal, lending, insurance, or credit-repair advice. ' +
  'FACTS is not a bank, broker-dealer, registered investment advisor (RIA), lender, credit repair organization, or fiduciary. ' +
  'All tools, calculators, scores, projections, comparisons, and system outputs are illustrative estimates for literacy and planning education only. ' +
  'Nothing on this platform guarantees outcomes. All decisions are made solely by you at your own risk. ' +
  'Consult a licensed professional before acting on any financial, credit, lending, tax, or legal matter.';

const SHORT_DISCLAIMER =
  'Educational only — not financial, legal, tax, lending, or credit-repair advice. Not a bank, RIA, or broker-dealer.';

const API_META_DISCLAIMER =
  'Tool output is strictly deterministic, non-custodial, and for educational modeling purposes only. Not financial, legal, or credit repair advice.';

/** Canonical non-custodial execution notice for calculation / sweep endpoints */
const MANUAL_EXECUTION_NOTICE = Object.freeze({
  status: 'calculated',
  execution_type: 'manual_user_action_required',
  notice:
    'Informational calculation only. Execute transfers directly within your banking portal.',
});

const EDU_META = Object.freeze({
  disclaimer: API_META_DISCLAIMER,
  non_custodial: true,
  educational_only: true,
  not_advice: true,
  not_credit_repair: true,
  not_money_transmitter: true,
  execution_type: MANUAL_EXECUTION_NOTICE.execution_type,
});

/**
 * Merge the canonical manual-execution notice into a JSON payload.
 * Does not overwrite an explicit status unless overwriteStatus is true.
 */
function withManualExecutionNotice(payload, { overwriteStatus = false } = {}) {
  const base = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.assign({}, payload)
    : { data: payload };
  if (overwriteStatus || base.status == null) {
    base.status = MANUAL_EXECUTION_NOTICE.status;
  }
  base.execution_type = MANUAL_EXECUTION_NOTICE.execution_type;
  base.notice = MANUAL_EXECUTION_NOTICE.notice;
  const existingMeta = base._meta && typeof base._meta === 'object' ? base._meta : {};
  base._meta = Object.assign({}, EDU_META, existingMeta);
  return base;
}

/** Module IDs that must always emit educational _meta on JSON responses */
const HIGH_RISK_MODULE_IDS = Object.freeze([
  'mod_sweep',
  'mod_lending_desk',
  'lending',
  'mod_credit_analysis',
  'mod_ai_coach',
  'mod_coaching',
  'mod_plaid',
  'mod_brokerage',
  'mod_rate_radar',
  'tfr_vault_services',
  'engine',
  'mod_affiliate',
]);

const AI_SYSTEM_GUARDRAILS = `
EDUCATIONAL / REGULATORY GUARDRAILS (MANDATORY):
- FACTS is an educational platform only. You teach frameworks and help users think — you do NOT advise.
- NEVER present yourself as a financial advisor, attorney, tax professional, credit counselor, lender, or fiduciary.
- NEVER give personalized investment recommendations (buy/sell/hold specific securities, crypto, or products).
- NEVER instruct users to take, dispute, delete, or modify credit-bureau items as a credit-repair service.
- NEVER instruct users to open, close, refinance, or draw on loans/HELOCs as a directive — discuss concepts only and urge licensed advice.
- NEVER guarantee returns, savings, credit-score changes, approval odds, or debt-payoff timelines.
- Prefer language like "educational illustration", "example allocation", "consider discussing with a licensed professional".
- If asked for regulated advice, refuse the advice framing and redirect: educational concepts + consult a licensed professional.
- Reminder: FACTS is non-custodial and does not hold, move, or manage user funds.
`.trim();

const AI_RESPONSE_FOOTER =
  '\n\n— Educational illustration only. Not financial, legal, tax, lending, insurance, or credit-repair advice. Consult a licensed professional before acting.';

/**
 * Express middleware: append educational _meta to JSON payloads and set response headers.
 * Safe for objects; leaves arrays/primitives unchanged aside from headers.
 * Also accepts educationalMetaMiddleware(moduleId) factory form.
 */
function applyEducationalMeta(req, res, next) {
  res.setHeader('X-FACTS-Educational-Only', 'true');
  res.setHeader('X-FACTS-Non-Custodial', 'true');

  const originalJson = res.json.bind(res);
  res.json = function eduMetaJson(body) {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const existing = body._meta && typeof body._meta === 'object' ? body._meta : {};
      body = Object.assign({}, body, {
        _meta: Object.assign({}, EDU_META, existing),
      });
    }
    return originalJson(body);
  };
  next();
}

function educationalMetaMiddleware(req, res, next) {
  if (typeof req === 'string') {
    return function boundEducationalMeta(req2, res2, next2) {
      applyEducationalMeta(req2, res2, next2);
    };
  }
  return applyEducationalMeta(req, res, next);
}

function isHighRiskModule(moduleId) {
  return HIGH_RISK_MODULE_IDS.includes(moduleId);
}

module.exports = {
  EDUCATIONAL_DISCLAIMER,
  SHORT_DISCLAIMER,
  API_META_DISCLAIMER,
  MANUAL_EXECUTION_NOTICE,
  EDU_META,
  HIGH_RISK_MODULE_IDS,
  AI_SYSTEM_GUARDRAILS,
  AI_RESPONSE_FOOTER,
  educationalMetaMiddleware,
  isHighRiskModule,
  withManualExecutionNotice,
};
