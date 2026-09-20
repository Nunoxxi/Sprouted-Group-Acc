import './globals.css';
import type { Metadata } from 'next';

// The nightly export scheduler starts from src/instrumentation.ts at server
// boot, not from a request.

export const metadata: Metadata = {
  title: 'Sprouted Group',
  description: 'Multi-entity accounting workspace for Sprouted Group.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
