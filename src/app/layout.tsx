import './globals.css';
import type { Metadata } from 'next';

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
