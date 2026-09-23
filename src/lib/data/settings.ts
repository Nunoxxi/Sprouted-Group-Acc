/**
 * Readers for the Settings area: project budget lines, fixed asset classes
 * and the tax rates.
 *
 * Projects, funds, contacts and entities are already loaded for the rest of
 * the app, so they are not read again here.
 */

import type { AssetCategory, Account, ProjectBudgetLine } from '@prisma/client';

import { statutoryTaxRates, type TaxRates } from '../settings';
import { prisma } from '../prisma';
import { toMinor } from './money';
import type { AssetCategoryRecord, ProjectBudgetLineRecord } from './types';

export function budgetLineRecord(row: ProjectBudgetLine & { account: Pick<Account, 'code'> | null }): ProjectBudgetLineRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    projectId: row.projectId,
    name: row.name,
    accountCode: row.account?.code ?? null,
    originalMinor: toMinor(row.originalMinor),
    revisedMinor: row.revisedMinor === null ? null : toMinor(row.revisedMinor),
    revisedAt: row.revisedAt ? row.revisedAt.toISOString() : null,
    note: row.note ?? '',
    isActive: row.isActive,
  };
}

export function assetCategoryRecord(row: AssetCategory & { account: Pick<Account, 'code'> | null }): AssetCategoryRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    ratePct: Number(row.ratePct),
    method: row.method === 'REDUCING_BALANCE' ? 'reducing-balance' : 'straight-line',
    accountCode: row.account?.code ?? null,
    isActive: row.isActive,
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/** Scoped by the principal's grant in every query. */
export async function loadSettingsData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [budgetLines, categories, rates] = await Promise.all([
    prisma.projectBudgetLine.findMany({ where: scope, include: { account: { select: { code: true } } }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.assetCategory.findMany({ where: scope, include: { account: { select: { code: true } } }, orderBy: { name: 'asc' } }),
    prisma.taxRateSetting.findMany({ where: scope }),
  ]);

  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));
  const ratesByEntity: Record<string, TaxRates> = Object.fromEntries(
    entityIds.map((id) => {
      const row = rates.find((rate) => rate.entityId === id);
      // No row means nobody has changed them, so the Ghanaian rates apply.
      return [
        id,
        row
          ? {
              vatPct: Number(row.vatPct),
              nhilPct: Number(row.nhilPct),
              getFundPct: Number(row.getFundPct),
              registrationThresholdMinor: toMinor(row.registrationThresholdMinor),
            }
          : statutoryTaxRates,
      ];
    }),
  );

  return {
    budgetLinesByEntity: withAll(groupBy(budgetLines.map(budgetLineRecord), (row) => row.entityId)),
    assetCategoriesByEntity: withAll(groupBy(categories.map(assetCategoryRecord), (row) => row.entityId)),
    taxRatesByEntity: ratesByEntity,
  };
}
