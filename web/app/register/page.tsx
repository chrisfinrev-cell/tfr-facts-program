'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { BetaLaunchWizard } from '@/components/BetaLaunchWizard';

function WizardFallback() {
  return (
    <div className="mx-auto max-w-xl p-4 text-sm text-slate-400">
      Loading founding invitation…
    </div>
  );
}

export default function RegisterPage() {
  return (
    <main className="min-h-screen py-10">
      <Suspense fallback={<WizardFallback />}>
        <BetaLaunchWizard />
      </Suspense>
      <p className="mt-6 text-center text-sm text-slate-400">
        Already invited?{' '}
        <Link href="/login" className="text-amber-400 underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
