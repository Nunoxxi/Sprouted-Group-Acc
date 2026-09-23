/**
 * Move the existing entities onto the restructured chart of accounts.
 *
 * The template in src/lib/account-templates.ts is what a *new* entity gets.
 * The three that already exist have accounts with postings on them, and a
 * posting must go on meaning what it meant when it was made. So this script
 * never repoints a posting and never deletes an account. It does one of three
 * things to each account:
 *
 *   kept      - the code means the same thing under the new chart, so the
 *               seed simply renames it (1010 Trade Receivables becomes Grants
 *               & Contracts Receivable; it is still the receivables control).
 *   retired   - no longer in the chart and never posted to, so it is
 *               deactivated and keeps its code.
 *   legacy    - no longer in the chart, or the code now means something else,
 *               but postings are sitting on it. Its code is prefixed LEG- and
 *               it is deactivated. The row, its name and its postings are
 *               untouched, so history still reads the way it was written, and
 *               the code is freed for the new account.
 *
 * Bank accounts are left alone whatever else is true of them: their GL account
 * is created by the bank feature, not the template, and the BankAccount row
 * points at it.
 *
 * Safe to run again: the second run finds nothing to do.
 */

import { PrismaClient } from '@prisma/client';

import { chartTemplateFor } from '../src/lib/data/chart.ts';
import type { EntityType } from '../src/lib/data/types.ts';

const prisma = new PrismaClient();

/**
 * Codes that survive into the new chart but no longer mean what they meant.
 * Anything posted to these has to move aside, or the trial balance would
 * silently reclassify it.
 */
const repurposed: Record<string, string[]> = {
  'sprouted-roots': [
    '5001', // Aggregation Purchase Cost -> Training & Capacity Building
    '5020', // Farmer Support & Inputs   -> Inputs & Seedlings (and now an expense, not cost of sales)
    '6001', // Program Expenditure       -> Salaries & Wages
    '6005', // Support Costs             -> Per Diems
    '6020', // Staff Salaries            -> Staff Health Insurance
  ],
};

const entityTypeOf = (raw: string): EntityType => (raw === 'programs' ? 'programs' : 'manufacturing');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const entities = await prisma.entity.findMany({ select: { id: true, type: true }, orderBy: { code: 'asc' } });

  for (const entity of entities) {
    const template = chartTemplateFor(entityTypeOf(entity.type));
    const wanted = new Set(template.map((row) => row.code));

    const accounts = await prisma.account.findMany({
      where: { entityId: entity.id },
      select: { id: true, code: true, name: true, isActive: true, bankAccount: { select: { id: true } } },
      orderBy: { code: 'asc' },
    });

    const kept: string[] = [];
    const retired: string[] = [];
    const legacy: string[] = [];

    for (const account of accounts) {
      if (account.code.startsWith('LEG-')) continue; // already moved aside
      if (account.bankAccount) { kept.push(account.code); continue; }

      const postings = await prisma.journalLine.count({ where: { accountId: account.id } });
      const stillMeansTheSame = wanted.has(account.code) && !(repurposed[entity.id] ?? []).includes(account.code);
      if (stillMeansTheSame) { kept.push(account.code); continue; }

      if (postings > 0) {
        legacy.push(`${account.code} ${account.name} (${postings})`);
        if (!dryRun) {
          await prisma.account.update({
            where: { id: account.id },
            data: { code: `LEG-${account.code}`, isActive: false },
          });
        }
      } else if (account.isActive) {
        retired.push(`${account.code} ${account.name}`);
        if (!dryRun) {
          await prisma.account.update({ where: { id: account.id }, data: { isActive: false } });
        }
      }
    }

    if (!dryRun) {
      await prisma.$transaction(
        async (tx) => {
          const { seedChartForEntity } = await import('../src/lib/data/chart.ts');
          await seedChartForEntity(tx, entity.id, entityTypeOf(entity.type));
        },
        { timeout: 60_000, maxWait: 20_000 },
      );
    }

    console.log(`\n${entity.id}${dryRun ? '  (dry run)' : ''}`);
    console.log(`  kept as they were: ${kept.length}`);
    console.log(`  deactivated, never posted to: ${retired.length}${retired.length ? `  [${retired.join(', ')}]` : ''}`);
    console.log(`  moved to LEG- with their postings: ${legacy.length}${legacy.length ? `  [${legacy.join(', ')}]` : ''}`);
    if (!dryRun) {
      const now = await prisma.account.count({ where: { entityId: entity.id, isActive: true } });
      console.log(`  active accounts now: ${now}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
