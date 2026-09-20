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

import { randomUUID } from 'node:crypto';

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

/**
 * One read, then batched inserts, then updates only for rows that differ.
 * ~50 sequential upserts per entity over a remote connection blew through
 * Prisma's interactive-transaction timeout; this is three round trips on a
 * fresh chart and one on a re-run.
 */
export async function seedChartForEntity(
  tx: Prisma.TransactionClient,
  entityId: string,
  type: EntityType,
): Promise<number> {
  const templates = chartTemplateFor(type);

  const existing = await tx.account.findMany({
    where: { entityId },
    select: { id: true, code: true, name: true, type: true, category: true, parentId: true, isActive: true },
  });
  const rowsByCode = new Map(existing.map((row) => [row.code, row]));

  // Ids are allocated here so children can reference parents inserted in the
  // same batch. Roots go first so every parentId already exists.
  const idsByCode = new Map<string, string>(existing.map((row) => [row.code, row.id]));
  for (const template of templates) {
    if (!idsByCode.has(template.code)) idsByCode.set(template.code, randomUUID());
  }

  const desired = templates.map((template) => ({
    id: idsByCode.get(template.code)!,
    entityId,
    code: template.code,
    name: template.name,
    type: accountTypeOf(template.type),
    category: template.category ?? null,
    parentId: template.parentCode ? (idsByCode.get(template.parentCode) ?? null) : null,
    isActive: true,
  }));

  const missing = desired.filter((row) => !rowsByCode.has(row.code));
  const roots = missing.filter((row) => row.parentId === null);
  const children = missing.filter((row) => row.parentId !== null);
  if (roots.length) await tx.account.createMany({ data: roots });
  if (children.length) await tx.account.createMany({ data: children });

  for (const row of desired) {
    const current = rowsByCode.get(row.code);
    if (!current) continue;
    const unchanged =
      current.name === row.name &&
      current.type === row.type &&
      current.category === row.category &&
      current.parentId === row.parentId &&
      current.isActive;
    if (unchanged) continue;

    await tx.account.update({
      where: { id: current.id },
      data: { name: row.name, type: row.type, category: row.category, parentId: row.parentId, isActive: true },
    });
  }

  return desired.length;
}

/**
 * Every entity starts with one bank account in its functional currency,
 * posting to 1001 "Cash and Bank". Further accounts (a USD account, say)
 * are added from Settings and get their own GL account. Idempotent.
 */
export async function ensureDefaultBankAccount(tx: Prisma.TransactionClient, entityId: string): Promise<void> {
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const cash = await tx.account.findUnique({ where: { entityId_code: { entityId, code: '1001' } }, select: { id: true } });
  if (!cash) return;
  const existing = await tx.bankAccount.findUnique({ where: { accountId: cash.id }, select: { id: true } });
  if (existing) return;
  await tx.bankAccount.create({
    data: { entityId, name: `Main ${entity.functionalCurrency} account`, currency: entity.functionalCurrency, accountId: cash.id },
  });
}
