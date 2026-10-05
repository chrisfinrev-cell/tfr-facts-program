# Sandbox Training Account

This document describes the sandbox/training account for demos and new-user onboarding.

---

## Credentials (do not store passwords in git)

| Field    | Value |
|----------|--------|
| Email    | `sandbox@financial-revolution.app` (override with `SANDBOX_EMAIL`) |
| Password | Set via `SANDBOX_PASSWORD` or `BETA_SEED_PASSWORD` in the staging/deploy environment. If unset, `scripts/seed-sandbox.js` generates a one-time password and prints it once at seed time — store that value in your password manager. |
| Plan     | Pro (permanent — `is_creator = true`) |

Never commit plaintext sandbox passwords to the repository.

---

## Accessing the Sandbox

### From the Dashboard (Recommended)
1. Log in as the founder/admin account
2. Click **Training Mode** in the top-right corner
3. The dashboard reloads with all demo data pre-loaded
4. Click **Exit Sandbox** to return to your account

### Direct Login
Navigate to `/login.html` and use the sandbox email + the password from your password manager / seed output.

---

## What's Pre-Loaded

| Section              | Data                                                        |
|---------------------|-------------------------------------------------------------|
| Transactions        | 60+ income & expense transactions spanning 6 months, across all 6 categories |
| Allocations         | Default 50/10/10/10/10/10 split                            |
| Bills               | 10 recurring bills (rent, utilities, streaming, insurance) |
| Debts               | 4 debts (2 credit cards, student loan, medical bill)        |
| Loans               | 2 loans (auto + federal student loan)                      |
| Bank Accounts       | 3 accounts (checking, HYSA, credit union)                  |
| Gift Cards          | 3 gift cards (Amazon, Starbucks, Target)                   |
| Portfolio           | Brokerage + Roth IRA + 401(k) with stock holdings          |
| Net Worth           | Assets and liabilities + 6-month snapshot history          |
| FI Calculator       | Pre-filled (age 32, target 52, $4,800/mo expenses)         |
| What-If Planner     | Uses FI Calculator data — adjustments are client-side       |
| Reports             | Auto-generated from transaction history                    |

---

## Engineer Update Protocol

**When you ship a new feature with new data sections, you MUST update the sandbox.**

1. Open `scripts/seed-sandbox.js`
2. Find the relevant section (or add a new `seedXxx` function)
3. Add realistic sample data for the new feature
4. Call the new function inside `main()`
5. Search for `SANDBOX_UPDATE_NEEDED` in the codebase — that tag marks TODOs for sandbox updates

The script runs automatically on every deploy (`npm run build` → `npm run migrate && node scripts/seed-sandbox.js`).
It's idempotent: clears old sandbox data and re-seeds fresh data every deploy.

---

## Technical Details

- **Seed script**: `scripts/seed-sandbox.js`
- **Backend endpoints**:
  - `POST /api/auth/sandbox-login` — switches session to sandbox user (creator-only)
  - `POST /api/auth/sandbox-exit` — restores original session
- **Frontend**: `public/app.html` — `enterSandboxMode()` / `exitSandboxMode()` functions
- **UI trigger**: Training Mode button (visible only when `is_creator = true`)
