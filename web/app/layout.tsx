import type { Metadata } from 'next';
import { QueryProvider } from '@/providers/QueryProvider';
import { NdaGate } from '@/components/NdaGate';
import './globals.css';

export const metadata: Metadata = {
  title: 'FACTS Web Beta',
  description: 'Financial Allocation Control & Tracking System'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <QueryProvider>
          <NdaGate>{children}</NdaGate>
        </QueryProvider>
      </body>
    </html>
  );
}
