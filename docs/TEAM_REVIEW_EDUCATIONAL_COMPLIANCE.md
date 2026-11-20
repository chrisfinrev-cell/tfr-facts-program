# Team Review Packet — Educational / Non-Custodial Compliance Hardening

**Scope:** Code changes from the regulatory architecture audit (educational-only, non-custodial, CROA/FinCEN/SEC-CFTC posture).  
**Stack context:** Express modules + static `/public` frontend.  
**Not legal advice:** This packet is for engineering review; counsel should still review live marketing copy.

---

## 1. Files touched (inventory)

### New
| Path | Purpose |
|------|---------|
| `modules/shared/edu-compliance.js` | Shared disclaimers, educational guardrails, `_meta` middleware, manual-execution notice helper |

### Backend (logic / posture)
| Path | Change summary |
|------|----------------|
| `module-loader.js` | Mounts `educationalMetaMiddleware` on high-risk module APIs + `/api/plaid` |
| `modules/mod_sweep/index.js` | Non-custodial comments; execute = instructional log; `withManualExecutionNotice` on potential/recalculate/execute |
| `modules/mod_lending_desk/index.js` | Simulation-only underwriting copy; sweep responses get manual-execution notice |
| `modules/mod_credit_analysis/index.js` | Removed CROA “dispute pack” specs; educational analysis schema; API disclaimers |
| `modules/mod_ai_coach/index.js` | Educational system prompt + response footer + disclaimer field |
| `modules/mod_rate_radar/index.js` | Educational comparison prompt + API disclaimer |
| `modules/mod_plaid/index.js` | Products reduced to `['transactions']` only (no `auth` / assets) |
| `modules/mod_brokerage/index.js` | Explicit no-trade-execution stub + educational meta |
| `tfr_vault_services/index.js` | Dormant educational shell + meta middleware |

### Frontend (disclaimers / soft language)
| Path | Change summary |
|------|----------------|
| `public/legal-disclaimer.js` | Stronger educational text; expanded timed tool-page list |
| `public/compliance-disclaimer.js` | “Educational platform” not “financial planning tool” |
| `public/educational-disclaimer.js` | Broader non-advice bullets (lending / credit repair / fiduciary) |
| `public/js/ai-coach.js` | Educational-only labeling in widget |
| `public/credit-analysis.html` | Softened CROA-risk CTAs; disclaimer script |
| `public/lending-desk.html` | On-page educational banner; disclaimer script |
| `public/brokerage-tracker.html` | Educational banner; no “free money” framing |
| `public/heloc-velocity-engine.html` | Softened strategy-as-directive hero copy |
| Many other `public/*.html` | Added `<script defer src="/legal-disclaimer.js">` where missing |

---

## 2. Canonical API notice (required shape)

Sweep / lending calculation responses now include:

```json
{
  "status": "calculated",
  "execution_type": "manual_user_action_required",
  "notice": "Informational calculation only. Execute transfers directly within your banking portal."
}
```

High-risk JSON responses also get `_meta` via middleware:

```json
{
  "_meta": {
    "disclaimer": "Tool output is strictly deterministic, non-custodial, and for educational modeling purposes only. Not financial, legal, or credit repair advice.",
    "non_custodial": true,
    "educational_only": true,
    "not_advice": true,
    "not_credit_repair": true,
    "not_money_transmitter": true,
    "execution_type": "manual_user_action_required"
  }
}
```

Headers on high-risk routes:
- `X-FACTS-Educational-Only: true`
- `X-FACTS-Non-Custodial: true`

High-risk module IDs covered by loader middleware:
`mod_sweep`, `mod_lending_desk`, `lending`, `mod_credit_analysis`, `mod_ai_coach`, `mod_plaid`, `mod_brokerage`, `mod_rate_radar`, `tfr_vault_services`, plus alias `/api/plaid`.

---

## 3. Audit checklist results

| Guardrail | Result |
|-----------|--------|
| 1. Sweep never custodial / no ACH escrow | **PASS** — DB confirmation logs only; notice requires banking-portal action |
| 2. Lending / vault simulation only; no P2P match | **PASS** — local pod math; underwriting = educational labels |
| 3. Credit: no bureau dispute transmission | **PASS** — parse/analyze only; dispute-pack specs removed |
| 4. Brokerage/Plaid read-only; no trade exec | **PASS** — Plaid `transactions` only; brokerage stub flags `trade_execution: false` |
| 5. `_meta` injection on high-risk APIs | **DONE** — via `edu-compliance` + `module-loader` |

---

## 4. How to review in the repo

Open these first (highest signal):

1. `modules/shared/edu-compliance.js` — source of truth  
2. `module-loader.js` — middleware mount  
3. `modules/mod_sweep/index.js` — money-movement boundary  
4. `modules/mod_lending_desk/index.js` — lending simulation boundary  
5. `modules/mod_credit_analysis/index.js` — CROA boundary  
6. `modules/mod_plaid/index.js` — product scopes  
7. `public/legal-disclaimer.js` — sitewide + tool acknowledgments  

Suggested git commands (on a machine with git in PATH):

```bash
git status
git diff --stat
git diff -- modules/shared/edu-compliance.js module-loader.js modules/mod_sweep modules/mod_lending_desk modules/mod_credit_analysis modules/mod_plaid modules/mod_ai_coach modules/mod_rate_radar modules/mod_brokerage tfr_vault_services public/legal-disclaimer.js public/compliance-disclaimer.js public/educational-disclaimer.js
```

---

## 5. Residual risks for counsel / product

- Legacy routes inside `server.js` were not fully line-audited (file is large / environment-restricted).
- Affiliate / income-claim pages need a separate marketing compliance pass.
- UI still uses product names like “Lending Desk” / “Underwriting” — engineering labels them educational; marketing should match.
- Credit UI “coming soon” templates must never auto-transmit to bureaus.

---

## 6. Full source: `modules/shared/edu-compliance.js`

See file in repo (complete module). Key exports:
- `educationalMetaMiddleware`
- `withManualExecutionNotice`
- `MANUAL_EXECUTION_NOTICE`
- `AI_SYSTEM_GUARDRAILS` / `AI_RESPONSE_FOOTER`
- `HIGH_RISK_MODULE_IDS`
