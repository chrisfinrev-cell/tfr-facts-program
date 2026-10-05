'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Wallet,
  BookOpen,
  Users,
  Settings,
  Shield
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  affiliateOnly?: boolean;
  adminOnly?: boolean;
};

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Allocation', icon: LayoutDashboard },
  { href: '/dashboard#buckets', label: 'Buckets & Planning', icon: Wallet },
  { href: '/dashboard#modules', label: 'Program Modules', icon: BookOpen },
  {
    href: '/future-generations',
    label: 'Future Generation',
    icon: Users,
    affiliateOnly: true
  },
  { href: '/admin/dashboard', label: 'Admin Console', icon: Shield, adminOnly: true },
  { href: '/settings', label: 'Settings', icon: Settings }
];

export function Sidebar() {
  const pathname = usePathname();
  const { user } = useAuth();
  const affiliateExcluded =
    user?.affiliate_tier === 'EXCLUDED' ||
    user?.is_affiliate_disabled === true ||
    user?.affiliate_eligible === false;
  const isAdmin = Boolean(user?.is_admin);

  const items = NAV.filter((item) => {
    if (item.affiliateOnly && affiliateExcluded) return false;
    if (item.adminOnly && !isAdmin) return false;
    return true;
  });

  return (
    <aside className="w-full border-b border-slate-800 bg-slate-950/80 md:w-56 md:border-b-0 md:border-r md:min-h-[calc(100vh-1px)]">
      <div className="px-4 py-5">
        <p className="text-[10px] uppercase tracking-[0.2em] text-amber-400/80">FACTS™</p>
        <p className="mt-1 text-sm font-semibold text-white">Financial Console</p>
        {affiliateExcluded ? (
          <p className="mt-2 text-[11px] leading-snug text-slate-500">
            Personal testing mode — affiliate program hidden.
          </p>
        ) : null}
      </div>
      <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:overflow-visible md:px-3">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium transition ${
                active
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'text-slate-400 hover:bg-slate-900 hover:text-white'
              }`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
