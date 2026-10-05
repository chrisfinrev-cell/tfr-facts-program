import type { Metadata } from 'next';
import { QueryProvider } from '@/providers/QueryProvider';
import { NdaGate } from '@/components/NdaGate';
import Footer from '@/components/Footer';
import './globals.css';

export const metadata: Metadata = {
  title: 'FACTS Web Beta',
  description: 'Financial Allocation Control & Tracking System'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <QueryProvider>
          <NdaGate>
            <main className="flex-1">{children}</main>
            <Footer />
          </NdaGate>
        </QueryProvider>
      </body>
    </html>
  );
}
