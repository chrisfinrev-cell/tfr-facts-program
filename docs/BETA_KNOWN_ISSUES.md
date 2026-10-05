# Beta Known Issues & Quick Start

Official bundle: **tfr-facts-program** (The Financial Revolution + FACTS).

## Quick Start (testers)

1. Receive a beta invite code from an admin.
2. Register via `/signup` flow or web beta `/register` with that code.
3. Accept the Beta NDA (typed legal name required).
4. Complete Phase Zero / allocation setup as prompted.
5. Report issues via the in-app feedback endpoint once mounted (`POST /api/beta/feedback`) or email the founder.

## Operator Quick Start

1. Copy `env.staging.example` → `.env.staging` with a **separate** Neon DB.
2. Run migrations: `npm run migrate` and apply `db/beta_nda_migration.sql`, `db/admin_role_migration.sql`, `db/nda_pdf_audit_migration.sql`.
3. Confirm Stripe **test** keys and `PLAID_ENV=sandbox`.
4. Set `REQUIRE_BETA_NDA=true` and optional `BETA_DISABLED_MODULES=...`.
5. Smoke: `node scripts/smoke-test.js https://YOUR-STAGING-HOST --invite-code YOUR_CODE`.

## Known Issues (pre-release)

| Area | Issue | Severity |
|------|--------|----------|
| NDA PDF | Session ownership enforced (self or admin/creator); unauthenticated access blocked | Fixed |
| Staging | `env.staging.example` + `validateBetaEnvironment()` refuse `sk_live_` / Plaid production in beta | Fixed (operator must still use isolated Neon) |
| Payments | Live Stripe keys blocked when `BETA_MODE=true` or `NODE_ENV=staging` | Fixed |
| Web wizard | `BetaLaunchWizard` still uses mock passport (founder #42) unless wired to live register/accept | Medium |
| Tests | No Jest/Cypress suite; only `scripts/smoke-test.js` + engine script reference | Medium |
| Monitoring | `requestErrorLogger` mounted; Sentry still optional via `SENTRY_DSN` | Partial |
| Feedback | `POST /api/beta/feedback` mounted | Fixed (UI button still optional) |
| Docs | Sandbox password removed from docs; use env / password manager | Fixed |
| Secrets | Seed scripts use env or generated passwords | Fixed |
| Migrations | Recent beta SQL migrations have `.down.sql` companions | Partial (legacy JS migrations still sparse) |

## Do not share with testers

- Production `DATABASE_URL` / Neon owner password
- Live Stripe keys
- Sandbox training credentials from `docs/SANDBOX_ACCOUNT.md` (creator training only)
