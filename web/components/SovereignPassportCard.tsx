'use client';

import { Award, Check, ShieldCheck } from 'lucide-react';
import { DownloadNdaButton } from './DownloadNdaButton';

type SovereignPassportCardProps = {
  founderName: string;
  founderNumber: number;
  userId?: string | number;
  sovereignScore: number;
  targetMonthsToIndependence: number;
  onEnterWorkspace?: () => void;
};

export function SovereignPassportCard({
  founderName,
  founderNumber,
  userId,
  sovereignScore,
  targetMonthsToIndependence,
  onEnterWorkspace
}: SovereignPassportCardProps) {
  const serial = String(founderNumber).padStart(4, '0');

  return (
    <div className="rounded-3xl border border-amber-500/30 bg-gradient-to-b from-slate-950 to-slate-900 p-6 shadow-xl">
      <div className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-400">
          <ShieldCheck className="h-4 w-4" />
          Sovereign Passport
        </div>
        <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-400">
          Issued
        </span>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-950/80 p-5">
        <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Founding member</p>
        <h2 className="mt-1 text-2xl font-bold text-white">{founderName}</h2>
        <p className="mt-1 font-mono text-sm text-amber-400">FACTS-{serial}</p>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Sovereign score</p>
            <p className="mt-1 text-2xl font-bold text-white">{sovereignScore}</p>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900 p-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Independence</p>
            <p className="mt-1 text-2xl font-bold text-white">{targetMonthsToIndependence} mo</p>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-2 text-xs text-emerald-400">
          <Check className="h-4 w-4" />
          Beta access granted. Allocation workspace is unlocked.
        </div>
        {userId ? (
          <div className="mt-4">
            <DownloadNdaButton userId={String(userId)} />
          </div>
        ) : null}
      </div>

      {onEnterWorkspace ? (
        <button
          type="button"
          onClick={onEnterWorkspace}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 py-3.5 text-sm font-bold text-slate-950 hover:bg-amber-300"
        >
          <Award className="h-4 w-4" />
          Enter FACTS Workspace
        </button>
      ) : null}
    </div>
  );
}
