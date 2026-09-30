'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';

export default function NdaPage() {
  const { acceptNda } = useAuth();
  const [checked, setChecked] = useState(false);
  const [typedSignature, setTypedSignature] = useState('');

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl items-center px-4 py-10">
      <section className="w-full rounded-xl border border-facts-line bg-facts-card p-8">
        <h1 className="text-2xl font-semibold text-facts-accent">Beta Tester Non-Disclosure Agreement</h1>
        <p className="mt-2 text-slate-300">
          Review and accept the confidentiality terms before accessing the FACTS program.
        </p>

        <div className="mt-6 h-80 overflow-y-auto rounded-lg border border-facts-line bg-facts-bg p-5 text-sm leading-6 text-slate-300">
          <h2 className="mb-3 font-semibold text-white">Confidentiality and Non-Disclosure</h2>
          <p className="mb-4">
            <strong>1. Confidential information.</strong> Software, allocation logic, schemas, interfaces, and
            workflows are trade secrets of the Company.
          </p>
          <p className="mb-4">
            <strong>2. Non-disclosure.</strong> You may not publish, stream, screenshot, or disseminate the Software
            without prior written consent.
          </p>
          <p className="mb-4">
            <strong>3. Reverse engineering.</strong> You may not decompile, reverse-engineer, or build competing tools
            from the Software.
          </p>
          <p>
            <strong>4. Governing law.</strong> This agreement is governed by the laws of the State of Wyoming.
          </p>
        </div>

        <label className="mt-6 block text-sm text-slate-200">
          Digital signature (full legal name)
          <input
            type="text"
            value={typedSignature}
            onChange={(event) => setTypedSignature(event.target.value)}
            placeholder="Type your full legal name"
            className="mt-2 w-full rounded-lg border border-facts-line bg-facts-bg px-3 py-2 text-white"
          />
        </label>

        <label className="mt-6 flex items-center gap-3 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          I have read, understand, and agree to the Non-Disclosure Agreement.
        </label>

        <button
          type="button"
          disabled={!checked || !typedSignature.trim() || acceptNda.isPending}
          onClick={() => acceptNda.mutate({ typedSignature: typedSignature.trim() })}
          className="mt-6 w-full rounded-lg bg-facts-action py-3 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-600"
        >
          {acceptNda.isPending ? 'Verifying…' : 'I Accept — Continue to workspace'}
        </button>
      </section>
    </main>
  );
}
