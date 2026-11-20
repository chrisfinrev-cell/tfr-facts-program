# Financial Revolution (FACTS)

## What this app does
FACTS — Financial Allocation Control & Tracking System — helps users replace passive budgeting with active income allocation across 6 purpose-driven categories (Necessities, Velocity, Reserve, Lifestyle, Growth, Legacy) on the path to financial sovereignty.

## Stack
Express.js + PostgreSQL (Neon) + vanilla JS frontend, served as static HTML from `/public`.

## Directory map
- `server.js` — legacy god file (33k lines); entry point, all legacy routes. Do not add to it.
- `modules/` — pluggable feature modules (mod_analytics, mod_gamification, mod_ssc, etc.). New features go here.
- `migrations/` — node-pg-migrate style JS migrations (`{timestamp}_{name}.js`).
- `public/` — static HTML/CSS/JS served by Express static middleware.
- `services/` — legacy Twilio wrapper only.
- `jobs/` — affiliate commission job runner.
- `scripts/` — one-off seed/setup scripts.
- `tfr_vault_services/` — TFR vault module (loaded by module-loader).

## Database
- `users` — core user accounts, subscription status, tiers.
- `transactions` — income and spending entries across FACTS categories.
- `categories` / `user_allocations` — FACTS 6-bucket category system.
- `user_events` — analytics event log (event_type, metadata JSONB, user_id, created_at).
- `module_events` — module-scoped event audit trail.
- `stripe_subscriptions` — Stripe subscription records.
- `ai_coach_messages` — allocation coach chat history per user (role, content, tier, created_at).
- `rate_radar_bills` — recurring bill tracking (category, provider, amount, frequency, renewal dates).
- `rate_radar_comparisons` — rate comparison results per bill (alternatives JSONB, 7-day TTL).
- `rate_radar_dismissals` — dismissed alternatives per user/bill.
- `credit_analyses` — Forensic Credit Scan results (user_id nullable for anonymous, analysis JSONB).
- `ip_scan_log` — IP-based rate limiting for anonymous credit scans (1 per IP).
- `mod_onboarding.funnel_sessions` — anonymous referral funnel sessions (income, bleed, step).
- `mod_onboarding.forensic_answers` — per-session forensic question responses (Q0–Q4).
- `mod_onboarding.onboarding_events` — analytics event log (12 events from facts-funnel).
- `mod_onboarding.vault_users` — funnel-created users with salary and phase-zero state.
- `mod_onboarding.exit_captures` — exit-intent email captures with bleed snapshot.
- `mod_onboarding.delayed_emails` — queued follow-up emails for exit capture sequence (sent BOOLEAN, send_at TIMESTAMP).
- `mod_shopping.stores` — GPS-discovered stores with community price data (category, chain, price_count, avg_price_cents).
- `mod_shopping.shopping_lists` — user shopping lists with store linkage and status (active/shopping/completed).
- `mod_shopping.list_items` — items in a list (name, brand, UPC, checked, entered_price_cents, confirmed).
- `mod_shopping.price_submissions` — legacy price data per store/product (manual or receipt_scan source).
- `mod_shopping.products` — canonical product catalog (name, UPC, category, created_at, community_avg_price).
- `mod_shopping.prices` — normalized price entries (store_id, product_id, price DECIMAL, unit, upc, contribution_type, purchased_at, created_at — set server-side).
- `mod_shopping.sweep_history` — bucket sweep records (bucket, amount_cents, trip_savings_cents, store_id).
- `mod_shopping.receipt_scans` — receipt image scan records (r2_key, image_url, parsed_items JSONB, total_cents, purchase_date, item_count).
- Dozens of domain tables (debts, brokerage, household, gamification, etc.) — see MODULES.md.

## External integrations
- Stripe — subscription billing and payment links.
- Plaid — bank account linking and balance sync.
- Twilio — 2FA SMS verification.
- Web Push — push notification subscriptions.
- OpenAI — allocation suggestion engine (Phase Zero; internal integration only).

## Recent changes
- 2026-06-02: Renamed "Stolen Wealth Calculator" → "Stolen Wealth Estimator" — text only in facts-funnel.html (title, SVG text, aria-label, comments). URLs unchanged.
- 2026-06-02: Calculator CSS fallback — added inline CSS fallbacks for all Tailwind utility classes in facts-funnel.html so dark theme, gold sliders, and gradient button render when Tailwind CDN is blocked by privacy browsers (DuckDuckGo, Brave). Also added Firefox slider thumb styling.
- 2026-06-02: Nav CSS fallback — added inline CSS fallbacks for all critical Tailwind utility classes in index.html so nav/layout renders correctly when Tailwind CDN script is blocked by privacy browsers (DuckDuckGo, Brave). SW cache bumped v6→v7.
- 2026-05-30: CALCULATOR position fix — moved y from 140→118 to tuck between T's of STOLEN WEALTH, above crimson line. ViewBox height 145→125. Confirmed font-weight:normal, fill:#B0B0B0 (silver/grey). No gold, no bold.
- 2026-05-30: CALCULATOR style fix — removed bold (now regular weight), changed from gold metallic gradient to flat silver/grey (#B0B0B0), repositioned between T's above crimson line (y=140, viewBox height 145). Removed gold gradient defs.
