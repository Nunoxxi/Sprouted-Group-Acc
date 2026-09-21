'use server';

/**
 * Server Functions for inventory: items, locations, transfers, adjustments,
 * stock counts, NRV. Same contract as documents.ts: authorize first through
 * src/lib/dal.ts, scope every query by entity, and write the stock movement,
 * its journal and its audit event in one transaction — a balance can never
 * move without the ledger and the trail moving with it.
 *
 * Receipts are not here: they are created by posting a bill (documents.ts),
 * whose journal is their ledger posting.
 */

import { refresh } from 'next/cache';
import { Prisma, type StockUnit as PrismaStockUnit } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { seedChartForEntity } from '@/lib/data/chart.ts';
import {
  categoryToPrisma,
  countInclude,
  countRecord,
  itemInclude,
  itemRecord,
  locationInclude,
  locationRecord,
  movementInclude,
  movementRecord,
  nrvRecord,
  reasonToPrisma,
  unitToPrisma,
  unitToRecord,
} from '@/lib/data/inventory';
import { entityTypeOf } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import type { ItemRecord, NrvPriceRecord, StockCountRecord, StockLocationRecord, StockMovementRecord } from '@/lib/data/types';
import { periodOf } from '@/lib/documents';
import {
  accountForStock,
  adjustmentJournal,
  adjustmentReasons,
  categoriesFor,
  countDifferences,
  defaultAccountCodeFor,
  formatKg,
  inventoryAccountCategory,
  issue,
  itemCategories,
  nrvAssessment,
  stockJournalBalances,
  stockUnits,
  toGrams,
  transferJournal,
  valueOf,
  writeDownJournal,
  type AdjustmentReason,
  type ItemCategory,
  type StockJournalLine,
  type StockUnit,
} from '@/lib/inventory';
import { prisma } from '@/lib/prisma';
import { balanceAt, moveBalance, positionOf, StockRefusal } from '@/lib/data/stock';

import type { ActionResult } from './documents';

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

async function withEntityAccess<T>(entityId: string, permission: Permission, run: (principal: Principal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let principal: Principal;
  try {
    principal = await requireEntityAccess(entityId, permission);
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  return run(principal);
}

function dateOf(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new StockRefusal('Date must be YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new StockRefusal('That is not a real date.');
  return date;
}

async function refusable<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StockRefusal) return fail(error.message);
    throw error;
  }
}

type Tx = Prisma.TransactionClient;

async function requireOpenPeriod(entityId: string, date: string) {
  const period = periodOf(date);
  if (await prisma.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } })) {
    throw new StockRefusal(`Period ${period} has been filed. Date the movement in an open period.`);
  }
}

/** A STOCK journal in the functional currency. Returns null when there is nothing to post. */
async function postStockJournal(
  tx: Tx,
  entityId: string,
  lines: StockJournalLine[],
  date: string,
  reference: string,
  description: string,
  principal: Principal,
): Promise<string | null> {
  if (lines.length === 0) return null;
  if (!stockJournalBalances(lines)) throw new Error('Stock journal does not balance; refusing to post');
  const accounts = await tx.account.findMany({ where: { entityId, code: { in: lines.map((l) => l.accountCode) } }, select: { id: true, code: true } });
  const idOf = new Map(accounts.map((a) => [a.code, a.id]));
  for (const line of lines) {
    if (!idOf.has(line.accountCode)) throw new StockRefusal(`Account ${line.accountCode} is not in this entity's chart. Re-run the chart seed.`);
  }
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const entry = await tx.journalEntry.create({
    data: {
      entityId,
      kind: 'STOCK',
      reference,
      description,
      postedAt: dateOf(date),
      postedById: principal.userId,
      lines: {
        create: lines.map((line) => ({
          entityId,
          accountId: idOf.get(line.accountCode) as string,
          txnCurrency: entity.functionalCurrency,
          txnAmountMinor: fromMinor(line.amount),
          rate: new Prisma.Decimal(1),
          amountMinor: fromMinor(line.amount),
          direction: line.type === 'debit' ? ('MONEY_IN' as const) : ('MONEY_OUT' as const),
        })),
      },
    },
    select: { id: true },
  });
  return entry.id;
}

async function namesFor(tx: Tx, entityId: string): Promise<Record<string, string>> {
  const accounts = await tx.account.findMany({ where: { entityId }, select: { code: true, name: true } });
  return Object.fromEntries(accounts.map((a) => [a.code, a.name]));
}

async function requireItem(tx: Tx, entityId: string, itemId: string) {
  const item = await tx.item.findFirst({ where: { id: itemId, entityId, isActive: true }, include: itemInclude });
  if (!item) throw new StockRefusal('Choose an item belonging to this entity.');
  return item;
}

async function requireLocation(tx: Tx, entityId: string, locationId: string) {
  const location = await tx.stockLocation.findFirst({ where: { id: locationId, entityId, isActive: true }, include: locationInclude });
  if (!location) throw new StockRefusal('Choose a location belonging to this entity.');
  return location;
}

function factorsOf(item: { baseUnit: PrismaStockUnit; gramsPerBag: number | null; gramsPerCarton: number | null }) {
  return { baseUnit: unitToRecord[item.baseUnit], gramsPerBag: item.gramsPerBag, gramsPerCarton: item.gramsPerCarton };
}

// --- items and locations -------------------------------------------------------------------

export type ItemInput = {
  id?: string;
  code: string;
  name: string;
  category: ItemCategory;
  baseUnit: StockUnit;
  gramsPerBag: number | null;
  gramsPerCarton: number | null;
  /** Inventory account; defaulted from the category when omitted. */
  accountCode?: string;
  isActive?: boolean;
};

export async function saveItem(entityId: string, input: ItemInput): Promise<ActionResult<ItemRecord>> {
  return withEntityAccess(entityId, 'inventory:manage', (principal) =>
    refusable(async () => {
      const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
      const entityType = entityTypeOf(entity.type);
      const code = input.code.trim().toUpperCase();
      const name = input.name.trim();
      if (!code || !name) return fail('An item needs a code and a name.');
      if (!itemCategories.includes(input.category)) return fail('Unknown category.');
      if (!categoriesFor(entityType).includes(input.category)) {
        return fail(entityType === 'programs' ? `${entity.name} is an impact programme and holds no stock.` : `${entity.name} trades raw commodities; it cannot carry ${input.category.replace('-', ' ')} stock.`);
      }
      if (!stockUnits.includes(input.baseUnit)) return fail('Unknown unit.');
      const gramsPerBag = input.gramsPerBag === null ? null : Math.round(input.gramsPerBag);
      const gramsPerCarton = input.gramsPerCarton === null ? null : Math.round(input.gramsPerCarton);
      if (input.baseUnit === 'bag' && !(gramsPerBag && gramsPerBag > 0)) return fail('An item counted in bags needs the weight of one bag.');
      if (input.baseUnit === 'carton' && !(gramsPerCarton && gramsPerCarton > 0)) return fail('An item counted in cartons needs the weight of one carton.');
      const accountCode = input.accountCode?.trim() || defaultAccountCodeFor(entityType, input.category);

      const row = await prisma.$transaction(async (tx) => {
        // Make sure the chart carries the inventory and adjustment accounts.
        await seedChartForEntity(tx, entityId, entityType);
        const account = await tx.account.findFirst({ where: { entityId, code: accountCode, category: inventoryAccountCategory, isActive: true } });
        if (!account) throw new StockRefusal(`${accountCode} is not an inventory account in this entity's chart.`);

        if (input.id) {
          const existing = await tx.item.findFirst({ where: { id: input.id, entityId } });
          if (!existing) throw new StockRefusal('Item not found.');
          if (existing.accountId !== account.id) {
            const held = await tx.stockBalance.aggregate({ where: { itemId: existing.id }, _sum: { quantityGrams: true } });
            if ((held._sum.quantityGrams ?? 0n) !== 0n) throw new StockRefusal('Move the stock out before changing the account an item is carried in.');
          }
          const updated = await tx.item.update({
            where: { id: existing.id },
            data: { code, name, category: categoryToPrisma[input.category], baseUnit: unitToPrisma[input.baseUnit], gramsPerBag, gramsPerCarton, accountId: account.id, isActive: input.isActive ?? existing.isActive },
            include: itemInclude,
          });
          await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'item', resourceRef: code, summary: `Item ${code} ${name} updated`, metadata: { itemId: existing.id } }, tx);
          return updated;
        }

        const duplicate = await tx.item.findUnique({ where: { entityId_code: { entityId, code } } });
        if (duplicate) throw new StockRefusal(`Item code ${code} already exists.`);
        const created = await tx.item.create({
          data: { entityId, code, name, category: categoryToPrisma[input.category], baseUnit: unitToPrisma[input.baseUnit], gramsPerBag, gramsPerCarton, accountId: account.id },
          include: itemInclude,
        });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'item', resourceRef: code, summary: `Item ${code} ${name} created (${input.category}, ${accountCode})`, metadata: { itemId: created.id } }, tx);
        return created;
      });

      refresh();
      return { ok: true, value: itemRecord(row) };
    }),
  );
}

export type LocationInput = { id?: string; code: string; name: string; accountCode: string | null; isActive?: boolean };

export async function saveLocation(entityId: string, input: LocationInput): Promise<ActionResult<StockLocationRecord>> {
  return withEntityAccess(entityId, 'inventory:manage', (principal) =>
    refusable(async () => {
      const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
      const code = input.code.trim().toUpperCase();
      const name = input.name.trim();
      if (!code || !name) return fail('A location needs a code and a name.');

      const row = await prisma.$transaction(async (tx) => {
        await seedChartForEntity(tx, entityId, entityTypeOf(entity.type));
        let accountId: string | null = null;
        if (input.accountCode?.trim()) {
          const account = await tx.account.findFirst({ where: { entityId, code: input.accountCode.trim(), category: inventoryAccountCategory, isActive: true } });
          if (!account) throw new StockRefusal(`${input.accountCode} is not an inventory account in this entity's chart.`);
          accountId = account.id;
        }
        if (input.id) {
          const existing = await tx.stockLocation.findFirst({ where: { id: input.id, entityId } });
          if (!existing) throw new StockRefusal('Location not found.');
          if (existing.accountId !== accountId) {
            const held = await tx.stockBalance.aggregate({ where: { locationId: existing.id }, _sum: { quantityGrams: true } });
            if ((held._sum.quantityGrams ?? 0n) !== 0n) throw new StockRefusal('Move the stock out before changing the account a location carries it in.');
          }
          const updated = await tx.stockLocation.update({ where: { id: existing.id }, data: { code, name, accountId, isActive: input.isActive ?? existing.isActive }, include: locationInclude });
          await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'location', resourceRef: code, summary: `Location ${code} ${name} updated` }, tx);
          return updated;
        }
        if (await tx.stockLocation.findUnique({ where: { entityId_code: { entityId, code } } })) throw new StockRefusal(`Location code ${code} already exists.`);
        const created = await tx.stockLocation.create({ data: { entityId, code, name, accountId }, include: locationInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'location', resourceRef: code, summary: `Location ${code} ${name} created` }, tx);
        return created;
      });

      refresh();
      return { ok: true, value: locationRecord(row) };
    }),
  );
}

// --- transfers ------------------------------------------------------------------------------------

export type TransferInput = { itemId: string; fromLocationId: string; toLocationId: string; quantity: number; unit: StockUnit; date: string; note?: string };

/**
 * Move stock between two locations at its average cost. The ledger moves
 * only if the two locations carry the item in different accounts.
 */
export async function transferStock(entityId: string, input: TransferInput): Promise<ActionResult<StockMovementRecord>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      if (input.fromLocationId === input.toLocationId) return fail('Choose two different locations.');
      if (!(input.quantity > 0)) return fail('Enter a quantity greater than zero.');
      dateOf(input.date);
      await requireOpenPeriod(entityId, input.date);

      const row = await prisma.$transaction(async (tx) => {
        const item = await requireItem(tx, entityId, input.itemId);
        const from = await requireLocation(tx, entityId, input.fromLocationId);
        const to = await requireLocation(tx, entityId, input.toLocationId);
        const grams = toGrams(input.quantity, input.unit, factorsOf(item));
        if (grams <= 0) return null;

        // Costing is per grade per location: value at the sending location's own average.
        const here = await balanceAt(tx, item.id, from.id);
        if (grams > here.quantityGrams) throw new StockRefusal(`Only ${formatKg(here.quantityGrams)} of ${item.code} at ${from.name}; cannot move ${formatKg(grams)}.`);
        const value = valueOf(grams, here);

        await moveBalance(tx, entityId, item.id, from.id, -grams, -value);
        await moveBalance(tx, entityId, item.id, to.id, grams, value);

        const names = await namesFor(tx, entityId);
        const lines = transferJournal(value, accountForStock({ accountCode: item.account.code }, { accountCode: from.account?.code ?? null }), accountForStock({ accountCode: item.account.code }, { accountCode: to.account?.code ?? null }), names);
        const journalId = await postStockJournal(tx, entityId, lines, input.date, `TRF ${item.code}`, `Transfer ${formatKg(grams)} ${item.name}: ${from.name} → ${to.name}`, principal);

        const movement = await tx.stockMovement.create({
          data: { entityId, kind: 'TRANSFER', date: dateOf(input.date), itemId: item.id, fromLocationId: from.id, toLocationId: to.id, quantityGrams: fromMinor(grams), valueMinor: fromMinor(value), note: input.note?.trim() || null, journalEntryId: journalId, createdById: principal.userId },
          include: movementInclude,
        });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'stock', resourceRef: movement.id, summary: `Transfer ${formatKg(grams)} ${item.code} ${from.name} → ${to.name}${journalId ? '' : ' (same account, no ledger effect)'}`, metadata: { movementId: movement.id, valueMinor: value, journalEntryId: journalId } },
          tx,
        );
        return movement;
      });
      if (!row) return fail('That quantity rounds to nothing.');

      refresh();
      return { ok: true, value: movementRecord(row) };
    }),
  );
}

// --- adjustments -------------------------------------------------------------------------------------

export type AdjustmentInput = {
  itemId: string;
  locationId: string;
  /** Signed, in `unit`: negative removes stock. */
  quantity: number;
  unit: StockUnit;
  reason: AdjustmentReason;
  date: string;
  note?: string;
  /** For stock found with nothing on hand to value it at: cost per kg, minor units. */
  unitCostMinorPerKg?: number;
};

/**
 * Change a quantity with a reason. Nothing is ever silently applied: the
 * reason and the person are on the movement, and the value difference
 * posts to Inventory Adjustments.
 */
export async function adjustStock(entityId: string, input: AdjustmentInput): Promise<ActionResult<StockMovementRecord>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      if (!adjustmentReasons.includes(input.reason)) return fail('Choose a reason for the adjustment.');
      if (!Number.isFinite(input.quantity) || input.quantity === 0) return fail('Enter a quantity: negative to remove stock, positive to add.');
      dateOf(input.date);
      await requireOpenPeriod(entityId, input.date);

      const row = await prisma.$transaction(async (tx) => {
        const item = await requireItem(tx, entityId, input.itemId);
        const location = await requireLocation(tx, entityId, input.locationId);
        const grams = toGrams(input.quantity, input.unit, factorsOf(item));
        if (grams === 0) return null;

        // Costing is per grade per location: this location's own average.
        const position = await balanceAt(tx, item.id, location.id);
        let value: number;
        if (grams < 0) {
          if (-grams > position.quantityGrams) throw new StockRefusal(`Only ${formatKg(position.quantityGrams)} of ${item.code} at ${location.name}; cannot remove ${formatKg(-grams)}.`);
          value = -issue(position, -grams).valueMinor;
        } else if (position.quantityGrams > 0) {
          value = Number((BigInt(position.valueMinor) * BigInt(grams) * 2n + BigInt(position.quantityGrams)) / (BigInt(position.quantityGrams) * 2n));
        } else if (input.unitCostMinorPerKg && input.unitCostMinorPerKg > 0) {
          value = Number((BigInt(Math.round(input.unitCostMinorPerKg)) * BigInt(grams) * 2n + 1000n) / 2000n);
        } else {
          throw new StockRefusal(`${item.code} has nothing on hand to value the addition at. Enter a cost per kg.`);
        }

        await moveBalance(tx, entityId, item.id, location.id, grams, value);

        const names = await namesFor(tx, entityId);
        const inventoryCode = accountForStock({ accountCode: item.account.code }, { accountCode: location.account?.code ?? null });
        const journalId = await postStockJournal(tx, entityId, adjustmentJournal(value, inventoryCode, names), input.date, `ADJ ${item.code}`, `Adjustment (${input.reason.replace('-', ' ')}) ${formatKg(grams)} ${item.name} at ${location.name}`, principal);

        const movement = await tx.stockMovement.create({
          data: {
            entityId, kind: 'ADJUSTMENT', date: dateOf(input.date), itemId: item.id,
            fromLocationId: grams < 0 ? location.id : null, toLocationId: grams > 0 ? location.id : null,
            quantityGrams: fromMinor(grams), valueMinor: fromMinor(value), reason: reasonToPrisma[input.reason], note: input.note?.trim() || null, journalEntryId: journalId, createdById: principal.userId,
          },
          include: movementInclude,
        });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'stock', resourceRef: movement.id, summary: `Stock adjustment ${grams > 0 ? '+' : '−'}${formatKg(Math.abs(grams))} ${item.code} at ${location.name}: ${input.reason.replace('-', ' ')}`, metadata: { movementId: movement.id, reason: input.reason, valueMinor: value, journalEntryId: journalId, note: input.note?.trim() || null } },
          tx,
        );
        return movement;
      });
      if (!row) return fail('That quantity rounds to nothing.');

      refresh();
      return { ok: true, value: movementRecord(row) };
    }),
  );
}

// --- stock counts -------------------------------------------------------------------------------------

export type CountInput = {
  id?: string;
  locationId: string;
  date: string;
  note?: string;
  /** Counted quantities in each item's base unit; null for not counted. */
  lines: { itemId: string; counted: number | null }[];
};

/** Save a count as a draft: expected quantities are snapshotted, nothing posts. */
export async function saveStockCount(entityId: string, input: CountInput): Promise<ActionResult<StockCountRecord>> {
  return withEntityAccess(entityId, 'stock:enter', (principal) =>
    refusable(async () => {
      dateOf(input.date);
      const row = await prisma.$transaction(async (tx) => {
        const location = await requireLocation(tx, entityId, input.locationId);
        const items = await tx.item.findMany({ where: { entityId, isActive: true } });
        const itemById = new Map(items.map((item) => [item.id, item]));
        const balances = await tx.stockBalance.findMany({ where: { locationId: location.id } });
        const expectedByItem = new Map(balances.map((b) => [b.itemId, toMinor(b.quantityGrams)]));

        const lines = input.lines.map((line) => {
          const item = itemById.get(line.itemId);
          if (!item) throw new StockRefusal('A counted item does not belong to this entity.');
          const counted = line.counted === null || line.counted === undefined ? null : toGrams(line.counted, factorsOf(item).baseUnit, factorsOf(item));
          if (counted !== null && counted < 0) throw new StockRefusal('A counted quantity cannot be negative.');
          return { entityId, itemId: item.id, expectedGrams: fromMinor(expectedByItem.get(item.id) ?? 0), countedGrams: counted === null ? null : fromMinor(counted) };
        });

        if (input.id) {
          const existing = await tx.stockCount.findFirst({ where: { id: input.id, entityId } });
          if (!existing) throw new StockRefusal('Count not found.');
          if (existing.status === 'POSTED') throw new StockRefusal('This count has been posted and cannot be changed.');
          await tx.stockCountLine.deleteMany({ where: { stockCountId: existing.id } });
          return tx.stockCount.update({ where: { id: existing.id }, data: { locationId: location.id, date: dateOf(input.date), note: input.note?.trim() || null, lines: { create: lines } }, include: countInclude });
        }
        return tx.stockCount.create({ data: { entityId, locationId: location.id, date: dateOf(input.date), note: input.note?.trim() || null, createdById: principal.userId, lines: { create: lines } }, include: countInclude });
      });

      refresh();
      return { ok: true, value: countRecord(row) };
    }),
  );
}

/**
 * Post a count: expected quantities are re-read now (not the draft's
 * snapshot), every difference becomes an adjustment with reason
 * "count difference", valued at average cost, and one journal carries the
 * net of them all. Only after the person has confirmed the preview.
 */
export async function postStockCount(entityId: string, countId: string): Promise<ActionResult<StockCountRecord>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      const draft = await prisma.stockCount.findFirst({ where: { id: countId, entityId }, include: { lines: true, location: { include: locationInclude } } });
      if (!draft) return fail('Count not found.');
      if (draft.status === 'POSTED') return fail('This count has already been posted.');
      const date = draft.date.toISOString().slice(0, 10);
      await requireOpenPeriod(entityId, date);

      const row = await prisma.$transaction(async (tx) => {
        const claimed = await tx.stockCount.updateMany({ where: { id: countId, status: 'DRAFT' }, data: { status: 'POSTED', postedById: principal.userId, postedAt: new Date() } });
        if (claimed.count !== 1) throw new StockRefusal('This count has already been posted.');

        const names = await namesFor(tx, entityId);
        const journalLines: StockJournalLine[] = [];
        const summaries: string[] = [];
        const lineData: { itemId: string; expectedGrams: bigint; countedGrams: bigint | null }[] = [];

        for (const line of draft.lines) {
          const item = await requireItem(tx, entityId, line.itemId);
          const expectedNow = (await balanceAt(tx, item.id, draft.locationId)).quantityGrams;
          const counted = line.countedGrams === null ? null : toMinor(line.countedGrams);
          lineData.push({ itemId: item.id, expectedGrams: fromMinor(expectedNow), countedGrams: line.countedGrams });
          const [difference] = countDifferences([{ itemId: item.id, expectedGrams: expectedNow, countedGrams: counted, position: await balanceAt(tx, item.id, draft.locationId) }]);
          if (!difference) continue;
          if (difference.unvalued) throw new StockRefusal(`${item.code}: stock was found but there is no cost on hand to value it. Receive it through a bill or adjust it with a cost per kg first.`);

          await moveBalance(tx, entityId, item.id, draft.locationId, difference.differenceGrams, difference.valueMinor);
          const inventoryCode = accountForStock({ accountCode: item.account.code }, { accountCode: draft.location.account?.code ?? null });
          journalLines.push(...adjustmentJournal(difference.valueMinor, inventoryCode, names));
          await tx.stockMovement.create({
            data: {
              entityId, kind: 'ADJUSTMENT', date: draft.date, itemId: item.id,
              fromLocationId: difference.differenceGrams < 0 ? draft.locationId : null, toLocationId: difference.differenceGrams > 0 ? draft.locationId : null,
              quantityGrams: fromMinor(difference.differenceGrams), valueMinor: fromMinor(difference.valueMinor), reason: 'COUNT_DIFFERENCE', stockCountId: draft.id, createdById: principal.userId,
            },
          });
          summaries.push(`${item.code} ${difference.differenceGrams > 0 ? '+' : '−'}${formatKg(Math.abs(difference.differenceGrams))}`);
        }

        // Re-snapshot expected at posting so the record shows what was actually compared.
        await tx.stockCountLine.deleteMany({ where: { stockCountId: draft.id } });
        await tx.stockCountLine.createMany({ data: lineData.map((l) => ({ ...l, stockCountId: draft.id, entityId })) });

        const journalId = await postStockJournal(tx, entityId, journalLines, date, `COUNT ${draft.location.code}`, `Stock count at ${draft.location.name} on ${date}`, principal);
        if (journalId) {
          await tx.stockMovement.updateMany({ where: { stockCountId: draft.id }, data: { journalEntryId: journalId } });
        }
        const posted = await tx.stockCount.update({ where: { id: draft.id }, data: { journalEntryId: journalId }, include: countInclude });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'stock-count', resourceRef: draft.id, summary: `Stock count at ${draft.location.name} posted: ${summaries.length ? summaries.join(', ') : 'no differences'}`, metadata: { countId: draft.id, journalEntryId: journalId, differences: summaries.length } },
          tx,
        );
        return posted;
      });

      refresh();
      return { ok: true, value: countRecord(row) };
    }),
  );
}

// --- net realisable value ------------------------------------------------------------------------------

export type NrvInput = { itemId: string; period: string; sellingPriceMinorPerKg: number };

export async function setNrvPrice(entityId: string, input: NrvInput): Promise<ActionResult<NrvPriceRecord>> {
  return withEntityAccess(entityId, 'stock:enter', (principal) =>
    refusable(async () => {
      if (!/^\d{4}-\d{2}$/.test(input.period)) return fail('Period must be YYYY-MM.');
      if (!Number.isInteger(input.sellingPriceMinorPerKg) || input.sellingPriceMinorPerKg < 0) return fail('Enter a selling price per kg.');
      const row = await prisma.$transaction(async (tx) => {
        const item = await requireItem(tx, entityId, input.itemId);
        const saved = await tx.nrvPrice.upsert({
          where: { entityId_itemId_period: { entityId, itemId: item.id, period: input.period } },
          create: { entityId, itemId: item.id, period: input.period, sellingPriceMinorPerKg: fromMinor(input.sellingPriceMinorPerKg), createdById: principal.userId },
          update: { sellingPriceMinorPerKg: fromMinor(input.sellingPriceMinorPerKg), createdById: principal.userId },
        });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'nrv', resourceRef: `${item.code} ${input.period}`, summary: `NRV for ${item.code} in ${input.period} set to ${(input.sellingPriceMinorPerKg / 100).toFixed(2)} per kg` }, tx);
        return saved;
      });
      refresh();
      return { ok: true, value: nrvRecord(row) };
    }),
  );
}

export type WriteDownInput = { itemId: string; period: string; date: string };

/**
 * Write an item down to its NRV for a period: value leaves inventory for
 * Inventory Write-downs, spread across the locations that hold it; quantity
 * is untouched. Refused when cost does not exceed NRV.
 */
export async function writeDownToNrv(entityId: string, input: WriteDownInput): Promise<ActionResult<StockMovementRecord[]>> {
  return withEntityAccess(entityId, 'stock:post', (principal) =>
    refusable(async () => {
      dateOf(input.date);
      await requireOpenPeriod(entityId, input.date);
      const rows = await prisma.$transaction(async (tx) => {
        const item = await requireItem(tx, entityId, input.itemId);
        const price = await tx.nrvPrice.findUnique({ where: { entityId_itemId_period: { entityId, itemId: item.id, period: input.period } } });
        if (!price) throw new StockRefusal(`No NRV selling price for ${item.code} in ${input.period}.`);
        const position = await positionOf(tx, item.id);
        const [assessment] = nrvAssessment([{ itemId: item.id, ...position }], { [item.id]: toMinor(price.sellingPriceMinorPerKg) });
        if (!assessment.flagged) throw new StockRefusal(`${item.code} is carried at or below its NRV; nothing to write down.`);

        // Spread the write-down over the locations holding the item, pro rata by value, remainder on the largest.
        const balances = await tx.stockBalance.findMany({ where: { itemId: item.id, quantityGrams: { gt: 0 } }, include: { location: { include: locationInclude } } });
        const totalValue = balances.reduce((s, b) => s + toMinor(b.valueMinor), 0);
        let remaining = assessment.writeDownMinor;
        const shares = balances.map((b) => {
          const share = totalValue > 0 ? Number((BigInt(assessment.writeDownMinor) * b.valueMinor * 2n + BigInt(totalValue)) / (BigInt(totalValue) * 2n)) : 0;
          remaining -= share;
          return { balance: b, share };
        });
        if (shares.length > 0) shares.reduce((a, b) => (toMinor(b.balance.valueMinor) > toMinor(a.balance.valueMinor) ? b : a)).share += remaining;

        const names = await namesFor(tx, entityId);
        const journalLines: StockJournalLine[] = [];
        const created = [];
        for (const { balance, share } of shares) {
          if (share === 0) continue;
          await moveBalance(tx, entityId, item.id, balance.locationId, 0, -share);
          journalLines.push(...writeDownJournal(share, accountForStock({ accountCode: item.account.code }, { accountCode: balance.location.account?.code ?? null }), names));
          created.push(await tx.stockMovement.create({
            data: { entityId, kind: 'WRITE_DOWN', date: dateOf(input.date), itemId: item.id, fromLocationId: balance.locationId, quantityGrams: 0n, valueMinor: fromMinor(-share), reason: 'NRV_WRITE_DOWN', note: `NRV ${input.period}`, createdById: principal.userId },
            select: { id: true },
          }));
        }
        const journalId = await postStockJournal(tx, entityId, journalLines, input.date, `NRV ${item.code}`, `Write-down of ${item.name} to NRV for ${input.period}`, principal);
        await tx.stockMovement.updateMany({ where: { id: { in: created.map((c) => c.id) } }, data: { journalEntryId: journalId } });
        await recordAuditEvent(
          { entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'stock', resourceRef: item.code, summary: `${item.code} written down by ${(assessment.writeDownMinor / 100).toFixed(2)} to NRV for ${input.period}`, metadata: { writeDownMinor: assessment.writeDownMinor, journalEntryId: journalId } },
          tx,
        );
        return tx.stockMovement.findMany({ where: { id: { in: created.map((c) => c.id) } }, include: movementInclude });
      });
      refresh();
      return { ok: true, value: rows.map(movementRecord) };
    }),
  );
}
