'use client';

import React, { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type Tab = 'overview' | 'invites' | 'users' | 'feedback';

type DashboardStats = {
  total_beta_testers?: number;
  total_users?: number;
  total_invites?: number;
  claimed_invites?: number;
  affiliate_conversions?: number;
  open_feedback?: number;
  claim_rate?: number;
};

type InviteRow = {
  id: number;
  code: string;
  sent_to_name?: string | null;
  sent_to_email?: string | null;
  recipient_metadata?: Record<string, unknown> | null;
  claimed_at?: string | null;
  claimed_by_email?: string | null;
  uses_count?: number;
  max_uses?: number;
  parent_code?: string | null;
};

type RelationshipTag = 'STANDARD' | 'FAMILY' | 'CLOSE_CONTACT';

type UserRow = {
  id: number;
  email: string;
  full_name?: string | null;
  affiliate_code?: string | null;
  referral_code?: string | null;
  referred_by_code?: string | null;
  affiliate_tier?: string | null;
  affiliate_status?: 'ACTIVE' | 'EXCLUDED' | string;
  is_affiliate_disabled?: boolean;
  relationship_tag?: RelationshipTag | string | null;
  nda_accepted_at?: string | null;
  is_admin?: boolean;
  is_creator?: boolean;
};

function relationshipBadgeClass(tag?: string | null) {
  switch ((tag || 'STANDARD').toUpperCase()) {
    case 'FAMILY':
      return 'bg-violet-500/15 text-violet-300 border-violet-500/40';
    case 'CLOSE_CONTACT':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
    default:
      return 'bg-slate-700/40 text-slate-400 border-slate-600/50';
  }
}

type FeedbackRow = {
  id: number;
  category?: string;
  message: string;
  status?: string;
  page_url?: string | null;
  user_email?: string | null;
  created_at?: string;
};

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

function metaLabel(meta: Record<string, unknown> | null | undefined) {
  if (!meta || typeof meta !== 'object') return '—';
  const tier = (meta.tier || meta.affiliate_tier || meta.cohort) as string | undefined;
  const campaign = meta.campaign as string | undefined;
  if (tier || campaign) {
    return [tier ? `tier:${tier}` : null, campaign ? `campaign:${campaign}` : null]
      .filter(Boolean)
      .join(' · ');
  }
  return JSON.stringify(meta);
}

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userQuery, setUserQuery] = useState('');
  const [lineageCode, setLineageCode] = useState('');
  const [lineage, setLineage] = useState<{ parent_code: string; referrals: UserRow[] } | null>(null);

  const [inviteForm, setInviteForm] = useState({
    name: '',
    email: '',
    tier: 'VIP',
    campaign: 'cohort_1',
    count: '1',
    parentCode: ''
  });
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const [statsRes, invitesRes, usersRes, feedbackRes] = await Promise.all([
        adminFetch<{ success: boolean; stats: DashboardStats }>('/api/admin/dashboard/stats'),
        adminFetch<{ success: boolean; invites: InviteRow[] }>('/api/admin/dashboard/invites'),
        adminFetch<{ success: boolean; users: UserRow[] }>(
          `/api/admin/dashboard/users${userQuery ? `?q=${encodeURIComponent(userQuery)}` : ''}`
        ),
        adminFetch<{ success: boolean; feedback: FeedbackRow[] }>('/api/admin/dashboard/feedback')
      ]);
      if (statsRes.success) setStats(statsRes.stats);
      if (invitesRes.success) setInvites(invitesRes.invites || []);
      if (usersRes.success) setUsers(usersRes.users || []);
      if (feedbackRes.success) setFeedback(feedbackRes.feedback || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed loading admin data');
    } finally {
      setLoading(false);
    }
  }, [userQuery]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const claimRate = useMemo(() => {
    if (stats?.claim_rate != null) return stats.claim_rate;
    const total = Number(stats?.total_invites || 0);
    const claimed = Number(stats?.claimed_invites || 0);
    return total > 0 ? Number(((claimed / total) * 100).toFixed(1)) : 0;
  }, [stats]);

  async function handleGenerateInvites(e: FormEvent) {
    e.preventDefault();
    setInviteBusy(true);
    setInviteMessage(null);
    try {
      const meta: Record<string, string> = {};
      if (inviteForm.tier.trim()) meta.tier = inviteForm.tier.trim();
      if (inviteForm.campaign.trim()) meta.campaign = inviteForm.campaign.trim();

      const res = await adminFetch<{
        success: boolean;
        message?: string;
        invites?: InviteRow[];
        csv?: string;
      }>('/api/admin/generate-invites', {
        method: 'POST',
        body: JSON.stringify({
          count: Number(inviteForm.count) || 1,
          sentToName: inviteForm.name || undefined,
          sentToEmail: inviteForm.email || undefined,
          parentCode: inviteForm.parentCode || undefined,
          recipientMetadata: meta
        })
      });
      setInviteMessage(res.message || `Created ${res.invites?.length || 0} invite(s).`);
      if (res.csv) {
        const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `invites-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      }
      await loadData();
    } catch (err) {
      setInviteMessage(err instanceof Error ? err.message : 'Invite generation failed');
    } finally {
      setInviteBusy(false);
    }
  }

  async function toggleRole(userId: number, field: 'is_admin' | 'is_creator', value: boolean) {
    try {
      await adminFetch(`/api/admin/dashboard/users/${userId}/roles`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: value })
      });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Role update failed');
    }
  }

  async function handleUpdateTag(userId: number, relationshipTag: string) {
    try {
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, relationship_tag: relationshipTag } : u))
      );
      await adminFetch(`/api/admin/dashboard/users/${userId}/relationship-tag`, {
        method: 'PATCH',
        body: JSON.stringify({ relationshipTag })
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Relationship tag update failed');
      await loadData();
    }
  }

  async function handleAffiliateStatus(userId: number, status: 'ACTIVE' | 'EXCLUDED') {
    try {
      setUsers((prev) =>
        prev.map((u) =>
          u.id === userId
            ? {
                ...u,
                affiliate_status: status,
                affiliate_tier: status === 'EXCLUDED' ? 'EXCLUDED' : u.affiliate_tier === 'EXCLUDED' ? 'STANDARD' : u.affiliate_tier,
                is_affiliate_disabled: status === 'EXCLUDED'
              }
            : u
        )
      );
      await adminFetch(`/api/admin/dashboard/users/${userId}/affiliate-status`, {
        method: 'PATCH',
        body: JSON.stringify({ status })
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Affiliate status update failed');
      await loadData();
    }
  }

  async function loadLineage() {
    const code = lineageCode.trim();
    if (!code) return;
    try {
      const res = await adminFetch<{
        success: boolean;
        parent_code: string;
        referrals: UserRow[];
      }>(`/api/admin/dashboard/lineage/${encodeURIComponent(code)}`);
      setLineage({ parent_code: res.parent_code, referrals: res.referrals || [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lineage lookup failed');
    }
  }

  if (loading) {
    return <div className="p-8 text-slate-300">Loading Admin Command Center…</div>;
  }

  return (
    <div className="min-h-screen bg-[#07090f] px-4 py-6 text-slate-100 md:px-8">
      <header className="mb-8 flex flex-col gap-4 border-b border-slate-800 pb-5 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.22em] text-amber-400/80">
            The Financial Revolution™ / FACTS™
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white">
            T-Dagsis Admin Console
          </h1>
          <p className="mt-1 text-sm text-slate-400">Beta ops · invites · lineage · feedback</p>
        </div>

        <nav className="flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-950/80 p-1">
          {(['overview', 'invites', 'users', 'feedback'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`rounded-lg px-3 py-2 text-xs font-medium capitalize transition ${
                activeTab === tab
                  ? 'bg-amber-500 text-black'
                  : 'text-slate-400 hover:bg-slate-900 hover:text-white'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </header>

      {error ? (
        <div className="mb-4 rounded-lg border border-red-500/40 bg-red-950/40 px-4 py-3 text-sm text-red-200">
          {error}{' '}
          <button type="button" className="underline" onClick={() => void loadData()}>
            Retry
          </button>
        </div>
      ) : null}

      {activeTab === 'overview' && (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {[
            { label: 'Total Testers', value: stats?.total_beta_testers ?? stats?.total_users ?? 0 },
            { label: 'Invites Issued', value: stats?.total_invites ?? 0 },
            { label: 'Invites Claimed', value: stats?.claimed_invites ?? 0, tone: 'text-emerald-400' },
            { label: 'Claim Rate', value: `${claimRate}%`, tone: 'text-sky-400' },
            { label: 'Open Feedback', value: stats?.open_feedback ?? 0, tone: 'text-amber-400' }
          ].map((card) => (
            <article
              key={card.label}
              className="rounded-2xl border border-slate-800 bg-gradient-to-b from-slate-900 to-slate-950 p-4"
            >
              <p className="text-xs font-medium text-slate-400">{card.label}</p>
              <p className={`mt-2 text-3xl font-semibold ${card.tone || 'text-white'}`}>{card.value}</p>
            </article>
          ))}
        </section>
      )}

      {activeTab === 'invites' && (
        <section className="space-y-4">
          <form
            onSubmit={handleGenerateInvites}
            className="grid gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 md:grid-cols-6"
          >
            <h2 className="md:col-span-6 text-sm font-semibold text-slate-200">Generate Targeted Invites</h2>
            <input
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              placeholder="Recipient name"
              value={inviteForm.name}
              onChange={(e) => setInviteForm((s) => ({ ...s, name: e.target.value }))}
            />
            <input
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm md:col-span-2"
              placeholder="Recipient email"
              value={inviteForm.email}
              onChange={(e) => setInviteForm((s) => ({ ...s, email: e.target.value }))}
            />
            <input
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              placeholder="Tier"
              value={inviteForm.tier}
              onChange={(e) => setInviteForm((s) => ({ ...s, tier: e.target.value }))}
            />
            <input
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              placeholder="Campaign"
              value={inviteForm.campaign}
              onChange={(e) => setInviteForm((s) => ({ ...s, campaign: e.target.value }))}
            />
            <input
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              placeholder="Count"
              value={inviteForm.count}
              onChange={(e) => setInviteForm((s) => ({ ...s, count: e.target.value }))}
            />
            <input
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm md:col-span-2"
              placeholder="Parent / lineage code (optional)"
              value={inviteForm.parentCode}
              onChange={(e) => setInviteForm((s) => ({ ...s, parentCode: e.target.value }))}
            />
            <button
              type="submit"
              disabled={inviteBusy}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-60"
            >
              {inviteBusy ? 'Generating…' : 'Create Invite Codes'}
            </button>
            <a
              href="/api/admin/dashboard/invites.csv"
              className="rounded-lg border border-slate-600 px-4 py-2 text-center text-sm text-slate-200 hover:bg-slate-900"
            >
              Export CSV
            </a>
            {inviteMessage ? (
              <p className="md:col-span-6 text-xs text-slate-300">{inviteMessage}</p>
            ) : null}
          </form>

          <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/70">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="border-b border-slate-800 bg-black/40 text-slate-400">
                <tr>
                  <th className="p-3">Invite Code</th>
                  <th className="p-3">Recipient</th>
                  <th className="p-3">Email</th>
                  <th className="p-3">Metadata / Tier</th>
                  <th className="p-3">Claim Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {invites.map((inv) => (
                  <tr key={inv.id} className="hover:bg-slate-900/60">
                    <td className="p-3 font-mono text-sky-400">{inv.code}</td>
                    <td className="p-3">{inv.sent_to_name || 'Unassigned'}</td>
                    <td className="p-3">{inv.sent_to_email || '—'}</td>
                    <td className="p-3 font-mono text-[11px] text-slate-400">
                      {metaLabel(inv.recipient_metadata)}
                    </td>
                    <td className="p-3">
                      {inv.claimed_at ? (
                        <span className="font-medium text-emerald-400">
                          Claimed ({inv.claimed_by_email})
                        </span>
                      ) : (
                        <span className="text-slate-500">Unclaimed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeTab === 'users' && (
        <section className="space-y-4">
          <div className="flex flex-col gap-3 md:flex-row">
            <input
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
              placeholder="Search email, name, affiliate code…"
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
            />
            <div className="flex gap-2">
              <input
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
                placeholder="Lineage code"
                value={lineageCode}
                onChange={(e) => setLineageCode(e.target.value)}
              />
              <button
                type="button"
                onClick={() => void loadLineage()}
                className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-200"
              >
                View Lineage
              </button>
            </div>
          </div>

          {lineage ? (
            <div className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 text-xs">
              <p className="mb-2 font-semibold text-slate-200">
                Lineage for <span className="font-mono text-sky-400">{lineage.parent_code}</span>
              </p>
              {lineage.referrals.length === 0 ? (
                <p className="text-slate-500">No child referrals found.</p>
              ) : (
                <ul className="space-y-1">
                  {lineage.referrals.map((r) => (
                    <li key={r.id} className="text-slate-300">
                      {r.email} · {r.affiliate_code || r.referral_code || '—'} ·{' '}
                      {r.affiliate_tier || 'STANDARD'}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/70">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="border-b border-slate-800 bg-black/40 text-slate-400">
                <tr>
                  <th className="p-3">User</th>
                  <th className="p-3">Affiliate Code</th>
                  <th className="p-3">Referred By</th>
                  <th className="p-3">Tier</th>
                  <th className="p-3">Affiliate Status</th>
                  <th className="p-3">Relationship Tag</th>
                  <th className="p-3">Roles</th>
                  <th className="p-3">NDA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-900/60">
                    <td className="p-3">
                      <div className="font-medium text-white">{u.email}</div>
                      <div className="text-[11px] text-slate-500">{u.full_name || '—'}</div>
                    </td>
                    <td className="p-3 font-mono text-sky-400">{u.affiliate_code || u.referral_code || '—'}</td>
                    <td className="p-3 font-mono text-slate-400">{u.referred_by_code || 'Root'}</td>
                    <td className="p-3 font-semibold text-amber-400">{u.affiliate_tier || 'STANDARD'}</td>
                    <td className="p-3">
                      <select
                        value={
                          u.affiliate_status === 'EXCLUDED' || u.affiliate_tier === 'EXCLUDED'
                            ? 'EXCLUDED'
                            : 'ACTIVE'
                        }
                        onChange={(e) =>
                          void handleAffiliateStatus(u.id, e.target.value as 'ACTIVE' | 'EXCLUDED')
                        }
                        className={`rounded border px-2 py-1 text-xs font-semibold ${
                          u.affiliate_status === 'EXCLUDED' || u.affiliate_tier === 'EXCLUDED'
                            ? 'border-rose-500/40 bg-rose-950/40 text-rose-300'
                            : 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300'
                        }`}
                      >
                        <option value="ACTIVE">Active</option>
                        <option value="EXCLUDED">Excluded</option>
                      </select>
                    </td>
                    <td className="p-3">
                      <div className="flex flex-col gap-1.5">
                        <span
                          className={`inline-flex w-fit rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${relationshipBadgeClass(u.relationship_tag)}`}
                        >
                          {(u.relationship_tag || 'STANDARD').replace('_', ' ')}
                        </span>
                        <select
                          value={u.relationship_tag || 'STANDARD'}
                          onChange={(e) => void handleUpdateTag(u.id, e.target.value)}
                          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs font-medium text-slate-200"
                        >
                          <option value="STANDARD">Standard (No Tag)</option>
                          <option value="FAMILY">Family Member</option>
                          <option value="CLOSE_CONTACT">Close Contact</option>
                        </select>
                      </div>
                    </td>
                    <td className="p-3">
                      <label className="mr-3 inline-flex items-center gap-1 text-[11px] text-slate-300">
                        <input
                          type="checkbox"
                          checked={!!u.is_admin}
                          onChange={(e) => void toggleRole(u.id, 'is_admin', e.target.checked)}
                        />
                        admin
                      </label>
                      <label className="inline-flex items-center gap-1 text-[11px] text-slate-300">
                        <input
                          type="checkbox"
                          checked={!!u.is_creator}
                          onChange={(e) => void toggleRole(u.id, 'is_creator', e.target.checked)}
                        />
                        creator
                      </label>
                    </td>
                    <td className="p-3">
                      <div className="text-[11px] text-slate-500">
                        {u.nda_accepted_at
                          ? new Date(u.nda_accepted_at).toLocaleString()
                          : 'Not signed'}
                      </div>
                      <a
                        href={`/api/v1/nda/download-pdf?userId=${u.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sky-400 hover:underline"
                      >
                        Download PDF
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeTab === 'feedback' && (
        <section className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/70">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="border-b border-slate-800 bg-black/40 text-slate-400">
              <tr>
                <th className="p-3">When</th>
                <th className="p-3">User</th>
                <th className="p-3">Category</th>
                <th className="p-3">Status</th>
                <th className="p-3">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {feedback.length === 0 ? (
                <tr>
                  <td className="p-4 text-slate-500" colSpan={5}>
                    No feedback submissions yet.
                  </td>
                </tr>
              ) : (
                feedback.map((f) => (
                  <tr key={f.id} className="hover:bg-slate-900/60 align-top">
                    <td className="p-3 whitespace-nowrap text-slate-500">
                      {f.created_at ? new Date(f.created_at).toLocaleString() : '—'}
                    </td>
                    <td className="p-3">{f.user_email || '—'}</td>
                    <td className="p-3 capitalize">{f.category || 'bug'}</td>
                    <td className="p-3 text-amber-400">{f.status || 'open'}</td>
                    <td className="p-3 max-w-xl">
                      <p className="whitespace-pre-wrap text-slate-200">{f.message}</p>
                      {f.page_url ? (
                        <p className="mt-1 font-mono text-[11px] text-slate-500">{f.page_url}</p>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
