/**
 * Say which database this is, once, so scripts/db-guard.ts can tell them apart.
 *
 *   npm run db:mark -- development "my laptop"
 *   npm run db:mark -- production  "Supabase sprouted-prod"
 *
 * Re-marking a production database as development is refused: that is the one
 * direction that would quietly disarm the guard.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const [environment, ...rest] = process.argv.slice(2);
  const label = rest.join(' ').trim();

  if (environment !== 'production' && environment !== 'development') {
    console.error('Usage: npm run db:mark -- <development|production> "a name you will recognise"');
    process.exitCode = 1;
    return;
  }
  if (!label) {
    console.error('Give it a label you will recognise, e.g. "Supabase sprouted-prod".');
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.databaseMarker.findFirst();
  if (existing?.environment === 'production' && environment === 'development') {
    console.error(
      [
        '',
        `Refused: this database is already marked production (${existing.label}).`,
        'Marking it development would turn the guard off for it, which is the one',
        'change worth making hard. If it really is not production any more, remove',
        'the row by hand and mark it again.',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const marker = await prisma.databaseMarker.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', environment, label, markedBy: process.env.USERNAME ?? process.env.USER ?? null },
    update: { environment, label, markedAt: new Date(), markedBy: process.env.USERNAME ?? process.env.USER ?? null },
  });

  console.log(`Marked as ${marker.environment}: ${marker.label}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
