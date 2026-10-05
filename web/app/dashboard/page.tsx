'use client';

import { useQuery } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { DownloadNdaButton } from '@/components/DownloadNdaButton';
import { PlaidLinkButton } from '@/components/PlaidLinkButton';
import { Sidebar } from '@/components/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { api, apiRoutes } from '@/lib/api';
import { formatCents, normalizeBuckets } from '@/lib/buckets';

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const affiliateExcluded =
    user?.affiliate_tier === 'EXCLUDED' ||
    user?.is_affiliate_disabled === true ||
    user?.affiliate_eligible === false;

  const buckets = useQuery({
    queryKey: ['engine', 'transactions'],
    queryFn: async () => {
      const { data } = await api.get(apiRoutes.buckets);
      return normalizeBuckets(data);
    }
  });

  return (
    <div className="flex min-h-screen flex-col bg-[#07090f] text-slate-100 md:flex-row">
      <Sidebar />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 md:px-8">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-wide text-slate-400">FACTS Web Beta</p>
            <h1 className="text-3xl font-semibold text-white">Allocation dashboard</h1>
            <p className="mt-1 text-slate-400">{user?.email}</p>
          </div>
          <div className="flex items-center gap-3">
            {user?.id ? <DownloadNdaButton userId={String(user.id)} /> : null}
            <PlaidLinkButton />
            <button
              type="button"
              onClick={() => logout.mutate()}
              className="inline-flex items-center gap-2 rounded-lg border border-facts-line px-4 py-2.5 text-sm text-slate-200"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </div>
        </header>

        {!affiliateExcluded ? (
          <section className="mb-6 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-100/90">
            <p className="font-semibold text-amber-300">Future Generation referral</p>
            <p className="mt-1 font-mono text-xs text-slate-300">
              {user?.referral_code || 'Referral code pending'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Share your code to earn standard affiliate commissions when invited members subscribe.
            </p>
          </section>
        ) : null}

        <section id="buckets" className="grid gap-4 md:grid-cols-2">
          {(buckets.data || []).map((bucket) => {
            const used =
              bucket.deposited_cents > 0
                ? Math.min(100, Math.round((bucket.spent_cents / bucket.deposited_cents) * 100))
                : 0;
            return (
              <article key={bucket.slug} className="rounded-xl border border-facts-line bg-facts-card p-5">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-white">{bucket.name}</h2>
                  <span className="text-sm text-facts-accent">{bucket.target_pct}%</span>
                </div>
                <p className="mt-3 text-2xl font-semibold">{formatCents(bucket.remaining_cents)}</p>
                <p className="text-sm text-slate-400">
                  Remaining · deposited {formatCents(bucket.deposited_cents)}
                </p>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full bg-facts-accent" style={{ width: `${used}%` }} />
                </div>
              </article>
            );
          })}
        </section>

        <section id="modules" className="mt-8 rounded-xl border border-slate-800 bg-slate-950/60 p-5">
          <h2 className="text-sm font-semibold text-slate-200">Core program modules</h2>
          <p className="mt-1 text-xs text-slate-500">
            Focused financial planning tools — budgeting, allocation, and sovereignty modules.
            {affiliateExcluded
              ? ' Affiliate / commission surfaces are disabled for this account.'
              : ''}
          </p>
        </section>
      </main>
    </div>
  );
}
