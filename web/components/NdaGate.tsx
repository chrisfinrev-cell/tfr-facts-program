'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';

const PUBLIC_PATHS = new Set(['/login', '/register']);
const WIZARD_PATHS = new Set(['/register']);

export function NdaGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isLoading, isAuthenticated, ndaAccepted } = useAuth();

  useEffect(() => {
    if (isLoading) return;

    if (!isAuthenticated && !PUBLIC_PATHS.has(pathname)) {
      router.replace('/login');
      return;
    }

    if (isAuthenticated && !ndaAccepted && pathname !== '/nda' && !WIZARD_PATHS.has(pathname)) {
      router.replace('/nda');
      return;
    }

    if (isAuthenticated && ndaAccepted && (pathname === '/nda' || pathname === '/login')) {
      router.replace('/dashboard');
    }
  }, [isAuthenticated, isLoading, ndaAccepted, pathname, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        Loading FACTS…
      </div>
    );
  }

  return <>{children}</>;
}
