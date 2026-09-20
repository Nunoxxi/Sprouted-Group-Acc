import Link from 'next/link';
import { redirect } from 'next/navigation';

import { SignOutButton } from '@/components/auth/sign-out-button';
import { can, mustSetUpTwoFactor } from '@/lib/authz';
import { getPrincipal } from '@/lib/dal';

export const dynamic = 'force-dynamic';

/**
 * Owner-only area. This layout gates rendering; each page's Server Functions
 * check `users:manage` / `sessions:manage` again on every call, because a
 * layout is not a security boundary.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const principal = await getPrincipal();
  if (!principal) redirect('/sign-in');
  if (mustSetUpTwoFactor(principal)) redirect('/two-factor/setup');
  if (!can(principal, 'users:manage')) redirect('/');

  return (
    <div className="min-h-screen bg-sand-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white/80 px-6 py-4 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-sm font-medium text-slate-600 hover:text-slate-900">
              ← Back to the app
            </Link>
            <nav className="flex gap-4 text-sm font-medium">
              <Link href="/admin/users" className="text-slate-700 hover:text-slate-900">
                Users
              </Link>
              <Link href="/admin/sessions" className="text-slate-700 hover:text-slate-900">
                Sessions
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-4 text-sm text-slate-600">
            <span>
              {principal.name} · Owner
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-6">{children}</main>
    </div>
  );
}
