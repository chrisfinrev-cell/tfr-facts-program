# tfr-facts-program

**The Financial Revolution (TFR) + FACTS** — one official codebase bundle.

FACTS (Financial Allocation Control & Tracking System) replaces passive budgeting with active income allocation across six purpose-driven categories: Necessities, Velocity, Reserve, Lifestyle, Growth, and Legacy.

## Stack

Express.js + PostgreSQL (Neon) + vanilla JS frontend, served as static HTML from `/public`.

## Requirements

- Node.js 18+
- PostgreSQL database (Neon recommended)
- Production auth requires `SESSION_SECRET`, Twilio Verify, and `DATABASE_URL`

## Local Development

```bash
npm install
npm start
```

Do not commit `.env`. `archive/` is excluded from deploy.

## Notes

This repository is the single deployable FACTS app. Dated OneDrive dumps live under `archive/` and are not part of the Vercel build.
