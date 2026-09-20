import { redirect } from 'next/navigation';

import { TwoFactorSetup } from './two-factor-setup';
import { getPrincipal } from '@/lib/dal';

export const dynamic = 'force-dynamic';

/**
 * Mandatory for any role that can post transactions; the home page redirects
 * here until TOTP is verified, and every Server Function refuses meanwhile.
 * Users who already have it set up are sent back to the app.
 */
export default async function TwoFactorSetupPage() {
  const principal = await getPrincipal();
  if (!principal) {
    redirect('/sign-in');
  }
  if (principal.twoFactorEnabled) {
    redirect('/');
  }
  return <TwoFactorSetup email={principal.email} />;
}
