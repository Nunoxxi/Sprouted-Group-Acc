'use client';

import { createAuthClient } from 'better-auth/react';
import { adminClient, twoFactorClient } from 'better-auth/client/plugins';

/**
 * Browser-side auth client. Sign-in, TOTP and password setting call the
 * library's endpoints under /api/auth directly from the browser so the
 * library sets its own cookies; nothing auth-related is hand-rolled here.
 */
export const authClient = createAuthClient({
  plugins: [
    adminClient(),
    // The sign-in form routes to /two-factor itself when the library asks
    // for a second factor, so no redirect callback here.
    twoFactorClient(),
  ],
});
