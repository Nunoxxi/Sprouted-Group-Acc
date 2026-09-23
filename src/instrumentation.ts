/**
 * Runs once when a Next.js server instance boots, before it serves requests.
 *
 * The nightly ledger export scheduler lives here rather than in a route
 * handler: hung off a request, it only ever started when somebody opened the
 * Settings page, and stopped whenever that process went away.
 */
export async function register() {
  // fs, crypto and Prisma are Node-only — the edge runtime also evaluates this file.
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  // One clear line in the logs beats a page of stack traces later: without the
  // key, telephone and mobile money numbers cannot be read back, and the app
  // says so on screen rather than pretending there are none.
  if (!process.env.PII_ENCRYPTION_KEY) {
    const how = process.env.NODE_ENV === 'production' ? 'Set it on the service before anyone signs in.' : 'Set it in .env.';
    console.error(`PII_ENCRYPTION_KEY is not set. Telephone numbers, mobile money numbers, addresses and signatures already stored cannot be read back, and no new one can be saved. ${how}`);
  }

  const { ensureExportScheduler } = await import('./lib/export');

  // Deliberately not awaited: register() blocks the server from accepting
  // requests, and the first export can take a while.
  ensureExportScheduler();
}
