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

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { classifyMigrations } from '../src/lib/migration-safety.ts';

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

/** Migrations on disk that this database has not run yet. */
async function pendingMigrations(): Promise<{ name: string; sql: string }[]> {
  const dir = join(process.cwd(), 'prisma', 'migrations');
  const onDisk = readdirSync(dir).filter((name) => !name.endsWith('.toml')).sort();
  const applied = await prisma
    .$queryRawUnsafe<{ migration_name: string }[]>('select "migration_name" from "_prisma_migrations" where "finished_at" is not null')
    .catch(() => []);
  const done = new Set(applied.map((row) => row.migration_name));
  return onDisk
    .filter((name) => !done.has(name))
    .map((name) => ({ name, sql: readFileSync(join(dir, name, 'migration.sql'), 'utf8') }));
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

  // Adding is invisible to code already running; removing and changing is not.
  // That distinction is the whole of what went wrong, so it is what decides
  // this rather than a blanket refusal.
  const pending = await pendingMigrations();
  if (pending.length === 0) {
    console.log(`db-guard: nothing pending against ${marker.label}. Carrying on.`);
    return;
  }

  const { additive, byMigration } = classifyMigrations(pending);
  if (additive) {
    console.log(`db-guard: ${pending.length} pending migration${pending.length === 1 ? '' : 's'} against ${marker.label}, and every statement only adds:`);
    for (const row of byMigration) console.log(`  ${row.name} — ${row.verdict.statements.length} statements, all additive`);
    console.log('Nothing already there is dropped, renamed or retyped, so code running now is unaffected. Carrying on.');
    return;
  }

  console.error(
    [
      '',
      `db-guard: refused. ${target} is marked PRODUCTION (${marker.label}), and a pending migration would change`,
      'something the running site can see.',
      '',
      ...byMigration
        .filter((row) => !row.verdict.additive)
        .flatMap((row) => [
          `  ${row.name}`,
          ...row.verdict.blocking.map((verdict) => `    ${verdict.statement.slice(0, 96)}${verdict.statement.length > 96 ? '…' : ''}`),
          ...row.verdict.blocking.map((verdict) => `      ${verdict.reason}`),
        ]),
      '',
      'A change like this belongs in a deploy, where the new code arrives with it:',
      'render.yaml runs `prisma migrate deploy` at startup, after the build succeeds.',
      '',
      'If you mean to run it by hand anyway:',
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
