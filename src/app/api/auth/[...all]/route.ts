import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '@/lib/auth';

// Every Better Auth endpoint (sign-in, sign-out, reset-password, two-factor,
// admin) is served from here. The library applies its own rate limits.
export const { GET, POST } = toNextJsHandler(auth);
