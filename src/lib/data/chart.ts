/**
 * Create or refresh an entity's chart of accounts from the templates.
 *
 * Used by the seed script and by createEntity, so a new entity added from the
 * UI gets the same chart a seeded one does. Idempotent: upserts on
 * (entityId, code).
 *
 * Loadable by plain Node (the seed runs under `node --experimental-strip-types`
 * semantics, which Node 24 has on by default), so relative imports carry their
 * `.ts` extension and there are no value imports from `@/`.
 */

import type { AccountType, Prisma } from '@prisma/client';

import {
  manufacturingAccounts,
  ngoAccounts,
  sharedTaxAccounts,
  type AccountTemplate,
} from '../account-templates.ts';
import type { EntityType } from './types.ts';

export function chartTemplateFor(type: EntityType): AccountTemplate[] {
  const base = type === 'programs' ? ngoAccounts : manufacturingAccounts;
  // Dedupe on code, first definition wins — matches the old seed's behaviour.
  const seen = new Set<string>();
  return [...base, ...sharedTaxAccounts].filter((template) => {
    if (seen.has(template.code)) return false;
    seen.add(template.code);
    return true;
  });
}

const accountTypes = new Set<AccountType>(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST_OF_SALES', 'EXPENSE']);

function accountTypeOf(raw: string): AccountType {
  return accountTypes.has(raw as AccountType) ? (raw as AccountType) : 'ASSET';
}

export async function seedChartForEntity(
  tx: Prisma.TransactionClient,
  entityId: string,
  type: EntityType,
): Promise<number> {
  const templates = chartTemplateFor(type);
  const idsByCode = new Map<string, string>();

  // Parents first so children can link to them. Templates list parents before
  // children, but sort by code as a belt-and-braces guarantee.
  for (const template of [...templates].sort((a, b) => a.code.localeCompare(b.code))) {
    const parentId = template.parentCode ? (idsByCode.get(template.parentCode) ?? null) : null;

    const account = await tx.account.upsert({
      where: { entityId_code: { entityId, code: template.code } },
      update: {
        name: template.name,
        type: accountTypeOf(template.type),
        category: template.category ?? null,
        parentId,
        isActive: true,
      },
      create: {
        entityId,
        code: template.code,
        name: template.name,
        type: accountTypeOf(template.type),
        category: template.category ?? null,
        parentId,
        isActive: true,
      },
      select: { id: true, code: true },
    });

    idsByCode.set(account.code, account.id);
  }

  return idsByCode.size;
}
