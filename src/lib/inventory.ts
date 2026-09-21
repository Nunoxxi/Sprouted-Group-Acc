/**
 * Inventory logic. Pure: no I/O, no Prisma. The server functions, the
 * editor and the tests all call these — there is no second implementation.
 *
 * Quantities are integer grams, values are integer minor units of the
 * entity's functional currency. Weighted average cost is never stored: it is
 * value / quantity of what is on hand, so it recalculates itself on every
 * receipt and can never disagree with the ledger by rounding.
 */

import type { EntityType } from './data/types';

// --- categories, units --------------------------------------------------------------

export type ItemCategory = 'raw-material' | 'packaging' | 'work-in-progress' | 'finished-good' | 'by-product';
export const itemCategories: ItemCategory[] = ['raw-material', 'packaging', 'work-in-progress', 'finished-good', 'by-product'];
export const categoryLabels: Record<ItemCategory, string> = {
  'raw-material': 'Raw material',
  packaging: 'Packaging',
  'work-in-progress': 'Work in progress',
  'finished-good': 'Finished good',
  'by-product': 'By-product',
};

export type StockUnit = 'kg' | 'bag' | 'carton' | 'tonne';
export const stockUnits: StockUnit[] = ['kg', 'bag', 'carton', 'tonne'];
export const unitLabels: Record<StockUnit, string> = { kg: 'kg', bag: 'bags', carton: 'cartons', tonne: 'tonnes' };

export const GRAMS_PER_KG = 1000;
export const GRAMS_PER_TONNE = 1_000_000;

export type UnitFactors = {
  baseUnit: StockUnit;
  /** Grams in one bag of this item; null when the item is not handled in bags. */
  gramsPerBag: number | null;
  gramsPerCarton: number | null;
};

/** Grams in one `unit` of this item. Throws for a unit the item has no factor for. */
export function gramsPerUnit(item: UnitFactors, unit: StockUnit): number {
  switch (unit) {
    case 'kg':
      return GRAMS_PER_KG;
    case 'tonne':
      return GRAMS_PER_TONNE;
    case 'bag':
      if (!item.gramsPerBag || item.gramsPerBag <= 0) throw new Error('This item has no weight per bag.');
      return item.gramsPerBag;
    case 'carton':
      if (!item.gramsPerCarton || item.gramsPerCarton <= 0) throw new Error('This item has no weight per carton.');
      return item.gramsPerCarton;
  }
}

/** A quantity typed in `unit` → whole grams (rounded half-up on the absolute value). */
export function toGrams(quantity: number, unit: StockUnit, item: UnitFactors): number {
  if (!Number.isFinite(quantity)) throw new Error('Quantity must be a number.');
  const grams = quantity * gramsPerUnit(item, unit);
  return Math.sign(grams) * Math.round(Math.abs(grams));
}

export function fromGrams(grams: number, unit: StockUnit, item: UnitFactors): number {
  return grams / gramsPerUnit(item, unit);
}

/** "6,400.000 kg" — always kilograms, three decimals, so a gram is visible. */
export function formatKg(grams: number): string {
  return `${new Intl.NumberFormat('en-GH', { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(grams / GRAMS_PER_KG)} kg`;
}

/** The same quantity in the item's own unit, e.g. "80 bags". */
export function formatInUnit(grams: number, item: UnitFactors): string {
  const quantity = fromGrams(grams, item.baseUnit, item);
  return `${new Intl.NumberFormat('en-GH', { maximumFractionDigits: 3 }).format(quantity)} ${unitLabels[item.baseUnit]}`;
}

// --- which entities hold what ----------------------------------------------------------

/**
 * Sprouted Roots does not hold processed stock: raw produce in transit only.
 * Manufacturers hold every category.
 */
export function categoriesFor(entityType: EntityType): ItemCategory[] {
  return entityType === 'programs' ? ['raw-material'] : itemCategories;
}

/** The inventory account an item of this category is carried in, by chart. */
export function defaultAccountCodeFor(entityType: EntityType, category: ItemCategory): string {
  if (entityType === 'programs') {
    return category === 'packaging' ? '1035' : '1030';
  }
  switch (category) {
    case 'raw-material':
      return '1030';
    case 'packaging':
      return '1035';
    case 'work-in-progress':
      return '1040';
    case 'finished-good':
    case 'by-product':
      return '1045';
  }
}

/** Accounts tagged `inventory` in the chart hold stock; these two take what leaves it without a sale. */
export const inventoryAccountCategory = 'inventory';
export const inventoryAccounts = { adjustments: '5030', writeDowns: '5035' } as const;

export type AdjustmentReason = 'count-difference' | 'moisture-loss' | 'damage' | 'spoilage' | 'nrv-write-down';
export const adjustmentReasons: AdjustmentReason[] = ['count-difference', 'moisture-loss', 'damage', 'spoilage'];
export const reasonLabels: Record<AdjustmentReason, string> = {
  'count-difference': 'Count difference',
  'moisture-loss': 'Moisture loss',
  damage: 'Damage',
  spoilage: 'Spoilage',
  'nrv-write-down': 'NRV write-down',
};

// --- weighted average cost ---------------------------------------------------------------

export type StockPosition = { quantityGrams: number; valueMinor: number };

/** Weighted average cost in minor units per kg, rounded for display; null with nothing on hand. */
export function averageCostPerKg(position: StockPosition): number | null {
  if (position.quantityGrams <= 0) return null;
  return Number((BigInt(position.valueMinor) * BigInt(GRAMS_PER_KG) * 2n + BigInt(position.quantityGrams)) / (BigInt(position.quantityGrams) * 2n));
}

/**
 * The value of `quantityGrams` taken out of a position at its average cost:
 * value × qty / total, in whole minor units, half-up. Taking everything
 * takes exactly the whole value, so a position can never be left with
 * value and no quantity.
 */
export function valueOf(quantityGrams: number, position: StockPosition): number {
  if (quantityGrams <= 0 || position.quantityGrams <= 0) return 0;
  if (quantityGrams >= position.quantityGrams) return position.valueMinor;
  const numerator = BigInt(position.valueMinor) * BigInt(quantityGrams);
  const denominator = BigInt(position.quantityGrams);
  // half-up for positive, half-away-from-zero for negative values
  const sign = numerator < 0n ? -1n : 1n;
  const abs = numerator < 0n ? -numerator : numerator;
  return Number(sign * ((abs * 2n + denominator) / (denominator * 2n)));
}

/** A receipt: quantity and value simply add; the average is implied. */
export function receive(position: StockPosition, quantityGrams: number, valueMinor: number): StockPosition {
  return { quantityGrams: position.quantityGrams + quantityGrams, valueMinor: position.valueMinor + valueMinor };
}

/** An issue at average cost. Refuses to take more than is there. */
export function issue(position: StockPosition, quantityGrams: number): { position: StockPosition; valueMinor: number } {
  if (quantityGrams > position.quantityGrams) {
    throw new Error(`Only ${formatKg(position.quantityGrams)} on hand; cannot remove ${formatKg(quantityGrams)}.`);
  }
  const valueMinor = valueOf(quantityGrams, position);
  return { position: { quantityGrams: position.quantityGrams - quantityGrams, valueMinor: position.valueMinor - valueMinor }, valueMinor };
}

// --- receipts from a bill ------------------------------------------------------------------

export type ReceiptLine = { lineId: string; accountCode: string; baseMinor: number };

/**
 * The functional value each bill line adds to stock: its pro-rata share, by
 * base amount, of what the bill's journal debited to that line's account.
 * The remainder of rounding lands on the largest line, so the lines of an
 * account sum exactly to the journal — stock value equals the ledger, to the
 * pesewa, by construction. Import VAT on an unregistered entity is already in
 * the account total, so it lands in cost here too.
 */
export function allocateReceiptValues(lines: ReceiptLine[], functionalByAccount: Record<string, number>): Record<string, number> {
  const result: Record<string, number> = {};
  const byAccount = new Map<string, ReceiptLine[]>();
  for (const line of lines) {
    (byAccount.get(line.accountCode) ?? byAccount.set(line.accountCode, []).get(line.accountCode)!).push(line);
  }
  for (const [accountCode, group] of byAccount) {
    const total = functionalByAccount[accountCode] ?? 0;
    const baseSum = group.reduce((sum, line) => sum + Math.max(line.baseMinor, 0), 0);
    let remaining = total;
    let largest = group[0];
    for (const line of group) {
      const share = baseSum > 0 ? Number((BigInt(total) * BigInt(Math.max(line.baseMinor, 0)) * 2n + BigInt(baseSum)) / (BigInt(baseSum) * 2n)) : 0;
      result[line.lineId] = share;
      remaining -= share;
      if (line.baseMinor > largest.baseMinor) largest = line;
    }
    result[largest.lineId] += remaining;
  }
  return result;
}

// --- journals -------------------------------------------------------------------------------

export type StockJournalLine = { accountCode: string; accountName: string; amount: number; type: 'debit' | 'credit' };

const nameOf = (names: Record<string, string>, code: string, fallback: string) => names[code] ?? fallback;

/** The account stock is carried in at a location: the location's override, else the item's. */
export function accountForStock(item: { accountCode: string }, location: { accountCode: string | null }): string {
  return location.accountCode ?? item.accountCode;
}

/**
 * An adjustment's ledger effect. More stock (a count found extra) debits
 * inventory and credits adjustments; less debits adjustments and credits
 * inventory. Zero value means no journal.
 */
export function adjustmentJournal(valueMinor: number, inventoryCode: string, names: Record<string, string>): StockJournalLine[] {
  if (valueMinor === 0) return [];
  const amount = Math.abs(valueMinor);
  const inventory = { accountCode: inventoryCode, accountName: nameOf(names, inventoryCode, 'Inventory'), amount };
  const adjustments = { accountCode: inventoryAccounts.adjustments, accountName: nameOf(names, inventoryAccounts.adjustments, 'Inventory Adjustments'), amount };
  return valueMinor > 0
    ? [{ ...inventory, type: 'debit' }, { ...adjustments, type: 'credit' }]
    : [{ ...adjustments, type: 'debit' }, { ...inventory, type: 'credit' }];
}

/** A write-down to NRV: value leaves inventory, quantity stays. */
export function writeDownJournal(valueMinor: number, inventoryCode: string, names: Record<string, string>): StockJournalLine[] {
  if (valueMinor <= 0) return [];
  return [
    { accountCode: inventoryAccounts.writeDowns, accountName: nameOf(names, inventoryAccounts.writeDowns, 'Inventory Write-downs (NRV)'), amount: valueMinor, type: 'debit' },
    { accountCode: inventoryCode, accountName: nameOf(names, inventoryCode, 'Inventory'), amount: valueMinor, type: 'credit' },
  ];
}

/** A transfer between two accounts (e.g. into Goods in Transit). Same account: nothing to post. */
export function transferJournal(valueMinor: number, fromCode: string, toCode: string, names: Record<string, string>): StockJournalLine[] {
  if (fromCode === toCode || valueMinor <= 0) return [];
  return [
    { accountCode: toCode, accountName: nameOf(names, toCode, 'Inventory'), amount: valueMinor, type: 'debit' },
    { accountCode: fromCode, accountName: nameOf(names, fromCode, 'Inventory'), amount: valueMinor, type: 'credit' },
  ];
}

export function stockJournalBalances(lines: StockJournalLine[]): boolean {
  const debits = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
  return debits === credits;
}

// --- stock counts -----------------------------------------------------------------------------

export type CountLine = {
  itemId: string;
  expectedGrams: number;
  countedGrams: number | null;
  /** The item's position across all locations — the average cost the difference is valued at. */
  position: StockPosition;
};

export type CountDifference = {
  itemId: string;
  differenceGrams: number;
  valueMinor: number;
  /** True when extra stock was found but there is no cost on hand to value it at. */
  unvalued: boolean;
};

/**
 * What posting a count would do: one difference per item whose counted
 * quantity differs from expected, valued at the item's average cost. Items
 * left uncounted are skipped, not treated as zero.
 */
export function countDifferences(lines: CountLine[]): CountDifference[] {
  const differences: CountDifference[] = [];
  for (const line of lines) {
    if (line.countedGrams === null) continue;
    const differenceGrams = line.countedGrams - line.expectedGrams;
    if (differenceGrams === 0) continue;
    if (differenceGrams < 0) {
      differences.push({ itemId: line.itemId, differenceGrams, valueMinor: -valueOf(-differenceGrams, line.position), unvalued: false });
    } else {
      // Extra stock is valued at the average; valueOf caps at the whole
      // position, so the average is applied directly here.
      const canValue = line.position.quantityGrams > 0;
      const valueMinor = canValue
        ? Number((BigInt(line.position.valueMinor) * BigInt(differenceGrams) * 2n + BigInt(line.position.quantityGrams)) / (BigInt(line.position.quantityGrams) * 2n))
        : 0;
      differences.push({ itemId: line.itemId, differenceGrams, valueMinor, unvalued: !canValue });
    }
  }
  return differences;
}

// --- net realisable value ------------------------------------------------------------------------

export type NrvInput = { itemId: string; quantityGrams: number; valueMinor: number };
export type NrvRow = {
  itemId: string;
  quantityGrams: number;
  valueMinor: number;
  costPerKgMinor: number | null;
  nrvPerKgMinor: number | null;
  /** quantity × NRV per kg. */
  nrvValueMinor: number | null;
  /** How much cost exceeds NRV; zero when it does not. */
  writeDownMinor: number;
  flagged: boolean;
};

/** Compare each item's cost with its selling price. Exact integer comparison; no per-kg rounding decides a flag. */
export function nrvAssessment(items: NrvInput[], nrvPerKgByItem: Record<string, number | undefined>): NrvRow[] {
  return items.map((item) => {
    const nrvPerKg = nrvPerKgByItem[item.itemId];
    const costPerKgMinor = averageCostPerKg(item);
    if (nrvPerKg === undefined || item.quantityGrams <= 0) {
      return { ...item, costPerKgMinor, nrvPerKgMinor: nrvPerKg ?? null, nrvValueMinor: null, writeDownMinor: 0, flagged: false };
    }
    const nrvValueMinor = Number((BigInt(item.quantityGrams) * BigInt(nrvPerKg) * 2n + BigInt(GRAMS_PER_KG)) / (BigInt(GRAMS_PER_KG) * 2n));
    const writeDownMinor = Math.max(item.valueMinor - nrvValueMinor, 0);
    return { ...item, costPerKgMinor, nrvPerKgMinor: nrvPerKg, nrvValueMinor, writeDownMinor, flagged: writeDownMinor > 0 };
  });
}

// --- reconciliation to the ledger ----------------------------------------------------------------

export type ReconciliationRow = { accountCode: string; stockMinor: number; ledgerMinor: number; differenceMinor: number };

/**
 * Stock value per inventory account against the ledger balance of that
 * account. They agree by construction; a difference means something reached
 * an inventory account without going through stock (a bill line with no
 * item, a manual journal) or the reverse — and is shown, never hidden.
 */
export function reconcileStockToLedger(stockByAccount: Record<string, number>, ledgerByAccount: Record<string, number>) {
  const codes = [...new Set([...Object.keys(stockByAccount), ...Object.keys(ledgerByAccount)])].sort();
  const rows: ReconciliationRow[] = codes.map((accountCode) => {
    const stockMinor = stockByAccount[accountCode] ?? 0;
    const ledgerMinor = ledgerByAccount[accountCode] ?? 0;
    return { accountCode, stockMinor, ledgerMinor, differenceMinor: stockMinor - ledgerMinor };
  });
  const stockTotal = rows.reduce((s, r) => s + r.stockMinor, 0);
  const ledgerTotal = rows.reduce((s, r) => s + r.ledgerMinor, 0);
  return { rows, stockTotal, ledgerTotal, agrees: rows.every((r) => r.differenceMinor === 0) };
}
