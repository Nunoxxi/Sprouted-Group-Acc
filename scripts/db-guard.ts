/**
 * Refuse to migrate a production database from a developer's machine.
 *
 * This exists because it happened. Development and production shared one
 * Supabase database; a migration run locally dropped a column the deployed
 * code still read, and every page of the live site returned a server error
 * until the deploy caught up.
 *
 * The check reads a marker row *out of the database being connected to*,
 * rather than trusting an environment variable on the machine doing the
 * connecting — the whole failure was that the machine was pointed somewhere it
 * should not have been, so the machine is not the thing to ask.
 *
 * Allowed:
 *   - anything against a database marked `development`
 *   - anything from the deployed service itself (NODE_ENV=production, which
 *     Render sets and a developer's shell does not)
 *   - anything with ALLOW_PRODUCTION_MIGRATION=1, said out loud and on purpose
 *
 * Refused: everything else against a database marked `production`.
 *
 * An unmarked database is refused too, with instructions — better to be told
 * to spend ten seconds running `npm run db:mark` than to find out later.
 */

import { PrismaClient } from '@prisma/client';

type Marker = { environment: string; label: string; markedAt: Date };

const prisma = new PrismaClient();

/** Enough of the connection string to recognise, never the password. */
function describeTarget(): string {
  const url = process.env.DATABASE_URL ?? '';
  const host = url.match(/@([^/:]+)/)?.[1] ?? 'unknown host';
  const ref = url.match(/postgres\.([a-z0-9]+)/)?.[1];
  return ref ? `${host} (project ${ref})` : host;
}

async function readMarker(): Promise<Marker | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Marker[]>(
      'select "environment", "label", "markedAt" from "DatabaseMarker" limit 1',
    );
    return rows[0] ?? null;
  } catch {
    // The table is missing, which on a fresh database is normal: the very
    // first migration is what creates it.
    return null;
  }
}

async function main() {
  const marker = await readMarker();
  const target = describeTarget();

  if (!marker) {
    const migrations = await prisma
      .$queryRawUnsafe<{ count: bigint }[]>('select count(*)::bigint as count from "_prisma_migrations"')
      .catch(() => [{ count: 0n }]);
    const applied = Number(migrations[0]?.count ?? 0);
    if (applied === 0) {
      console.log(`db-guard: ${target} is empty, so this is a new database. Carrying on.`);
      return;
    }
    console.error(
      [
        '',
        `db-guard: ${target} has ${applied} migrations applied but is not marked as development or production.`,
        '',
        'Say which it is before migrating it:',
        '  npm run db:mark -- development "my laptop"',
        '  npm run db:mark -- production  "Supabase sprouted-prod"',
        '',
        'The marker lives in the database, so it is right whichever machine connects.',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  if (marker.environment !== 'production') {
    console.log(`db-guard: ${target} is marked ${marker.environment} (${marker.label}). Carrying on.`);
    return;
  }

  // From the deployed service itself, migrating production is the point.
  if (process.env.NODE_ENV === 'production') {
    console.log(`db-guard: running as the deployed service against ${marker.label}. Carrying on.`);
    return;
  }

  if (process.env.ALLOW_PRODUCTION_MIGRATION === '1') {
    console.warn(`db-guard: ALLOW_PRODUCTION_MIGRATION is set, so this is going ahead against ${marker.label}. Be certain.`);
    return;
  }

  console.error(
    [
      '',
      `db-guard: refused. ${target} is marked PRODUCTION (${marker.label}).`,
      '',
      'Migrating it from here would change the schema under the running site, which is',
      'how the live app once started returning a server error on every page.',
      '',
      'What you almost certainly want:',
      '  point DATABASE_URL and DIRECT_URL at your own development database',
      '',
      'Production is migrated by the deploy itself — render.yaml runs',
      '`prisma migrate deploy` at startup, after the new code is built.',
      '',
      'If you really do mean to migrate production by hand, say so:',
      '  ALLOW_PRODUCTION_MIGRATION=1 npm run prisma:deploy',
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('db-guard could not check the database:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
