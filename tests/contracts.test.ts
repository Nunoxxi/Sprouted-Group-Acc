/**
 * Sales contracts: values at the contract price, margin per contract and
 * per kg with foreign contracts restated at the contract rate and today's,
 * the position report, and every journal shape including LBC gross and
 * net. Pure.
 */

import { describe, expect, it } from 'vitest';

import {
  acceptanceJournal,
  cmcReceiptJournal,
  contractAccounts,
  contractMargin,
  contractValueMinor,
  deliveryJournal,
  journalBalanced,
  perKg,
  positionReport,
  seedFundJournal,
} from '@/lib/contracts';

const names = { '1010': 'Trade Receivables', '1030': 'Raw Materials Inventory', '1050': 'Goods in Transit', '1065': 'COCOBOD Receivable', '2050': 'COCOBOD Seed Fund Payable', '4001': 'Domestic Sales', '4005': 'Export Sales', '4020': "Buyer's Margin", '4025': 'Haulage', '4030': 'Pass-through', '5025': 'COGS', '1001': 'Bank' };

describe('contract values', () => {
  it('prices per kg, per bag or per tonne, to the pesewa', () => {
    expect(contractValueMinor(6_400_000, 1_500, 'kg', 80_000)).toBe(9_600_000); // 6,400 kg × $15.00
    expect(contractValueMinor(6_400_000, 120_000, 'bag', 80_000)).toBe(9_600_000); // 80 bags × $1,200
    expect(contractValueMinor(6_400_000, 1_500_000, 'tonne', 80_000)).toBe(9_600_000); // 6.4 t × $15,000
    expect(contractValueMinor(1, 1_500, 'kg', 80_000)).toBe(2); // 1 g at $15/kg = 1.5¢ → 2
    expect(perKg(9_600_000, 6_400_000)).toBe(1_500);
  });
});

describe('margin per contract', () => {
  const usd = { quantityGrams: 10_000_000, priceMinor: 1_500, priceUnit: 'kg' as const, currency: 'USD' as const, contractRate: '12.5' };
  const delivered = [
    { grams: 6_400_000, revenueTxnMinor: 9_600_000, revenueMinor: 124_800_000, costMinor: 76_800_000, marginMinor: 0, haulageMinor: 0, recognised: true }, // at 13.00
  ];

  it('gives revenue, cost of stock delivered, selling costs, gross margin and margin per kg', () => {
    const m = contractMargin(usd, delivered, [{ amountMinor: 2_000_000 }, { amountMinor: 500_000 }], 'GHS', 80_000, '13.2');
    expect(m).toMatchObject({ deliveredGrams: 6_400_000, undeliveredGrams: 3_600_000, revenueTxnMinor: 9_600_000, revenueMinor: 124_800_000, costMinor: 76_800_000, sellingMinor: 2_500_000, grossMarginMinor: 45_500_000 });
    expect(m.marginPerKgMinor).toBe(7_109); // GH₵71.09/kg
  });

  it('restates a foreign contract at the contract rate and at today\'s rate, and values the open balance at both', () => {
    const m = contractMargin(usd, delivered, [], 'GHS', 80_000, '13.2');
    expect(m.atContractRate).toEqual({ rate: '12.5', revenueMinor: 120_000_000, grossMarginMinor: 43_200_000, marginPerKgMinor: 6_750 });
    expect(m.atTodayRate).toEqual({ rate: '13.2', revenueMinor: 126_720_000, grossMarginMinor: 49_920_000, marginPerKgMinor: 7_800 });
    // 3,600 kg still to deliver at $15 = $54,000: GH₵675,000 at 12.5, GH₵712,800 at 13.2 → GH₵37,800 exposure.
    expect(m.exposure).toEqual({ undeliveredTxnMinor: 5_400_000, atContractRateMinor: 67_500_000, atTodayRateMinor: 71_280_000, differenceMinor: 3_780_000 });
  });

  it('a functional-currency contract has no rate views and no exposure', () => {
    const ghs = { ...usd, currency: 'GHS' as const, contractRate: null };
    const m = contractMargin(ghs, delivered, [], 'GHS', 80_000, '13.2');
    expect(m.atContractRate).toBeNull();
    expect(m.atTodayRate).toBeNull();
    expect(m.exposure).toBeNull();
  });

  it('counts only recognised deliveries in revenue and cost, but all deliveries against the quantity', () => {
    const m = contractMargin(usd, [{ ...delivered[0], recognised: false }], [], 'GHS', 80_000, null);
    expect(m.revenueMinor).toBe(0);
    expect(m.costMinor).toBe(0);
    expect(m.deliveredGrams).toBe(6_400_000);
    expect(m.recognisedGrams).toBe(0);
    expect(m.marginPerKgMinor).toBe(0);
  });

  it('LBC allowances add to the margin', () => {
    const m = contractMargin({ ...usd, currency: 'GHS', contractRate: null }, [{ grams: 1_000_000, revenueTxnMinor: 2_000_000, revenueMinor: 2_000_000, costMinor: 1_950_000, marginMinor: 60_000, haulageMinor: 30_000, recognised: true }], [], 'GHS', 64_000, null);
    expect(m.allowancesMinor).toBe(90_000);
    expect(m.grossMarginMinor).toBe(140_000);
  });
});

describe('position report', () => {
  it('shows oversold, covered and unsold grades from open contracts and stock on hand', () => {
    const rows = positionReport(
      [
        { itemId: 'std', status: 'open', quantityGrams: 10_000_000, deliveredGrams: 6_400_000 },
        { itemId: 'std', status: 'open', quantityGrams: 2_000_000, deliveredGrams: 0 },
        { itemId: 'std', status: 'cancelled', quantityGrams: 50_000_000, deliveredGrams: 0 },
        { itemId: 'g1', status: 'open', quantityGrams: 1_000_000, deliveredGrams: 0 },
        { itemId: 'g2', status: 'closed', quantityGrams: 1_000_000, deliveredGrams: 1_000_000 },
      ],
      [{ itemId: 'std', quantityGrams: 3_000_000 }, { itemId: 'std', quantityGrams: 1_000_000 }, { itemId: 'g1', quantityGrams: 1_000_000 }, { itemId: 'g2', quantityGrams: 500_000 }],
      ['std', 'g1', 'g2', 'g3'],
    );
    expect(rows[0]).toEqual({ itemId: 'std', contractedGrams: 12_000_000, deliveredGrams: 6_400_000, undeliveredGrams: 5_600_000, onHandGrams: 4_000_000, netGrams: -1_600_000, status: 'oversold' });
    expect(rows[1]).toMatchObject({ itemId: 'g1', undeliveredGrams: 1_000_000, onHandGrams: 1_000_000, netGrams: 0, status: 'covered' });
    expect(rows[2]).toMatchObject({ itemId: 'g2', undeliveredGrams: 0, onHandGrams: 500_000, status: 'unsold' });
    expect(rows[3]).toMatchObject({ itemId: 'g3', status: 'idle' });
  });
});

describe('journals', () => {
  const base = { revenueMinor: 124_800_000, costMinor: 76_800_000, inventoryCode: '1030', names };

  it('ordinary delivery: receivable and sales, COGS and inventory', () => {
    const lines = deliveryJournal({ ...base, saleType: 'export', recognizeOn: 'delivery', lbc: null });
    expect(lines.map((l) => [l.accountCode, l.type, l.amount])).toEqual([['1010', 'debit', 124_800_000], ['4005', 'credit', 124_800_000], ['5025', 'debit', 76_800_000], ['1030', 'credit', 76_800_000]]);
    expect(journalBalanced(lines)).toBe(true);
  });

  it('on-acceptance terms: the delivery only moves cost to Goods in Transit; acceptance books revenue and COGS', () => {
    const delivery = deliveryJournal({ ...base, saleType: 'domestic', recognizeOn: 'acceptance', lbc: null });
    expect(delivery.map((l) => [l.accountCode, l.type])).toEqual([['1050', 'debit'], ['1030', 'credit']]);
    const acceptance = acceptanceJournal(124_800_000, 76_800_000, 'domestic', names);
    expect(acceptance.map((l) => [l.accountCode, l.type, l.amount])).toEqual([['1010', 'debit', 124_800_000], ['4001', 'credit', 124_800_000], ['5025', 'debit', 76_800_000], ['1050', 'credit', 76_800_000]]);
    expect(journalBalanced(delivery) && journalBalanced(acceptance)).toBe(true);
  });

  it('LBC gross: producer value to sales, cost to COGS, margin and haulage as separate income, all owed by COCOBOD', () => {
    const lines = deliveryJournal({ revenueMinor: 2_000_000, costMinor: 1_950_000, inventoryCode: '1030', saleType: 'domestic', recognizeOn: 'delivery', lbc: { presentation: 'gross', marginMinor: 60_000, haulageMinor: 30_000 }, names });
    expect(lines.map((l) => [l.accountCode, l.type, l.amount])).toEqual([
      ['1065', 'debit', 2_090_000], ['4020', 'credit', 60_000], ['4025', 'credit', 30_000], ['4001', 'credit', 2_000_000], ['5025', 'debit', 1_950_000], ['1030', 'credit', 1_950_000],
    ]);
    expect(journalBalanced(lines)).toBe(true);
  });

  it('LBC net: no sales and no COGS — cocoa passes through, only margin, haulage and the pass-through difference are income', () => {
    const lines = deliveryJournal({ revenueMinor: 2_000_000, costMinor: 1_950_000, inventoryCode: '1030', saleType: 'domestic', recognizeOn: 'delivery', lbc: { presentation: 'net', marginMinor: 60_000, haulageMinor: 30_000 }, names });
    expect(lines.map((l) => [l.accountCode, l.type, l.amount])).toEqual([['1065', 'debit', 2_090_000], ['4020', 'credit', 60_000], ['4025', 'credit', 30_000], ['1030', 'credit', 1_950_000], ['4030', 'credit', 50_000]]);
    expect(lines.some((l) => l.accountCode === contractAccounts.domesticSales || l.accountCode === contractAccounts.costOfSales)).toBe(false);
    expect(journalBalanced(lines)).toBe(true);
    // Cost above producer value: the pass-through is a debit.
    const loss = deliveryJournal({ revenueMinor: 2_000_000, costMinor: 2_010_000, inventoryCode: '1030', saleType: 'domestic', recognizeOn: 'delivery', lbc: { presentation: 'net', marginMinor: 0, haulageMinor: 0 }, names });
    expect(loss.find((l) => l.accountCode === '4030')).toMatchObject({ type: 'debit', amount: 10_000 });
    expect(journalBalanced(loss)).toBe(true);
  });

  it('seed funds are a liability from receipt, repaid or offset against what CMC owes; CMC payments reduce the receivable', () => {
    expect(seedFundJournal('received', 50_000_000, '1001', names).map((l) => [l.accountCode, l.type])).toEqual([['1001', 'debit'], ['2050', 'credit']]);
    expect(seedFundJournal('repaid', 10_000_000, '1001', names).map((l) => [l.accountCode, l.type])).toEqual([['2050', 'debit'], ['1001', 'credit']]);
    expect(seedFundJournal('offset', 2_090_000, null, names).map((l) => [l.accountCode, l.type])).toEqual([['2050', 'debit'], ['1065', 'credit']]);
    expect(cmcReceiptJournal(1_000_000, '1001', names).map((l) => [l.accountCode, l.type])).toEqual([['1001', 'debit'], ['1065', 'credit']]);
    expect(seedFundJournal('received', 0, '1001', names)).toEqual([]);
  });
});
