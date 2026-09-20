import { AppShell } from '@/components/app/app-shell';
import { loadInitialData } from '@/lib/data/documents';

// Every render reads the live ledger. Without this, `next build` would run
// Prisma against the production database at build time and prerender stale
// data into the page.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const initialData = await loadInitialData();
  return <AppShell initialData={initialData} />;
}
