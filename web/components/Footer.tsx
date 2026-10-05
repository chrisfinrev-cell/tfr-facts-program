import Link from 'next/link';

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="w-full border-t border-gray-800 bg-gray-950 px-4 py-6 text-xs text-gray-400">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 md:flex-row">
        <div className="space-y-1 text-center md:text-left">
          <p className="font-semibold text-gray-200">
            © {currentYear} T-Dagsis LLC. All Rights Reserved.
          </p>
          <p className="max-w-2xl text-[11px] leading-relaxed text-gray-400">
            PROPRIETARY AND CONFIDENTIAL. The FACTS Program and Sovereign application are the exclusive
            intellectual property of T-Dagsis LLC. Reverse engineering, decompilation, disassembly,
            extraction, or unauthorized distribution of source code, models, or core logic is strictly
            prohibited and governed by Beta Non-Disclosure and IP Licensing Agreements.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-[11px]">
          <Link href="/terms-of-service.html" className="hover:text-white hover:underline">
            Terms of Service
          </Link>
          <span>•</span>
          <Link href="/nda" className="hover:text-white hover:underline">
            Beta NDA
          </Link>
          <span>•</span>
          <Link href="/privacy-policy.html" className="hover:text-white hover:underline">
            Legal Disclaimer
          </Link>
        </div>
      </div>
    </footer>
  );
}
