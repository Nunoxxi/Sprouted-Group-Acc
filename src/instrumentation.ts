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

  const { ensureExportScheduler } = await import('./lib/export');

  // Deliberately not awaited: register() blocks the server from accepting
  // requests, and the first export can take a while.
  ensureExportScheduler();
}
