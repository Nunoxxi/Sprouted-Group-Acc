/**
 * Inventory: units, weighted average cost, receipts reconciling to the
 * ledger, adjustments, counts, NRV and the stock-to-ledger check. Pure.
 */

import { describe, expect, it } from 'vitest';

import {
  accountForStock,
  adjustmentJournal,
  allocateReceiptValues,
  averageCostPerKg,
  categoriesFor,
  countDifferences,
  defaultAccountCodeFor,
  formatInUnit,
  formatKg,
  fromGrams,
  inventoryAccounts,
  issue,
  nrvAssessment,
  receive,
  reconcileStockToLedger,
  stockJournalBalances,
  toGrams,
  transferJournal,
  valueOf,
  writeDownJournal,
  type StockPosition,
  type UnitFactors,
} from '@/lib/inventory';

const rcn: UnitFactors = { baseUnit: 'bag', gramsPerBag: 80_000, gramsPerCarton: null };
const sugar: UnitFactors = { baseUnit: 'kg', gramsPerBag: 50_000, gramsPerCarton: null };
const cartons: UnitFactors = { baseUnit: 'carton', gramsPerBag: null, gramsPerCarton: 12_500 };
const names = { '1030': 'Raw Materials Inventory', '1050': 'Goods in Transit', '5030': 'Inventory Adjustments', '5035': 'Inventory Write-downs (NRV)' };

describe('units', () => {
  it('stores everything in grams: bags, cartons and tonnes convert through the item', () => {
    expect(toGrams(80, 'bag', rcn)).toBe(6_400_000);
    expect(toGrams(1.5, 'tonne', rcn)).toBe(1_500_000);
    expect(toGrams(2.25, 'kg', sugar)).toBe(2_250);
    expect(toGrams(3, 'carton', cartons)).toBe(37_500);
    expect(fromGrams(6_400_000, 'bag', rcn)).toBe(80);
    expect(fromGrams(6_400_000, 'tonne', rcn)).toBe(6.4);
  });

  it('rounds to whole grams and refuses a unit the item has no factor for', () => {
    expect(toGrams(0.0004, 'kg', sugar)).toBe(0);
    expect(toGrams(0.0005, 'kg', sugar)).toBe(1);
    expect(() => toGrams(1, 'carton', rcn)).toThrow(/carton/);
    expect(() => toGrams(1, 'bag', cartons)).toThrow(/bag/);
  });

  it('formats in kilograms to the gram, and in the item\'s own unit', () => {
    expect(formatKg(6_400_000)).toBe('6,400.000 kg');
    expect(formatKg(1)).toBe('0.001 kg');
    expect(formatInUnit(6_400_000, rcn)).toBe('80 bags');
  });

  it('Roots holds raw produce only; manufacturers hold every category, each in its own account', () => {
    expect(categoriesFor('programs')).toEqual(['raw-material']);
    expect(categoriesFor('manufacturing')).toHaveLength(5);
    expect(defaultAccountCodeFor('manufacturing', 'raw-material')).toBe('1030');
    expect(defaultAccountCodeFor('manufacturing', 'packaging')).toBe('1035');
    expect(defaultAccountCodeFor('manufacturing', 'work-in-progress')).toBe('1040');
    expect(defaultAccountCodeFor('manufacturing', 'finished-good')).toBe('1045');
    expect(defaultAccountCodeFor('programs', 'raw-material')).toBe('1030');
  });
});

describe('weighted average cost', () => {
  it('recalculates on every receipt and relieves issues at the average', () => {
    let position: StockPosition = { quantityGrams: 0, valueMinor: 0 };
    position = receive(position, 100_000, 1_000_00); // 100 kg at GH₵10/kg
    expect(averageCostPerKg(position)).toBe(10_00);
    position = receive(position, 100_000, 2_000_00); // 100 kg at GH₵20/kg
    expect(averageCostPerKg(position)).toBe(15_00);
    const out = issue(position, 50_000); // 50 kg
    expect(out.valueMinor).toBe(750_00);
    expect(out.position).toEqual({ quantityGrams: 150_000, valueMinor: 2_250_00 });
    expect(averageCostPerKg(out.position)).toBe(15_00);
    // Another receipt at a different price moves the average again.
    position = receive(out.position, 50_000, 400_00); // 50 kg at GH₵8/kg
    expect(averageCostPerKg(position)).toBe(13_25);
  });

  it('never leaves value behind when everything is issued, whatever the rounding', () => {
    const position: StockPosition = { quantityGrams: 3, valueMinor: 100 };
    expect(valueOf(1, position)).toBe(33);
    expect(valueOf(2, position)).toBe(67);
    const all = issue(position, 3);
    expect(all.valueMinor).toBe(100);
    expect(all.position).toEqual({ quantityGrams: 0, valueMinor: 0 });
  });

  it('refuses to issue more than is on hand', () => {
    expect(() => issue({ quantityGrams: 1_000, valueMinor: 500 }, 1_001)).toThrow(/on hand/);
  });

  it('a foreign receipt is fixed at the bill\'s functional value — the average never sees the foreign amount', () => {
    // $1,000 of packaging at 12.5 = GH₵12,500, and that is what stock carries.
    const position = receive({ quantityGrams: 0, valueMinor: 0 }, 500_000, 12_500_00);
    expect(averageCostPerKg(position)).toBe(25_00);
  });
});

describe('receipts from a bill', () => {
  it('give each line its share of what the journal debited to its account, summing exactly', () => {
    const lines = [
      { lineId: 'a', accountCode: '1030', baseMinor: 100_00 },
      { lineId: 'b', accountCode: '1030', baseMinor: 100_00 },
      { lineId: 'c', accountCode: '1030', baseMinor: 100_00 },
      { lineId: 'd', accountCode: '1035', baseMinor: 50_00 },
    ];
    // 1030 carries 300.00 base plus GH₵0.01 of rounding/import VAT; 1035 exactly its base.
    const shares = allocateReceiptValues(lines, { '1030': 300_01, '1035': 50_00 });
    expect(shares.a + shares.b + shares.c).toBe(300_01);
    expect(shares.d).toBe(50_00);
    expect(Object.values(shares).every((v) => Number.isInteger(v))).toBe(true);
  });

  it('carries unregistered import VAT into cost through the account total', () => {
    const shares = allocateReceiptValues([{ lineId: 'a', accountCode: '1030', baseMinor: 100_000 }], { '1030': 120_000 });
    expect(shares.a).toBe(120_000);
  });

  it('a foreign bill\'s converted total is what is allocated', () => {
    // Two USD lines, functional total from the journal at 12.5.
    const shares = allocateReceiptValues(
      [
        { lineId: 'x', accountCode: '1035', baseMinor: 30_000 },
        { lineId: 'y', accountCode: '1035', baseMinor: 70_000 },
      ],
      { '1035': 1_250_000 },
    );
    expect(shares).toEqual({ x: 375_000, y: 875_000 });
  });
});

describe('journals', () => {
  it('an adjustment down debits adjustments and credits inventory; up is the reverse; zero posts nothing', () => {
    const down = adjustmentJournal(-1_500_00, '1030', names);
    expect(down).toEqual([
      { accountCode: '5030', accountName: 'Inventory Adjustments', amount: 1_500_00, type: 'debit' },
      { accountCode: '1030', accountName: 'Raw Materials Inventory', amount: 1_500_00, type: 'credit' },
    ]);
    const up = adjustmentJournal(200_00, '1030', names);
    expect(up[0]).toMatchObject({ accountCode: '1030', type: 'debit' });
    expect(up[1]).toMatchObject({ accountCode: '5030', type: 'credit' });
    expect(adjustmentJournal(0, '1030', names)).toEqual([]);
    expect(stockJournalBalances(down) && stockJournalBalances(up)).toBe(true);
  });

  it('a write-down leaves inventory for the write-down account', () => {
    const lines = writeDownJournal(300_00, '1045', names);
    expect(lines[0]).toMatchObject({ accountCode: inventoryAccounts.writeDowns, type: 'debit', amount: 300_00 });
    expect(lines[1]).toMatchObject({ accountCode: '1045', type: 'credit', amount: 300_00 });
  });

  it('a transfer posts only when the two locations carry stock in different accounts', () => {
    expect(transferJournal(500_00, '1030', '1030', names)).toEqual([]);
    const inTransit = transferJournal(500_00, '1030', '1050', names);
    expect(inTransit).toEqual([
      { accountCode: '1050', accountName: 'Goods in Transit', amount: 500_00, type: 'debit' },
      { accountCode: '1030', accountName: 'Raw Materials Inventory', amount: 500_00, type: 'credit' },
    ]);
    expect(accountForStock({ accountCode: '1030' }, { accountCode: null })).toBe('1030');
    expect(accountForStock({ accountCode: '1030' }, { accountCode: '1050' })).toBe('1050');
  });
});

describe('stock counts', () => {
  const position: StockPosition = { quantityGrams: 1_000_000, valueMinor: 15_000_00 }; // 1 t at GH₵15/kg

  it('previews one difference per item that differs, valued at average cost, and skips uncounted items', () => {
    const differences = countDifferences([
      { itemId: 'rcn', expectedGrams: 1_000_000, countedGrams: 980_000, position },
      { itemId: 'same', expectedGrams: 500_000, countedGrams: 500_000, position },
      { itemId: 'uncounted', expectedGrams: 500_000, countedGrams: null, position },
      { itemId: 'extra', expectedGrams: 100_000, countedGrams: 110_000, position },
    ]);
    expect(differences).toEqual([
      { itemId: 'rcn', differenceGrams: -20_000, valueMinor: -300_00, unvalued: false },
      { itemId: 'extra', differenceGrams: 10_000, valueMinor: 150_00, unvalued: false },
    ]);
  });

  it('flags extra stock it cannot value because nothing was on hand', () => {
    const [found] = countDifferences([{ itemId: 'x', expectedGrams: 0, countedGrams: 5_000, position: { quantityGrams: 0, valueMinor: 0 } }]);
    expect(found).toEqual({ itemId: 'x', differenceGrams: 5_000, valueMinor: 0, unvalued: true });
  });
});

describe('net realisable value', () => {
  it('flags an item whose cost exceeds its selling price, with the write-down needed', () => {
    const rows = nrvAssessment(
      [
        { itemId: 'kernels', quantityGrams: 2_000_000, valueMinor: 90_000_00 }, // GH₵45/kg
        { itemId: 'shells', quantityGrams: 500_000, valueMinor: 250_00 }, // GH₵0.50/kg
        { itemId: 'unpriced', quantityGrams: 1_000, valueMinor: 100 },
      ],
      { kernels: 40_00, shells: 2_00 },
    );
    expect(rows[0]).toMatchObject({ costPerKgMinor: 45_00, nrvPerKgMinor: 40_00, nrvValueMinor: 80_000_00, writeDownMinor: 10_000_00, flagged: true });
    expect(rows[1]).toMatchObject({ costPerKgMinor: 50, nrvPerKgMinor: 2_00, writeDownMinor: 0, flagged: false });
    expect(rows[2]).toMatchObject({ nrvPerKgMinor: null, flagged: false });
  });

  it('compares exactly: a pesewa of cost over NRV is flagged', () => {
    const [row] = nrvAssessment([{ itemId: 'x', quantityGrams: 1_000, valueMinor: 10_01 }], { x: 10_00 });
    expect(row.flagged).toBe(true);
    expect(row.writeDownMinor).toBe(1);
  });
});

describe('stock value reconciles to the inventory accounts', () => {
  it('agrees when every account matches', () => {
    const result = reconcileStockToLedger({ '1030': 500_00, '1035': 200_00 }, { '1030': 500_00, '1035': 200_00 });
    expect(result.agrees).toBe(true);
    expect(result.stockTotal).toBe(700_00);
    expect(result.ledgerTotal).toBe(700_00);
  });

  it('warns, naming the account, when they differ — including an account only one side has', () => {
    const result = reconcileStockToLedger({ '1030': 500_00 }, { '1030': 500_00, '1045': 1_00 });
    expect(result.agrees).toBe(false);
    expect(result.rows.find((r) => r.accountCode === '1045')).toEqual({ accountCode: '1045', stockMinor: 0, ledgerMinor: 1_00, differenceMinor: -1_00 });
  });
});
