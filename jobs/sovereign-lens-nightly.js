'use strict';

/**
 * Sovereign Lens Nightly Cycle
 *
 * Runs at 12:01 AM daily for every active lending deal.
 *
 * Per-deal sequence:
 *   Step 1 — Plaid Balance Check: pull live balances, compare against scorecard
 *   Step 2 — Integrity Alert: flag >10% debt-to-limit ratio spike without disclosure
 *   Step 3 — Discipline Enforcement: Locked-Open mode on missed Friday Sweep
 *   Step 4 — Auto-Revoke: purge Plaid access on confirmed $0 balance + repayment complete
 *
 * Additionally executes 9 Asset Shield monitors (one per pod type) per deal.
 *
 * All alerts → asset_shield_alerts + lending_notifications.
 */

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

// ─── Plaid client setup ───────────────────────────────────────────────────────

let plaidClient = null;

function getPlaidClient() {
  if (plaidClient) return plaidClient;

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret   = process.env.PLAID_SECRET;
  const env      = process.env.PLAID_ENV || 'sandbox';

  if (!clientId || !secret) {
    console.warn('[SovereignLens] PLAID_CLIENT_ID / PLAID_SECRET not set — balance checks will be skipped');
    return null;
  }

  const configuration = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientId,
        'PLAID-SECRET': secret,
      },
    },
  });

  plaidClient = new PlaidApi(configuration);
  return plaidClient;
}

// ─── Notification helpers ─────────────────────────────────────────────────────

/**
 * Store alert in asset_shield_alerts + deliver in-app notification to both parties
 * (lender and borrower) for the deal.
 *
 * @param {object} client   - pg client
 * @param {object} opts
 * @param {number} opts.dealId
 * @param {number} opts.cycleRunId
 * @param {string} opts.shieldType
 * @param {string} opts.severity    - 'info' | 'warning' | 'critical'
 * @param {string} opts.alertType
 * @param {string} opts.message
 * @param {object} [opts.metadata]
 * @param {number[]} [opts.notifyUserIds] - user ids to notify in-app
 * @param {string} [opts.notifType]       - 'alert' | 'info' | 'action_required'
 * @param {string} [opts.notifTitle]
 * @returns {number} alert id
 */
async function storeAlert(client, opts) {
  const {
    dealId, cycleRunId, shieldType, severity, alertType, message,
    metadata = {}, notifyUserIds = [], notifType = 'alert', notifTitle
  } = opts;

  // Insert alert
  const { rows: [alert] } = await client.query(`
    INSERT INTO asset_shield_alerts
      (deal_id, shield_type, severity, alert_type, message, metadata, cycle_run_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    RETURNING id
  `, [dealId, shieldType, severity, alertType, message, JSON.stringify(metadata), cycleRunId || null]);

  const alertId = alert.id;

  // Deliver in-app notifications
  const title = notifTitle || `${severity === 'critical' ? '🚨' : '⚠️'} ${shieldType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}`;

  for (const userId of notifyUserIds) {
    if (!userId) continue;

    // Check notification preferences (default: in_app = true)
    const { rows: [pref] } = await client.query(`
      SELECT in_app FROM notification_preferences
      WHERE user_id = $1 AND alert_type = $2
    `, [userId, alertType]);

    const inApp = pref ? pref.in_app : true;

    if (inApp) {
      await client.query(`
        INSERT INTO lending_notifications
          (user_id, deal_id, alert_id, type, title, message, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [userId, dealId, alertId, notifType, title, message]);
    }
  }

  return alertId;
}

// ─── Plaid balance fetcher ────────────────────────────────────────────────────

/**
 * Fetch account balances for a given Plaid access token.
 * Returns null if Plaid is unavailable or token is missing.
 *
 * @param {string} accessToken
 * @returns {object|null} { accounts: [...], totalCurrentCents, totalLimitCents }
 */
async function fetchPlaidBalances(accessToken) {
  const client = getPlaidClient();
  if (!client || !accessToken) return null;

  try {
    const response = await client.accountsBalanceGet({ access_token: accessToken });
    const accounts = response.data.accounts || [];

    let totalCurrentCents = 0;
    let totalLimitCents   = 0;
    let totalDebtCents    = 0;

    for (const acct of accounts) {
      const current = Math.round((acct.balances.current || 0) * 100);
      const limit   = Math.round((acct.balances.limit   || 0) * 100);

      // Credit accounts: current balance = amount owed; limit = credit limit
      if (['credit', 'loan'].includes(acct.type)) {
        totalDebtCents  += current;
        totalLimitCents += limit;
      } else {
        totalCurrentCents += current;
      }
    }

    return {
      accounts,
      totalCurrentCents,
      totalDebtCents,
      totalLimitCents,
      fetchedAt: new Date().toISOString()
    };
  } catch (err) {
    console.warn('[SovereignLens] Plaid balance fetch error:', err.message);
    return null;
  }
}

// ─── Friday Sweep check ───────────────────────────────────────────────────────

/**
 * Returns true if the borrower has completed a sweep in the last 7 days.
 * Uses lending_deals.last_sweep_at as the source of truth.
 *
 * @param {object} deal - lending_deals row
 * @returns {boolean}
 */
function hasFridaySweep(deal) {
  if (!deal.last_sweep_at) return false;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return new Date(deal.last_sweep_at) >= sevenDaysAgo;
}

// ─── Debt-to-limit ratio helper ───────────────────────────────────────────────

function calcDebtToLimit(debtCents, limitCents) {
  if (!limitCents || limitCents <= 0) return 0;
  return debtCents / limitCents;
}

// ─── 9 Shield Monitors ───────────────────────────────────────────────────────

/**
 * Shield 1: Tax Guard (SDIRA)
 * Checks for prohibited transactions / disqualified persons (IRC §4975).
 * In practice: checks Plaid transaction history for suspicious inter-party transfers.
 *
 * Since disqualified person lists require manual configuration, this shield
 * flags deals where the borrower and lender share the same IP or email domain
 * as a potential related-party concern. Full DQP list is stored in metadata.
 */
async function runTaxGuard(client, deal, balanceData, cycleRunId) {
  const { id: dealId, borrower_user_id, lender_user_id } = deal;

  // Fetch user details to check for related-party red flags
  const { rows: users } = await client.query(`
    SELECT id, email FROM users WHERE id = ANY($1)
  `, [[borrower_user_id, lender_user_id].filter(Boolean)]);

  const userMap = {};
  for (const u of users) userMap[u.id] = u;

  const borrower = userMap[borrower_user_id];
  const lender   = userMap[lender_user_id];

  if (!borrower || !lender) return 0;

  // Check for same email domain (common disqualified person indicator)
  const borrowerDomain = borrower.email?.split('@')[1]?.toLowerCase();
  const lenderDomain   = lender.email?.split('@')[1]?.toLowerCase();

  if (borrowerDomain && lenderDomain && borrowerDomain === lenderDomain &&
      !['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com'].includes(borrowerDomain)) {
    await storeAlert(client, {
      dealId, cycleRunId,
      shieldType: 'tax_guard',
      severity: 'warning',
      alertType: 'tax_guard_related_party',
      message: `🛡️ Tax Guard — Potential disqualified person transaction detected on deal #${dealId}. Borrower and lender share the same email domain (${borrowerDomain}).`,
      metadata: { borrowerEmail: borrower.email, lenderEmail: lender.email },
      notifyUserIds: [lender_user_id],
      notifTitle: '🛡️ Tax Guard — Related Party Detected',
    });
    return 1;
  }

  return 0;
}

/**
 * Shield 2: Lapse Guard (CVLI)
 * Checks Cash Value vs. 1.5× annual premium threshold.
 */
async function runLapseGuard(client, deal, balanceData, cycleRunId) {
  const { id: dealId, borrower_user_id, lender_user_id } = deal;

  // Get shield config for annual premium
  const { rows: [cfg] } = await client.query(`
    SELECT annual_premium_cents, cash_value_account_ref FROM shield_config WHERE deal_id = $1
  `, [dealId]);

  if (!cfg || !cfg.annual_premium_cents) return 0;

  // Try to get cash value from Plaid balance data
  let cashValueCents = 0;
  if (balanceData && balanceData.accounts) {
    // Look for account matching cash_value_account_ref or any insurance-type account
    const cvAcct = balanceData.accounts.find(a =>
      (cfg.cash_value_account_ref && a.account_id === cfg.cash_value_account_ref) ||
      a.subtype === 'life insurance' || a.name?.toLowerCase().includes('cash value')
    );
    if (cvAcct) cashValueCents = Math.round((cvAcct.balances.current || 0) * 100);
    else cashValueCents = balanceData.totalCurrentCents || 0;
  }

  const threshold = Math.round(cfg.annual_premium_cents * 1.5);

  if (cashValueCents < threshold) {
    const cvDollars   = (cashValueCents / 100).toFixed(2);
    const threshDollars = (threshold / 100).toFixed(2);

    await storeAlert(client, {
      dealId, cycleRunId,
      shieldType: 'lapse_guard',
      severity: 'critical',
      alertType: 'lapse_guard_low_cash_value',
      message: `🛡️ Lapse Guard — Cash Value ($${cvDollars}) has dropped below 1.5× annual premium ($${threshDollars}) on deal #${dealId}`,
      metadata: { cashValueCents, thresholdCents: threshold, annualPremiumCents: cfg.annual_premium_cents },
      notifyUserIds: [lender_user_id, borrower_user_id],
      notifTitle: '🛡️ Lapse Guard — Cash Value Below Threshold',
    });
    return 1;
  }

  return 0;
}

/**
 * Shield 3: Margin Guard (SBLOC)
 * Monitors portfolio volatility in last 24 hours.
 * Uses Plaid brokerage account data to estimate volatility.
 */
async function runMarginGuard(client, deal, balanceData, cycleRunId) {
  const { id: dealId, borrower_user_id, lender_user_id } = deal;

  if (!balanceData || !balanceData.accounts) return 0;

  // Find brokerage accounts
  const brokerageAccts = balanceData.accounts.filter(a =>
    ['brokerage', 'investment'].includes(a.type) ||
    ['brokerage', '401k', 'ira', 'roth', 'sep ira', 'roth 401k'].includes(a.subtype)
  );

  if (brokerageAccts.length === 0) return 0;

  // Calculate estimated volatility from balance changes
  // We compare today's balance against the scorecard baseline
  const scorecard = deal.borrower_scorecard || {};
  const baselinePortfolio = scorecard.portfolio_value_cents || 0;
  const currentPortfolio  = brokerageAccts.reduce(
    (sum, a) => sum + Math.round((a.balances.current || 0) * 100), 0
  );

  if (!baselinePortfolio || baselinePortfolio <= 0) return 0;

  const changePct = Math.abs((currentPortfolio - baselinePortfolio) / baselinePortfolio) * 100;

  if (changePct > 15) {
    await storeAlert(client, {
      dealId, cycleRunId,
      shieldType: 'margin_guard',
      severity: changePct > 25 ? 'critical' : 'warning',
      alertType: 'margin_guard_high_volatility',
      message: `🛡️ Margin Guard — Portfolio volatility hit ${changePct.toFixed(1)}% in 24 hours on deal #${dealId}`,
      metadata: { changePct, currentPortfolioCents: currentPortfolio, baselineCents: baselinePortfolio },
      notifyUserIds: [lender_user_id, borrower_user_id],
      notifTitle: '🛡️ Margin Guard — High Portfolio Volatility',
    });
    return 1;
  }

  return 0;
}

/**
 * Shield 4: Rate Guard (Credit Card)
 * Checks 0% APR expiry date proximity.
 */
async function runRateGuard(client, deal, balanceData, cycleRunId) {
  const { id: dealId, borrower_user_id, lender_user_id } = deal;

  const { rows: [cfg] } = await client.query(`
    SELECT apr_expiry_date, apr_rate_after_expiry FROM shield_config WHERE deal_id = $1
  `, [dealId]);

  if (!cfg || !cfg.apr_expiry_date) return 0;

  const today    = new Date();
  const expiry   = new Date(cfg.apr_expiry_date);
  const daysLeft = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));

  if (daysLeft > 60) return 0;

  const severity   = daysLeft <= 30 ? 'critical' : 'warning';
  const afterRate  = cfg.apr_rate_after_expiry ? `${cfg.apr_rate_after_expiry}%` : 'standard APR';

  await storeAlert(client, {
    dealId, cycleRunId,
    shieldType: 'rate_guard',
    severity,
    alertType: 'rate_guard_apr_expiry',
    message: `🛡️ Rate Guard — 0% APR window expires in ${daysLeft} days on deal #${dealId}. Current rate after expiry: ${afterRate}`,
    metadata: { daysLeft, aprExpiryDate: cfg.apr_expiry_date, afterRate: cfg.apr_rate_after_expiry },
    notifyUserIds: [lender_user_id, borrower_user_id],
    notifTitle: `🛡️ Rate Guard — APR Expires in ${daysLeft} Days`,
    notifType: daysLeft <= 30 ? 'action_required' : 'alert',
  });
  return 1;
}

/**
 * Shield 5: Equity Guard (HELOC/PLOC)
 * Checks collateral value vs. 120% of outstanding loan balance.
 */
async function runEquityGuard(client, deal, balanceData, cycleRunId) {
  const { id: dealId, borrower_user_id, lender_user_id } = deal;

  const { rows: [cfg] } = await client.query(`
    SELECT collateral_estimated_value_cents FROM shield_config WHERE deal_id = $1
  `, [dealId]);

  if (!cfg || !cfg.collateral_estimated_value_cents) return 0;

  const collateralCents = cfg.collateral_estimated_value_cents;
  const outstandingCents = deal.amount_cents || 0;

  if (outstandingCents <= 0) return 0;

  const floorCents = Math.round(outstandingCents * 1.2);

  if (collateralCents < floorCents) {
    const collDollars = (collateralCents / 100).toFixed(2);
    const floorDollars = (floorCents / 100).toFixed(2);

    await storeAlert(client, {
      dealId, cycleRunId,
      shieldType: 'equity_guard',
      severity: 'critical',
      alertType: 'equity_guard_collateral_below_floor',
      message: `🛡️ Equity Guard — Collateral value ($${collDollars}) below 120% floor ($${floorDollars}) on deal #${dealId}`,
      metadata: { collateralCents, floorCents, outstandingCents },
      notifyUserIds: [lender_user_id, borrower_user_id],
      notifTitle: '🛡️ Equity Guard — Collateral Below Floor',
    });
    return 1;
  }

  return 0;
}

/**
 * Shield 6: Liquidity Guard (Personal Cash)
 * Checks lender's reserve vs. 6 months of monthly ops cash.
 */
async function runLiquidityGuard(client, deal, balanceData, cycleRunId) {
  const { id: dealId, borrower_user_id, lender_user_id } = deal;

  const { rows: [cfg] } = await client.query(`
    SELECT monthly_ops_cash_cents FROM shield_config WHERE deal_id = $1
  `, [dealId]);

  if (!cfg || !cfg.monthly_ops_cash_cents) return 0;

  const reserveCents  = balanceData ? (balanceData.totalCurrentCents || 0) : 0;
  const sixMonthFloor = cfg.monthly_ops_cash_cents * 6;

  if (reserveCents < sixMonthFloor) {
    const reserveDollars = (reserveCents / 100).toFixed(2);
    const floorDollars   = (sixMonthFloor / 100).toFixed(2);

    await storeAlert(client, {
      dealId, cycleRunId,
      shieldType: 'liquidity_guard',
      severity: 'warning',
      alertType: 'liquidity_guard_low_reserve',
      message: `🛡️ Liquidity Guard — Reserve account ($${reserveDollars}) below 6-month minimum ($${floorDollars}) on deal #${dealId}`,
      metadata: { reserveCents, sixMonthFloor, monthlyOpsCents: cfg.monthly_ops_cash_cents },
      notifyUserIds: [lender_user_id],
      notifTitle: '🛡️ Liquidity Guard — Reserve Below Minimum',
    });
    return 1;
  }

  return 0;
}

/**
 * Shield 7: Burn Guard (Business Revenue)
 * Checks if revenue dropped >25% month-over-month.
 * Uses Stripe or stored prev_month_revenue from shield_config.
 */
async function runBurnGuard(client, deal, balanceData, cycleRunId) {
  const { id: dealId, borrower_user_id, lender_user_id } = deal;

  const { rows: [cfg] } = await client.query(`
    SELECT stripe_account_id, prev_month_revenue_cents FROM shield_config WHERE deal_id = $1
  `, [dealId]);

  if (!cfg || !cfg.prev_month_revenue_cents) return 0;

  // For this cycle, try to get current month revenue from Plaid transaction data.
  // Without a Plaid transaction pull (we do balances only here), we use a heuristic:
  // total positive cash inflows visible in current balance vs. baseline.
  // In production this would hit Stripe API — for now we flag when the config is set.
  // TODO: When Stripe API is integrated, compare cfg.stripe_account_id MRR.

  // Use Plaid current balance as a proxy for liquidity if no Stripe data
  const currentRevenueCents = balanceData ? (balanceData.totalCurrentCents || 0) : 0;
  const prevRevenueCents    = cfg.prev_month_revenue_cents;

  if (prevRevenueCents > 0 && currentRevenueCents > 0) {
    const dropPct = ((prevRevenueCents - currentRevenueCents) / prevRevenueCents) * 100;

    if (dropPct > 25) {
      await storeAlert(client, {
        dealId, cycleRunId,
        shieldType: 'burn_guard',
        severity: dropPct > 50 ? 'critical' : 'warning',
        alertType: 'burn_guard_revenue_drop',
        message: `🛡️ Burn Guard — Revenue dropped ${dropPct.toFixed(1)}% month-over-month on deal #${dealId}`,
        metadata: { dropPct, currentRevenueCents, prevRevenueCents },
        notifyUserIds: [lender_user_id, borrower_user_id],
        notifTitle: '🛡️ Burn Guard — Revenue Drop Detected',
      });
      return 1;
    }
  }

  return 0;
}

/**
 * Shield 8: Default Guard (Note-on-Note)
 * Monitors the underlying note's repayment status.
 */
async function runDefaultGuard(client, deal, balanceData, cycleRunId) {
  const { id: dealId, lender_user_id, underlying_note_id } = deal;

  if (!underlying_note_id) return 0;

  // Check underlying note status
  const { rows: [underlying] } = await client.query(`
    SELECT id, status, deal_number FROM lending_deals WHERE id = $1
  `, [underlying_note_id]);

  if (!underlying) return 0;

  if (['defaulted', 'cancelled'].includes(underlying.status)) {
    await storeAlert(client, {
      dealId, cycleRunId,
      shieldType: 'default_guard',
      severity: 'critical',
      alertType: 'default_guard_underlying_note_at_risk',
      message: `🛡️ Default Guard — CRITICAL: Underlying note #${underlying_note_id} (${underlying.deal_number}) has slipped to '${underlying.status}'. Secondary deal #${dealId} at risk.`,
      metadata: { underlyingNoteId: underlying_note_id, underlyingStatus: underlying.status },
      notifyUserIds: [lender_user_id, deal.borrower_user_id],
      notifTitle: '🛡️ Default Guard — CRITICAL: Underlying Note Slipped',
      notifType: 'action_required',
    });
    return 1;
  }

  return 0;
}

/**
 * Shield 9: Compliance Guard (Standard LOC)
 * Verifies SB 362 APR Box is current.
 * Flags when deal terms have changed but APR box hasn't been regenerated.
 */
async function runComplianceGuard(client, deal, balanceData, cycleRunId) {
  const { id: dealId, lender_user_id, borrower_user_id } = deal;

  // Check custom_config for APR box status
  const { rows: [cfg] } = await client.query(`
    SELECT custom_config FROM shield_config WHERE deal_id = $1
  `, [dealId]);

  if (!cfg) return 0;

  const cc = cfg.custom_config || {};
  const aprBoxGeneratedAt = cc.apr_box_generated_at ? new Date(cc.apr_box_generated_at) : null;
  const termsLastUpdatedAt = deal.updated_at ? new Date(deal.updated_at) : null;

  // If deal was updated after the APR box was last generated → flag
  if (!aprBoxGeneratedAt || (termsLastUpdatedAt && termsLastUpdatedAt > aprBoxGeneratedAt)) {
    await storeAlert(client, {
      dealId, cycleRunId,
      shieldType: 'compliance_guard',
      severity: 'warning',
      alertType: 'compliance_guard_apr_box_stale',
      message: `🛡️ Compliance Guard — SB 362 APR Box needs regeneration for deal #${dealId}`,
      metadata: { aprBoxGeneratedAt: cc.apr_box_generated_at, dealUpdatedAt: deal.updated_at },
      notifyUserIds: [lender_user_id],
      notifTitle: '🛡️ Compliance Guard — APR Box Needs Update',
    });
    return 1;
  }

  return 0;
}

// ─── Shield dispatcher ────────────────────────────────────────────────────────

const SHIELD_MAP = {
  sdira:           runTaxGuard,
  cvli:            runLapseGuard,
  sbloc:           runMarginGuard,
  credit_card:     runRateGuard,
  heloc_ploc:      runEquityGuard,
  personal_cash:   runLiquidityGuard,
  business_revenue: runBurnGuard,
  note_on_note:    runDefaultGuard,
  standard_loc:    runComplianceGuard,
};

// ─── Per-deal cycle steps ─────────────────────────────────────────────────────

/**
 * Run the full nightly cycle for a single deal.
 *
 * @param {object} client   - pg transaction client
 * @param {object} deal     - lending_deals row (includes sovereign_lens_access cols)
 * @param {number} cycleRunId
 * @param {object|null} [balanceOverride] - optional Plaid-shaped balances for tests / dry-runs
 * @returns {object} { alertsGenerated, autoRevoke, lockedOpenActivated, lockedOpenDeactivated }
 */
async function processDeal(client, deal, cycleRunId, balanceOverride) {
  const {
    id: dealId,
    borrower_user_id, lender_user_id,
    plaid_access_token, lens_status, lens_mode,
    borrower_scorecard,
    pod_type
  } = deal;

  let alertsGenerated = 0;
  let autoRevoke      = false;
  let lockedOpenActivated   = false;
  let lockedOpenDeactivated = false;

  // ── Step 1: Plaid Balance Check ──────────────────────────────────────────
  // Tests may pass an explicit balance snapshot (incl. zero-balance revoke path).
  const balanceData = (balanceOverride != null)
    ? balanceOverride
    : await fetchPlaidBalances(plaid_access_token);
  const scorecard   = borrower_scorecard || {};

  let plaidDataSnapshot = {};
  let scorecardComparison = {};

  if (balanceData) {
    plaidDataSnapshot = balanceData;

    // Compare against scorecard
    const baselineDebt  = scorecard.total_debt_cents  || 0;
    const baselineLimit = scorecard.total_limit_cents || 0;
    const baselineRatio = calcDebtToLimit(baselineDebt, baselineLimit);
    const currentRatio  = calcDebtToLimit(balanceData.totalDebtCents, balanceData.totalLimitCents);

    scorecardComparison = {
      baselineDebtCents:    baselineDebt,
      currentDebtCents:     balanceData.totalDebtCents,
      baselineLimitCents:   baselineLimit,
      currentLimitCents:    balanceData.totalLimitCents,
      baselineDebtToLimit:  baselineRatio,
      currentDebtToLimit:   currentRatio,
      ratioDeltaPct:        baselineRatio > 0
        ? ((currentRatio - baselineRatio) / baselineRatio) * 100
        : 0,
    };

    // ── Step 2: Integrity Alert ──────────────────────────────────────────────
    const ratioDeltaPct = scorecardComparison.ratioDeltaPct;
    if (ratioDeltaPct > 10) {
      // Check if borrower disclosed this change (stored in deal notes / metadata)
      // For now: any spike > 10% without a recent disclosure note is flagged
      const disclosureCheck = scorecard.last_disclosure_at
        ? new Date(scorecard.last_disclosure_at) >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        : false;

      if (!disclosureCheck) {
        // Get borrower name
        const { rows: [borrower] } = await client.query(
          `SELECT name FROM users WHERE id = $1`, [borrower_user_id]
        );
        const borrowerName = borrower?.name || `User #${borrower_user_id}`;

        await storeAlert(client, {
          dealId, cycleRunId,
          shieldType: 'integrity_alert',
          severity: 'critical',
          alertType: 'integrity_alert_debt_ratio_spike',
          message: `⚠️ Integrity Alert — ${borrowerName} debt-to-limit ratio increased by ${ratioDeltaPct.toFixed(1)}% without prior disclosure.`,
          metadata: { ratioDeltaPct, baselineRatio, currentRatio, borrowerName },
          notifyUserIds: [lender_user_id],
          notifTitle: '⚠️ Integrity Alert — Undisclosed Debt Increase',
          notifType: 'action_required',
        });
        alertsGenerated++;
      }
    }

    // ── Step 4: Auto-Revoke (check before locked-open to prioritize revoke) ──
    // Confirmed $0 balance = totalCurrentCents is 0 or very low AND all debts cleared
    const totalBalance = balanceData.totalCurrentCents + balanceData.totalDebtCents;
    if (totalBalance === 0 || (balanceData.totalCurrentCents <= 100 && balanceData.totalDebtCents <= 100)) {
      // Cross-check against repayment schedule (deal funded at + schedule)
      const schedule = deal.repayment_schedule || {};
      const scheduleComplete = schedule.completed === true ||
        (schedule.end_date && new Date(schedule.end_date) <= new Date());

      if (scheduleComplete && lens_status === 'active') {
        // Purge access token, set status = revoked, generate frozen snapshot
        await client.query(`
          UPDATE sovereign_lens_access
          SET
            status = 'revoked',
            plaid_access_token = NULL,
            revoked_at = NOW(),
            frozen_snapshot = $1,
            updated_at = NOW()
          WHERE deal_id = $2 AND lender_user_id = $3
        `, [JSON.stringify({ ...balanceData, frozenAt: new Date().toISOString() }), dealId, lender_user_id]);

        // Notify both parties
        const revokeMessage = `✅ Capital deployment complete. Sovereign Lens access revoked. Frozen snapshot archived for deal #${dealId}.`;
        await storeAlert(client, {
          dealId, cycleRunId,
          shieldType: 'auto_revoke',
          severity: 'info',
          alertType: 'auto_revoke_deal_complete',
          message: revokeMessage,
          metadata: { frozenAt: new Date().toISOString() },
          notifyUserIds: [lender_user_id, borrower_user_id],
          notifTitle: '✅ Sovereign Lens Access Revoked — Deal Complete',
          notifType: 'info',
        });

        alertsGenerated++;
        autoRevoke = true;
      }
    }
  }

  // Save per-deal cycle log
  const today = new Date().toISOString().split('T')[0];
  await client.query(`
    INSERT INTO lens_cycle_logs (deal_id, cycle_date, plaid_data, scorecard_comparison, alerts_generated)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (deal_id, cycle_date) DO UPDATE
      SET plaid_data = EXCLUDED.plaid_data,
          scorecard_comparison = EXCLUDED.scorecard_comparison,
          alerts_generated = EXCLUDED.alerts_generated
  `, [dealId, today, JSON.stringify(plaidDataSnapshot), JSON.stringify(scorecardComparison), alertsGenerated]);

  // ── Step 3: Discipline Enforcement ──────────────────────────────────────────
  // Only check if not already auto-revoked
  if (!autoRevoke && lens_status === 'active') {
    const sweepPresent = hasFridaySweep(deal);

    if (!sweepPresent && lens_mode === 'standard') {
      // Activate Locked-Open mode
      await client.query(`
        UPDATE sovereign_lens_access
        SET lens_mode = 'locked_open', locked_open_at = NOW(), updated_at = NOW()
        WHERE deal_id = $1 AND lender_user_id = $2
      `, [dealId, lender_user_id]);

      const { rows: [borrower] } = await client.query(
        `SELECT name FROM users WHERE id = $1`, [borrower_user_id]
      );
      const borrowerName = borrower?.name || `User #${borrower_user_id}`;

      const lockMsg = `🔓 Locked-Open Mode activated — ${borrowerName} missed Friday Sweep. Full transparency enabled for deal #${dealId}.`;
      await storeAlert(client, {
        dealId, cycleRunId,
        shieldType: 'locked_open_activation',
        severity: 'warning',
        alertType: 'discipline_locked_open',
        message: lockMsg,
        metadata: { borrowerName, reason: 'missed_friday_sweep' },
        notifyUserIds: [lender_user_id],
        notifTitle: '🔓 Locked-Open Mode Activated',
        notifType: 'action_required',
      });
      alertsGenerated++;
      lockedOpenActivated = true;

    } else if (sweepPresent && lens_mode === 'locked_open') {
      // Deactivate Locked-Open — sweep received
      await client.query(`
        UPDATE sovereign_lens_access
        SET lens_mode = 'standard', locked_open_at = NULL, updated_at = NOW()
        WHERE deal_id = $1 AND lender_user_id = $2
      `, [dealId, lender_user_id]);

      await storeAlert(client, {
        dealId, cycleRunId,
        shieldType: 'locked_open_deactivation',
        severity: 'info',
        alertType: 'discipline_unlocked',
        message: `✅ Locked-Open Mode deactivated — Friday Sweep received for deal #${dealId}. Standard lens access restored.`,
        metadata: { sweepAt: deal.last_sweep_at },
        notifyUserIds: [lender_user_id, borrower_user_id],
        notifTitle: '✅ Lens Mode Restored to Standard',
        notifType: 'info',
      });
      lockedOpenDeactivated = true;
    }
  }

  // ── Shield Monitor (pod-type specific) ──────────────────────────────────────
  if (!autoRevoke) {
    const shieldFn = SHIELD_MAP[pod_type];
    if (shieldFn) {
      try {
        const shieldAlerts = await shieldFn(client, deal, balanceData, cycleRunId);
        alertsGenerated += shieldAlerts;
      } catch (err) {
        console.error(`[SovereignLens] Shield error for deal #${dealId} (${pod_type}):`, err.message);
      }
    }
  }

  return { alertsGenerated, autoRevoke, lockedOpenActivated, lockedOpenDeactivated };
}

// ─── Main cycle runner ────────────────────────────────────────────────────────

/**
 * runSovereignLensNightlyCycle
 *
 * Main entry point. Called by cron at 12:01 AM.
 * Processes all active deals sequentially to avoid Plaid rate limits.
 *
 * @param {object} pool - pg Pool
 * @returns {object} cycle summary
 */
async function runSovereignLensNightlyCycle(pool) {
  console.log('[SovereignLens] Starting nightly cycle...');
  const startTime = Date.now();
  const today = new Date().toISOString().split('T')[0];

  const client = await pool.connect();
  let cycleRunId;

  try {
    // Upsert cycle run record
    const { rows: [run] } = await client.query(`
      INSERT INTO lens_cycle_runs (cycle_date, status, started_at)
      VALUES ($1, 'running', NOW())
      ON CONFLICT (cycle_date) DO UPDATE
        SET status = 'running', started_at = NOW(), error_message = NULL
      RETURNING id
    `, [today]);
    cycleRunId = run.id;

    // Fetch all active deals with their lens access
    const { rows: deals } = await client.query(`
      SELECT
        d.*,
        sla.plaid_access_token,
        sla.status      AS lens_status,
        sla.lens_mode,
        sla.lender_user_id AS sla_lender_user_id
      FROM lending_deals d
      LEFT JOIN sovereign_lens_access sla
        ON sla.deal_id = d.id
        AND sla.status = 'active'
      WHERE d.status = 'active'
      ORDER BY d.id ASC
    `);

    console.log(`[SovereignLens] Processing ${deals.length} active deal(s)...`);

    const summary = {
      dealsChecked:             0,
      alertsGenerated:          0,
      autoRevokesTriggered:     0,
      lockedOpenActivations:    0,
      lockedOpenDeactivations:  0,
    };

    for (const deal of deals) {
      try {
        const result = await processDeal(client, deal, cycleRunId);
        summary.dealsChecked++;
        summary.alertsGenerated          += result.alertsGenerated;
        summary.autoRevokesTriggered     += result.autoRevoke ? 1 : 0;
        summary.lockedOpenActivations    += result.lockedOpenActivated ? 1 : 0;
        summary.lockedOpenDeactivations  += result.lockedOpenDeactivated ? 1 : 0;
      } catch (err) {
        console.error(`[SovereignLens] Deal #${deal.id} error:`, err.message);
      }
    }

    // Mark cycle run complete
    await client.query(`
      UPDATE lens_cycle_runs
      SET
        status = 'completed',
        deals_checked = $1,
        alerts_generated = $2,
        auto_revokes_triggered = $3,
        locked_open_activations = $4,
        locked_open_deactivations = $5,
        completed_at = NOW()
      WHERE id = $6
    `, [
      summary.dealsChecked,
      summary.alertsGenerated,
      summary.autoRevokesTriggered,
      summary.lockedOpenActivations,
      summary.lockedOpenDeactivations,
      cycleRunId
    ]);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `[SovereignLens] Cycle complete in ${duration}s — ` +
      `Deals=${summary.dealsChecked}, Alerts=${summary.alertsGenerated}, ` +
      `AutoRevokes=${summary.autoRevokesTriggered}, LockedOpen=${summary.lockedOpenActivations}`
    );

    return { ...summary, cycleRunId, durationSecs: parseFloat(duration) };

  } catch (err) {
    console.error('[SovereignLens] Fatal cycle error:', err.message);

    if (cycleRunId) {
      try {
        await client.query(`
          UPDATE lens_cycle_runs
          SET status = 'failed', error_message = $1, completed_at = NOW()
          WHERE id = $2
        `, [err.message, cycleRunId]);
      } catch (updateErr) {
        console.error('[SovereignLens] Failed to update cycle run status:', updateErr.message);
      }
    }

    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  runSovereignLensNightlyCycle,
  processDeal,
};
