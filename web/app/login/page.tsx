'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    login.mutate({ email, password });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
      <form onSubmit={onSubmit} className="w-full rounded-xl border border-facts-line bg-facts-card p-8">
        <h1 className="text-2xl font-semibold text-facts-accent">Sign in to FACTS</h1>
        <p className="mt-2 text-sm text-slate-400">Use your beta account email and password.</p>

        <label className="mt-6 block text-sm text-slate-300">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-2 w-full rounded-lg border border-facts-line bg-facts-bg px-3 py-2 text-white"
          />
        </label>

        <label className="mt-4 block text-sm text-slate-300">
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 w-full rounded-lg border border-facts-line bg-facts-bg px-3 py-2 text-white"
          />
        </label>

        {login.isError ? (
          <p className="mt-4 text-sm text-amber-300">Login failed. Check your credentials.</p>
        ) : null}

        <button
          type="submit"
          disabled={login.isPending}
          className="mt-6 w-full rounded-lg bg-facts-action py-3 font-semibold text-white disabled:bg-slate-600"
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="mt-4 text-center text-sm text-slate-400">
          Need an invite?{' '}
          <Link href="/register" className="text-facts-accent underline">
            Register with a code
          </Link>
        </p>
      </form>
    </main>
  );
}
