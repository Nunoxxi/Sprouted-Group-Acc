import { Suspense } from 'react';

import { SetPasswordForm } from './set-password-form';

// The token arrives in the query string, so this page cannot be prerendered.
export const dynamic = 'force-dynamic';

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm />
    </Suspense>
  );
}
