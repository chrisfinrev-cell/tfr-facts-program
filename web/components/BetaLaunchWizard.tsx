'use client';

import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ShieldCheck,
  FileText,
  CheckCircle2,
  Lock,
  ArrowRight,
  Sparkles,
  User
} from 'lucide-react';
import { SovereignPassportCard } from './SovereignPassportCard';

// SETTING THIS TO 'false' DISABLES THE NDA STEP FOR POST-BETA LAUNCH
const IS_BETA_MODE = true;

type Step = 'code' | 'nda' | 'profile' | 'passport';

export const BetaLaunchWizard: React.FC = () => {
  const searchParams = useSearchParams();
  const [currentStep, setCurrentStep] = useState<Step>('code');

  const [formData, setFormData] = useState({
    referralCode: '',
    fullName: '',
    email: '',
    ndaAccepted: false,
    ndaSignature: '',
    primaryPriority: 'Eliminate High-Interest Credit Card Debt'
  });

  const [issuedPassport, setIssuedPassport] = useState<{
    founderName: string;
    founderNumber: number;
    sovereignScore: number;
    targetMonthsToIndependence: number;
  } | null>(null);

  useEffect(() => {
    const codeFromUrl = searchParams.get('ref') || searchParams.get('code');
    const storedCode = sessionStorage.getItem('facts_ref_code');
    const finalCode = codeFromUrl || storedCode || '';

    if (codeFromUrl) {
      sessionStorage.setItem('facts_ref_code', codeFromUrl);
    }

    if (finalCode) {
      setFormData((prev) => ({ ...prev, referralCode: finalCode }));
    }
  }, [searchParams]);

  const handleNextFromCode = () => {
    if (IS_BETA_MODE) {
      setCurrentStep('nda');
    } else {
      setCurrentStep('profile');
    }
  };

  const handleCompleteOnboarding = async () => {
    const mockResponse = {
      founderName: formData.fullName || 'Founding Member',
      founderNumber: 42,
      sovereignScore: 28,
      targetMonthsToIndependence: 36
    };

    setIssuedPassport(mockResponse);
    setCurrentStep('passport');
  };

  return (
    <div className="mx-auto max-w-xl p-4 text-slate-100">
      {currentStep !== 'passport' && (
        <div className="mb-8 flex items-center justify-between text-xs font-semibold text-slate-400">
          <span className={currentStep === 'code' ? 'font-bold text-amber-400' : ''}>
            1. Access Code
          </span>
          <div className="mx-2 h-[1px] flex-1 bg-slate-800" />

          {IS_BETA_MODE && (
            <>
              <span className={currentStep === 'nda' ? 'font-bold text-amber-400' : ''}>
                2. Beta NDA
              </span>
              <div className="mx-2 h-[1px] flex-1 bg-slate-800" />
            </>
          )}

          <span className={currentStep === 'profile' ? 'font-bold text-amber-400' : ''}>
            {IS_BETA_MODE ? '3. Account Setup' : '2. Account Setup'}
          </span>
        </div>
      )}

      {currentStep === 'code' && (
        <div className="rounded-3xl border border-slate-800 bg-slate-950 p-6 shadow-xl">
          <div className="mb-6 flex items-center gap-3">
            <div className="rounded-xl bg-amber-500/10 p-2.5 text-amber-400">
              <Lock className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Private Access Link</h2>
              <p className="text-xs text-slate-400">Enter or verify your founding invitation code.</p>
            </div>
          </div>

          <div className="mb-6">
            <label className="mb-2 block text-xs font-semibold text-slate-300">
              Referral / Invite Code
            </label>
            {formData.referralCode ? (
              <div className="flex items-center justify-between rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3 text-sm text-emerald-400">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span className="font-mono font-bold tracking-wider">{formData.referralCode}</span>
                </div>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-500/80">
                  Auto-Verified
                </span>
              </div>
            ) : (
              <input
                type="text"
                value={formData.referralCode}
                onChange={(e) => setFormData((prev) => ({ ...prev, referralCode: e.target.value }))}
                placeholder="e.g. SOVEREIGN-2026"
                className="w-full rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm text-white focus:border-amber-400 focus:outline-none"
              />
            )}
          </div>

          <button
            type="button"
            onClick={handleNextFromCode}
            disabled={!formData.referralCode}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 py-3.5 text-sm font-bold text-slate-950 transition-colors hover:bg-amber-300 disabled:opacity-50"
          >
            Continue <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {currentStep === 'nda' && IS_BETA_MODE && (
        <div className="rounded-3xl border border-amber-500/30 bg-slate-950 p-6 shadow-xl">
          <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-4">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-400">
              <FileText className="h-4 w-4" />
              <ShieldCheck className="h-4 w-4" /> Beta Participant Agreement
            </div>
            <span className="rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-400">
              Confidential
            </span>
          </div>

          <p className="mb-3 text-xs text-slate-300">
            As an early pioneer, you will receive unreleased access to proprietary dynamic bucket modeling tools and debt resolution algorithms.
          </p>

          <div className="mb-4 max-h-48 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 p-4 text-xs leading-relaxed text-slate-400">
            <h4 className="mb-2 font-bold text-slate-200">1. Non-Disclosure & Confidentiality</h4>
            <p className="mb-3">
              You agree that all software interfaces, scoring calculations, financial logic models, and feature sets made available during this closed beta test are the intellectual property of T-Dagsis LLC and are strictly confidential.
            </p>
            <h4 className="mb-2 font-bold text-slate-200">2. Feedback & Data Usage</h4>
            <p>
              Feedback provided during this testing window may be used to improve the Sovereign application platform. Confidential user data remains encrypted and sovereign to your account.
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-300">
                Digital Signature (Full Legal Name)
              </label>
              <input
                type="text"
                value={formData.ndaSignature}
                onChange={(e) => setFormData((prev) => ({ ...prev, ndaSignature: e.target.value }))}
                placeholder="Type full legal name to sign"
                className="w-full rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm text-white focus:border-amber-400 focus:outline-none"
              />
            </div>

            <label className="flex cursor-pointer items-center gap-3">
              <input
                type="checkbox"
                checked={formData.ndaAccepted}
                onChange={(e) => setFormData((prev) => ({ ...prev, ndaAccepted: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-800 bg-slate-900 text-amber-400 focus:ring-amber-400"
              />
              <span className="text-xs text-slate-300">
                I agree to the terms of the Confidential Beta Test Agreement.
              </span>
            </label>
          </div>

          <button
            type="button"
            onClick={() => setCurrentStep('profile')}
            disabled={!formData.ndaAccepted || !formData.ndaSignature}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 py-3.5 text-sm font-bold text-slate-950 transition-colors hover:bg-amber-300 disabled:opacity-50"
          >
            Accept & Proceed to Setup <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {currentStep === 'profile' && (
        <div className="rounded-3xl border border-slate-800 bg-slate-950 p-6 shadow-xl">
          <div className="mb-6 flex items-center gap-3">
            <div className="rounded-xl bg-amber-500/10 p-2.5 text-amber-400">
              <User className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Create Your Founder Account</h2>
              <p className="text-xs text-slate-400">Establish your profile to calculate your baseline.</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-300">Full Name</label>
              <input
                type="text"
                value={formData.fullName}
                onChange={(e) => setFormData((prev) => ({ ...prev, fullName: e.target.value }))}
                placeholder="Alexander Vance"
                className="w-full rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm text-white focus:border-amber-400 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-slate-300">Email Address</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData((prev) => ({ ...prev, email: e.target.value }))}
                placeholder="vance@domain.com"
                className="w-full rounded-xl border border-slate-800 bg-slate-900 p-3 text-sm text-white focus:border-amber-400 focus:outline-none"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleCompleteOnboarding}
            disabled={!formData.fullName || !formData.email}
            className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-400 py-3.5 text-sm font-bold text-slate-950 transition-colors hover:bg-amber-300 disabled:opacity-50"
          >
            Generate Sovereign Passport <Sparkles className="h-4 w-4" />
          </button>
        </div>
      )}

      {currentStep === 'passport' && issuedPassport && (
        <SovereignPassportCard
          founderName={issuedPassport.founderName}
          founderNumber={issuedPassport.founderNumber}
          sovereignScore={issuedPassport.sovereignScore}
          targetMonthsToIndependence={issuedPassport.targetMonthsToIndependence}
        />
      )}
    </div>
  );
};
