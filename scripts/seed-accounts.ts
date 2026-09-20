/**
 * Seed the database with Sprouted Group's entities, charts of accounts,
 * contacts, funds and projects.
 *
 * Runs under plain Node 24 (native type stripping): `node scripts/seed-accounts.ts`.
 * Also registered as Prisma's seed, so `prisma migrate dev` and `migrate reset`
 * run it automatically. Idempotent — every write is an upsert, so running it
 * twice changes nothing.
 */

import { PrismaClient } from '@prisma/client';

import { seedChartForEntity } from '../src/lib/data/chart.ts';
import {
  contactCategoryToPrisma,
  contactTypeToPrisma,
  fundClassToPrisma,
  whtToPrisma,
} from '../src/lib/data/enums.ts';
import { seedContacts, seedEntities, seedFunds, seedProjects } from '../src/lib/seed-data.ts';

const prisma = new PrismaClient();

async function main() {
  await prisma.$transaction(async (tx) => {
    for (const entity of seedEntities) {
      await tx.entity.upsert({
        where: { id: entity.id },
        update: {
          code: entity.code,
          name: entity.name,
          type: entity.type,
          financialYearEnd: entity.financialYearEnd,
          vatRegistered: entity.vatRegistered,
          tin: entity.tin,
          accent: entity.accent,
        },
        create: {
          id: entity.id,
          code: entity.code,
          name: entity.name,
          type: entity.type,
          financialYearEnd: entity.financialYearEnd,
          vatRegistered: entity.vatRegistered,
          tin: entity.tin,
          accent: entity.accent,
        },
      });

      const accounts = await seedChartForEntity(tx, entity.id, entity.type);
      console.log(`${entity.name}: ${accounts} accounts`);
    }

    for (const contact of seedContacts) {
      await tx.contact.upsert({
        where: { id: contact.id },
        update: {
          name: contact.name,
          type: contactTypeToPrisma[contact.type],
          category: contactCategoryToPrisma[contact.category],
          tin: contact.tin || null,
          phone: contact.phone || null,
          email: contact.email || null,
          address: contact.address || null,
          withholdingTaxStatus: whtToPrisma[contact.withholdingTaxStatus],
          isFarmerAggregator: contact.isFarmerAggregator,
          isActive: contact.isActive,
        },
        create: {
          id: contact.id,
          name: contact.name,
          type: contactTypeToPrisma[contact.type],
          category: contactCategoryToPrisma[contact.category],
          tin: contact.tin || null,
          phone: contact.phone || null,
          email: contact.email || null,
          address: contact.address || null,
          withholdingTaxStatus: whtToPrisma[contact.withholdingTaxStatus],
          isFarmerAggregator: contact.isFarmerAggregator,
          isActive: contact.isActive,
        },
      });

      for (const [entityId, balance] of Object.entries(contact.balances)) {
        await tx.contactEntityBalance.upsert({
          where: { contactId_entityId: { contactId: contact.id, entityId } },
          update: { balanceMinor: BigInt(balance) },
          create: { contactId: contact.id, entityId, balanceMinor: BigInt(balance) },
        });
      }
    }
    console.log(`${seedContacts.length} contacts`);

    const fundIds = new Map<string, string>();
    for (const fund of seedFunds) {
      const record = await tx.fund.upsert({
        where: { entityId_code: { entityId: fund.entityId, code: fund.code } },
        update: {
          name: fund.name,
          classification: fundClassToPrisma[fund.classification],
          funder: fund.funder || null,
          isActive: true,
        },
        create: {
          entityId: fund.entityId,
          code: fund.code,
          name: fund.name,
          classification: fundClassToPrisma[fund.classification],
          funder: fund.funder || null,
        },
        select: { id: true },
      });
      fundIds.set(`${fund.entityId}/${fund.code}`, record.id);
    }

    for (const project of seedProjects) {
      const fundId = fundIds.get(`${project.entityId}/${project.fundCode}`) ?? null;
      await tx.project.upsert({
        where: { id: project.id },
        update: {
          code: project.code,
          name: project.name,
          funder: project.funder || null,
          fundId,
          budgetMinor: BigInt(project.budget),
          isActive: true,
        },
        create: {
          id: project.id,
          entityId: project.entityId,
          code: project.code,
          name: project.name,
          funder: project.funder || null,
          fundId,
          budgetMinor: BigInt(project.budget),
        },
      });
    }
    console.log(`${seedFunds.length} funds, ${seedProjects.length} projects`);
  });

  console.log('Seed complete');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
