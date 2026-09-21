/**
 * Inventory readers: Prisma → records, and the ledger side of the
 * stock-to-ledger reconciliation. Every quantity and amount passes through
 * toMinor() here; nothing bigint leaves this file.
 */

import type {
  AdjustmentReason as PrismaAdjustmentReason,
  Item,
  ItemCategory as PrismaItemCategory,
  NrvPrice,
  StockCount,
  StockCountLine,
  StockMovement,
  StockMovementKind as PrismaMovementKind,
  StockUnit as PrismaStockUnit,
  Account,
  JournalEntry,
  JournalLine,
  StockLocation,
  StockBalance,
  User,
} from '@prisma/client';

import { inventoryAccountCategory, type AdjustmentReason, type ItemCategory, type StockUnit } from '../inventory';
import { prisma } from '../prisma';
import { postedJournal } from './documents';
import { toMinor } from './money';
import type {
  InventoryLedgerRow,
  ItemRecord,
  NrvPriceRecord,
  StockBalanceRecord,
  StockCountRecord,
  StockLocationRecord,
  StockMovementRecord,
} from './types';

// --- enum translations -------------------------------------------------------

const categoryToRecord: Record<PrismaItemCategory, ItemCategory> = {
  RAW_MATERIAL: 'raw-material',
  PACKAGING: 'packaging',
  WORK_IN_PROGRESS: 'work-in-progress',
  FINISHED_GOOD: 'finished-good',
  BY_PRODUCT: 'by-product',
};
export const categoryToPrisma: Record<ItemCategory, PrismaItemCategory> = {
  'raw-material': 'RAW_MATERIAL',
  packaging: 'PACKAGING',
  'work-in-progress': 'WORK_IN_PROGRESS',
  'finished-good': 'FINISHED_GOOD',
  'by-product': 'BY_PRODUCT',
};

export const unitToRecord: Record<PrismaStockUnit, StockUnit> = { KG: 'kg', BAG: 'bag', CARTON: 'carton', TONNE: 'tonne' };
export const unitToPrisma: Record<StockUnit, PrismaStockUnit> = { kg: 'KG', bag: 'BAG', carton: 'CARTON', tonne: 'TONNE' };

const reasonToRecord: Record<PrismaAdjustmentReason, AdjustmentReason> = {
  COUNT_DIFFERENCE: 'count-difference',
  MOISTURE_LOSS: 'moisture-loss',
  DAMAGE: 'damage',
  SPOILAGE: 'spoilage',
  NRV_WRITE_DOWN: 'nrv-write-down',
  ABNORMAL_LOSS: 'abnormal-loss',
};
export const reasonToPrisma: Record<AdjustmentReason, PrismaAdjustmentReason> = {
  'count-difference': 'COUNT_DIFFERENCE',
  'moisture-loss': 'MOISTURE_LOSS',
  damage: 'DAMAGE',
  spoilage: 'SPOILAGE',
  'nrv-write-down': 'NRV_WRITE_DOWN',
  'abnormal-loss': 'ABNORMAL_LOSS',
};

const kindToRecord: Record<PrismaMovementKind, StockMovementRecord['kind']> = {
  RECEIPT: 'receipt',
  RECEIPT_REVERSAL: 'receipt-reversal',
  TRANSFER: 'transfer',
  ADJUSTMENT: 'adjustment',
  WRITE_DOWN: 'write-down',
  LANDED_COST: 'landed-cost',
  SHRINKAGE: 'shrinkage',
};

// --- row → record --------------------------------------------------------------

type JournalRow = JournalEntry & { lines: (JournalLine & { account: Pick<Account, 'code' | 'name'> })[] };
const journalInclude = { lines: { include: { account: { select: { code: true, name: true } } } } } as const;

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function itemRecord(row: Item & { account: Pick<Account, 'code' | 'name'> }): ItemRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    code: row.code,
    name: row.name,
    category: categoryToRecord[row.category],
    baseUnit: unitToRecord[row.baseUnit],
    gramsPerBag: row.gramsPerBag,
    gramsPerCarton: row.gramsPerCarton,
    accountCode: row.account.code,
    accountName: row.account.name,
    commodityId: row.commodityId,
    grade: row.grade ?? '',
    isActive: row.isActive,
  };
}

export function locationRecord(row: StockLocation & { account: Pick<Account, 'code'> | null }): StockLocationRecord {
  return { id: row.id, entityId: row.entityId, code: row.code, name: row.name, accountCode: row.account?.code ?? null, isActive: row.isActive };
}

export function balanceRecord(row: StockBalance): StockBalanceRecord {
  return { itemId: row.itemId, locationId: row.locationId, quantityGrams: toMinor(row.quantityGrams), valueMinor: toMinor(row.valueMinor) };
}

export function movementRecord(
  row: StockMovement & { item: Pick<Item, 'code' | 'name'>; journalEntry: JournalRow | null; createdBy: Pick<User, 'name'> | null },
): StockMovementRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    kind: kindToRecord[row.kind],
    date: isoDate(row.date),
    itemId: row.itemId,
    itemCode: row.item.code,
    itemName: row.item.name,
    fromLocationId: row.fromLocationId,
    toLocationId: row.toLocationId,
    quantityGrams: toMinor(row.quantityGrams),
    valueMinor: toMinor(row.valueMinor),
    reason: row.reason ? reasonToRecord[row.reason] : null,
    note: row.note ?? '',
    documentId: row.documentId,
    stockCountId: row.stockCountId,
    lotId: row.lotId,
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    createdByName: row.createdBy?.name ?? '',
    createdAt: row.createdAt.toISOString(),
  };
}

export function countRecord(
  row: StockCount & { lines: StockCountLine[]; journalEntry: JournalRow | null; createdBy: Pick<User, 'name'> | null; postedBy: Pick<User, 'name'> | null },
): StockCountRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    locationId: row.locationId,
    date: isoDate(row.date),
    status: row.status === 'POSTED' ? 'posted' : 'draft',
    note: row.note ?? '',
    lines: row.lines.map((line) => ({
      itemId: line.itemId,
      expectedGrams: toMinor(line.expectedGrams),
      countedGrams: line.countedGrams === null ? null : toMinor(line.countedGrams),
    })),
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    createdByName: row.createdBy?.name ?? '',
    postedByName: row.postedBy?.name ?? null,
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
  };
}

export function nrvRecord(row: NrvPrice): NrvPriceRecord {
  return { itemId: row.itemId, period: row.period, sellingPriceMinorPerKg: toMinor(row.sellingPriceMinorPerKg) };
}

export const itemInclude = { account: { select: { code: true, name: true } } } as const;
export const locationInclude = { account: { select: { code: true } } } as const;
export const movementInclude = { item: { select: { code: true, name: true } }, journalEntry: { include: journalInclude }, createdBy: { select: { name: true } } } as const;
export const countInclude = { lines: true, journalEntry: { include: journalInclude }, createdBy: { select: { name: true } }, postedBy: { select: { name: true } } } as const;

// --- the ledger side of the reconciliation ----------------------------------------

/**
 * Balance of every account tagged `inventory` per entity, from the journal
 * lines themselves: money in less money out. This is what the balance sheet
 * will show, so it is what stock value must equal.
 */
export async function inventoryLedgerBalances(scope: { entityId?: { in: string[] } }, entityIds: string[]): Promise<Record<string, InventoryLedgerRow[]>> {
  const accounts = await prisma.account.findMany({
    where: { ...scope, category: inventoryAccountCategory },
    select: { id: true, entityId: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
  if (accounts.length === 0) return Object.fromEntries(entityIds.map((id) => [id, []]));

  const sums = await prisma.journalLine.groupBy({
    by: ['accountId', 'direction'],
    where: { accountId: { in: accounts.map((a) => a.id) } },
    _sum: { amountMinor: true },
  });
  const byAccount = new Map<string, bigint>();
  for (const row of sums) {
    const amount = row._sum.amountMinor ?? 0n;
    byAccount.set(row.accountId, (byAccount.get(row.accountId) ?? 0n) + (row.direction === 'MONEY_IN' ? amount : -amount));
  }

  const result: Record<string, InventoryLedgerRow[]> = Object.fromEntries(entityIds.map((id) => [id, []]));
  for (const account of accounts) {
    result[account.entityId]?.push({ accountCode: account.code, accountName: account.name, balanceMinor: toMinor(byAccount.get(account.id) ?? 0n) });
  }
  return result;
}

// --- the loader ------------------------------------------------------------------------

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    (groups[keyOf(item)] ??= []).push(item);
  }
  return groups;
}

/**
 * Scoped by the principal's grant in every query, like loadInitialData:
 * `scope` is the where-clause, `entityIds` only shapes the result.
 */
export async function loadInventoryData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [items, locations, balances, movements, counts, prices, ledger] = await Promise.all([
    prisma.item.findMany({ where: scope, include: itemInclude, orderBy: [{ entityId: 'asc' }, { code: 'asc' }] }),
    prisma.stockLocation.findMany({ where: scope, include: locationInclude, orderBy: [{ entityId: 'asc' }, { code: 'asc' }] }),
    prisma.stockBalance.findMany({ where: scope }),
    prisma.stockMovement.findMany({ where: scope, include: movementInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 500 }),
    prisma.stockCount.findMany({ where: scope, include: countInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
    prisma.nrvPrice.findMany({ where: scope, orderBy: [{ period: 'desc' }] }),
    inventoryLedgerBalances(scope, entityIds),
  ]);
  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));

  return {
    itemsByEntity: withAll(groupBy(items.map(itemRecord), (row) => row.entityId)),
    locationsByEntity: withAll(groupBy(locations.map(locationRecord), (row) => row.entityId)),
    stockBalancesByEntity: withAll(groupBy(balances.map((row) => ({ entityId: row.entityId, ...balanceRecord(row) })), (row) => row.entityId)),
    stockMovementsByEntity: withAll(groupBy(movements.map(movementRecord), (row) => row.entityId)),
    stockCountsByEntity: withAll(groupBy(counts.map(countRecord), (row) => row.entityId)),
    nrvPricesByEntity: withAll(groupBy(prices.map((row) => ({ entityId: row.entityId, ...nrvRecord(row) })), (row) => row.entityId)),
    inventoryLedgerByEntity: ledger,
  };
}
