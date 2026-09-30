'use client';

import React from 'react';
import { FileDown } from 'lucide-react';

export const DownloadNdaButton: React.FC<{ userId: string }> = ({ userId }) => {
  const handleDownload = () => {
    window.open(`/api/v1/nda/download-pdf?userId=${userId}`, '_blank');
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-200 transition-colors hover:border-amber-400 hover:text-white"
    >
      <FileDown className="h-4 w-4 text-amber-400" />
      Download Signed NDA Document (PDF)
    </button>
  );
};
