import './globals.css';
import type { Metadata } from 'next';

// The nightly backup scheduler starts lazily on the first request to
// /api/backups (GET or POST), which the Settings page calls on load. This
// keeps it out of the build/prerender path.

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
