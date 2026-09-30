'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { Landmark, LoaderCircle } from 'lucide-react';
import { api, apiRoutes } from '@/lib/api';

type PlaidLinkButtonProps = {
  onLinked?: () => void;
  className?: string;
};

async function createLinkToken(): Promise<string> {
  try {
    const { data } = await api.post<{ link_token: string }>(apiRoutes.plaidCreateLinkToken);
    return data.link_token;
  } catch {
    const { data } = await api.post<{ link_token: string }>(apiRoutes.plaidCreateLinkTokenV1);
    return data.link_token;
  }
}

async function exchangePublicToken(publicToken: string): Promise<void> {
  try {
    await api.post(apiRoutes.plaidExchangeToken, { public_token: publicToken });
  } catch {
    await api.post(apiRoutes.plaidExchangeTokenV1, { public_token: publicToken });
  }
}

export function PlaidLinkButton({ onLinked, className }: PlaidLinkButtonProps) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSuccess = useCallback(
    async (publicToken: string) => {
      setBusy(true);
      setError(null);
      try {
        await exchangePublicToken(publicToken);
        onLinked?.();
      } catch {
        setError('Could not connect the bank account.');
      } finally {
        setBusy(false);
        setLinkToken(null);
      }
    },
    [onLinked]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess
  });

  async function startLink() {
    setBusy(true);
    setError(null);
    try {
      const token = await createLinkToken();
      setLinkToken(token);
    } catch {
      setError('Could not start Plaid Link.');
      setBusy(false);
    }
  }

  useEffect(() => {
    if (linkToken && ready) {
      open();
      setBusy(false);
    }
  }, [linkToken, ready, open]);

  return (
    <div>
      <button
        type="button"
        onClick={startLink}
        disabled={busy}
        className={
          className
          || 'inline-flex items-center gap-2 rounded-lg bg-facts-action px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-800 disabled:cursor-not-allowed disabled:bg-slate-600'
        }
      >
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Landmark className="h-4 w-4" />}
        Connect bank
      </button>
      {error ? <p className="mt-2 text-sm text-amber-300">{error}</p> : null}
    </div>
  );
}
