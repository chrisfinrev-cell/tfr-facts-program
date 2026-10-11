# Affiliate System Background Jobs

## Overview

This directory contains background jobs for the Financial Revolution affiliate system.

## Jobs

### affiliate-jobs.js

Runs all affiliate system maintenance tasks:

1. **Approve Commissions** - Moves commissions from "pending" to "approved" after Net-30 window
2. **Check Payment Failures** - Identifies affiliates whose Pro subscription has expired and starts grace period
3. **Monitor Grace Periods** - Sends dunning emails on Day 7, 14, and 21; forfeits commissions and revokes affiliate status after Day 21

## Running Jobs

### Manual Execution

```bash
npm run affiliate-jobs
```

### Scheduled Execution (Recommended)

**Run daily via cron:**

```bash
# Add to crontab (crontab -e)
0 6 * * * cd /opt/render/project/src && npm run affiliate-jobs >> /var/log/affiliate-jobs.log 2>&1
```

This runs at 6:00 AM UTC every day.

**Alternative: GitHub Actions (if using)**

Create `.github/workflows/affiliate-jobs.yml`:

```yaml
name: Affiliate Jobs
on:
  schedule:
    - cron: '0 6 * * *' # Daily at 6am UTC
  workflow_dispatch: # Allow manual trigger

jobs:
  run-jobs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - run: npm install
      - run: npm run affiliate-jobs
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
```

## Environment Variables Required

- `DATABASE_URL` - PostgreSQL connection string (Neon)
- `RESEND_API_KEY` - For sending dunning emails via Resend
- `EMAIL_FROM` - Optional sender, e.g. `FACTS <noreply@factsmoney.com>` (domain must be verified in Resend)

## Email Templates

The jobs send the following emails:

1. **Welcome Email** - Sent when affiliate joins (manually triggered via API)
2. **Referral Conversion** - Sent when a referral converts to Pro (manually triggered via API)
3. **Commission Approved** - Sent after Net-30 when commissions move to approved balance
4. **Day 7 Warning** - Grace period started, friendly reminder
5. **Day 14 Warning** - Urgent warning, 7 days remaining
6. **Day 21 Final Notice** - Affiliate status revoked, commissions forfeited

## Logs

Monitor job execution:

```bash
tail -f /var/log/affiliate-jobs.log
```

Or run manually and watch output:

```bash
npm run affiliate-jobs
```

## Testing

To test without sending emails, modify the `sendEmail` function to log instead of actually sending.

## Commission Flow

1. **Earn** - Commission created with status "pending" when referral converts
2. **Wait** - Net-30 window (commissions stay "pending")
3. **Approve** - After 30 days, job moves to "approved" (eligible for payout)
4. **Request** - Affiliate requests payout via dashboard (minimum $50)
5. **Process** - Manual processing by admin (commission status → "paid")

## Grace Period Flow

1. **Trigger** - Affiliate's Pro subscription expires (payment failure)
2. **Start** - Grace period starts (21 days)
3. **Day 7** - First warning email
4. **Day 14** - Urgent warning (7 days left)
5. **Day 21** - Final notice + forfeit all pending commissions + revoke affiliate status
6. **Resolve** - If payment resolves before Day 21, grace period cleared and affiliate restored

## Troubleshooting

**Commissions not approving?**
- Check job logs for errors
- Verify `earned_at` timestamp is > 30 days ago
- Ensure job ran successfully

**Emails not sending?**
- Verify `RESEND_API_KEY` is set
- Check the Resend dashboard (domain verified, sending logs)
- Review job logs for email errors

**Grace period not working?**
- Verify `paid_until` field in users table is accurate
- Check affiliate status is "at_risk"
- Ensure job is running daily
