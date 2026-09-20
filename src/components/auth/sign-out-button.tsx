'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { authClient } from '@/lib/auth-client';

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      className={className ?? 'text-sm font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline'}
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        router.push('/sign-in');
        router.refresh();
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
