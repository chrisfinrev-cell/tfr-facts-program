'use client';

import { useQuery } from '@tanstack/react-query';
import { LogOut } from 'lucide-react';
import { DownloadNdaButton } from '@/components/DownloadNdaButton';
import { PlaidLinkButton } from '@/components/PlaidLinkButton';
import { useAuth } from '@/hooks/useAuth';
import { api, apiRoutes } from '@/lib/api';
import { formatCents, normalizeBuckets } from '@/lib/buckets';

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const buckets = useQuery({
    queryKey: ['engine', 'transactions'],
    queryFn: async () => {
      const { data } = await api.get(apiRoutes.buckets);
      return normalizeBuckets(data);
    }
  });

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
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

      <section className="grid gap-4 md:grid-cols-2">
        {(buckets.data || []).map((bucket) => {
          const used = bucket.deposited_cents > 0
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
    </main>
  );
}
