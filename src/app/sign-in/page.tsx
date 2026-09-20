import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { SignInForm } from './sign-in-form';
import { getPrincipal } from '@/lib/dal';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  if (await getPrincipal()) {
    redirect('/');
  }
  return (
    <Suspense>
      <SignInForm />
    </Suspense>
  );
}
