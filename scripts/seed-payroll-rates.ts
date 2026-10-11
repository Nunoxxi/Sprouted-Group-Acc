/**
 * Seed the statutory payroll rates with the PLACEHOLDER figures in
 * scripts/payroll-rate-placeholders.ts. None of them is verified.
 *
 * The rates are national, held once for every entity. Only a key with no
 * rows at all is seeded, so it never overwrites what a person has entered —
 * and a key added to the catalogue later is filled in on the next run. Refuses
 * a database marked production unless ALLOW_PRODUCTION_SEED=1 is set on
 * purpose.
 *
 *   node scripts/seed-payroll-rates.ts
 */

import { PrismaClient } from '@prisma/client';

import { PLACEHOLDER_EFFECTIVE_FROM, PLACEHOLDER_NOTE, placeholderRates } from './payroll-rate-placeholders.ts';

const prisma = new PrismaClient();

async function main() {
  const marker = await prisma.databaseMarker.findUnique({ where: { id: 'singleton' } });
  if (marker?.environment === 'production' && process.env.ALLOW_PRODUCTION_SEED !== '1') {
    throw new Error(`Refusing to seed placeholder payroll rates into ${marker.label} (production). Set ALLOW_PRODUCTION_SEED=1 if you mean it.`);
  }
  const held = new Set((await prisma.statutoryRate.findMany({ select: { key: true }, distinct: ['key'] })).map((row) => row.key));
  const missing = placeholderRates.filter((seed) => !held.has(seed.key));
  if (missing.length === 0) {
    console.log('Every rate already has figures — left alone.');
    return;
  }
  await prisma.statutoryRate.createMany({
    data: missing.map((seed) => ({
      key: seed.key,
      sequence: seed.sequence ?? 0,
      effectiveFrom: new Date(`${PLACEHOLDER_EFFECTIVE_FROM}T00:00:00.000Z`),
      rateBasisPoints: seed.rate ?? null,
      amountMinor: seed.amount === undefined ? null : BigInt(seed.amount),
      maxCount: seed.maxCount ?? null,
      choice: seed.choice ?? null,
      dayOfMonth: seed.dayOfMonth ?? null,
      isPlaceholder: true,
      note: PLACEHOLDER_NOTE,
    })),
  });
  console.log(`Seeded ${missing.length} placeholder rate rows from ${PLACEHOLDER_EFFECTIVE_FROM}, for every entity: ${[...new Set(missing.map((seed) => seed.key))].join(', ')}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
