import { redirect } from 'next/navigation';

import { AppShell } from '@/components/app/app-shell';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { mustSetUpTwoFactor } from '@/lib/authz';
import { getPrincipal } from '@/lib/dal';
import { loadInitialData } from '@/lib/data/documents';

// Everything on this page is per-user and per-request. No caching, no
// prerendering — and no build-time database access.
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const principal = await getPrincipal();
  if (!principal) {
    redirect('/sign-in');
  }
  // Roles that can post transactions do nothing else until TOTP is set up.
  if (mustSetUpTwoFactor(principal)) {
    redirect('/two-factor/setup');
  }

  const initialData = await loadInitialData(principal);
  if (initialData.entities.length === 0) {
    return <NoEntityAccess name={principal.name} />;
  }

  return <AppShell initialData={initialData} />;
}

function NoEntityAccess({ name }: { name: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-sand-50 p-6 text-slate-900">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-soft">
        <h1 className="text-xl font-semibold">Nothing to show yet</h1>
        <p className="mt-3 text-sm text-slate-600">
          {name}, your account is active but has not been given access to any entity. Ask an Owner to grant you access
          to the companies you work with.
        </p>
        <div className="mt-6">
          <SignOutButton className="text-sm font-medium text-brand-800 underline" />
        </div>
      </div>
    </main>
  );
}
