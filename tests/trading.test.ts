/**
 * Commodity trading: landed cost per kilogram, shrinkage within and beyond
 * tolerance, agent floats and their reconciliation. Pure.
 */

import { describe, expect, it } from 'vitest';

import { categoriesFor } from '@/lib/inventory';
import {
  abnormalLossValue,
  agentFloatSummaries,
  agentPurchaseJournal,
  allocateByWeight,
  bagsOf,
  floatAdvanceJournal,
  floatPosition,
  floatReturnJournal,
  holdsStock,
  landedCostPerKgMinor,
  qualityFieldsFor,
  shrinkageSplit,
  stockLossJournal,
  tradingAccounts,
} from '@/lib/trading';

const names = { '1030': 'Raw Materials Inventory', '1001': 'Cash and Bank', '1060': 'Agent Float Advances', '5045': 'Stock Loss' };

describe('who holds stock', () => {
  it('traders hold commodities as raw material; Roots holds nothing', () => {
    expect(holdsStock('manufacturing')).toBe(true);
    expect(holdsStock('programs')).toBe(false);
    expect(categoriesFor('manufacturing')).toEqual(['raw-material']);
    expect(categoriesFor('programs')).toEqual([]);
  });

  it('quality fields follow the commodity', () => {
    expect(qualityFieldsFor('cashew').map((f) => f.key)).toEqual(['kor', 'moisturePct', 'nutCount']);
    expect(qualityFieldsFor('cocoa').map((f) => f.key)).toEqual(['cocoaGrade', 'moisturePct', 'beanCount']);
  });

  it('bags convert through the commodity', () => {
    expect(bagsOf(6_400_000, 80_000)).toBe(80);
    expect(bagsOf(6_400_000, 0)).toBe(0);
  });
});

describe('landed cost', () => {
  it('spreads a charge per kilogram over the lots it relates to, summing exactly', () => {
    const shares = allocateByWeight(1_000_01, [{ key: 'a', grams: 6_400_000 }, { key: 'b', grams: 1_600_000 }, { key: 'c', grams: 0 }]);
    expect(shares.a + shares.b + shares.c).toBe(1_000_01);
    expect(shares.a).toBe(800_01); // 80% + the rounding pesewa on the heaviest
    expect(shares.b).toBe(200_00);
    expect(shares.c).toBe(0);
  });

  it('adds the same amount to every kilogram', () => {
    const shares = allocateByWeight(3_000_00, [{ key: 'a', grams: 1_000_000 }, { key: 'b', grams: 2_000_000 }]);
    expect(landedCostPerKgMinor(shares.a, 1_000_000)).toBe(landedCostPerKgMinor(shares.b, 2_000_000));
    expect(landedCostPerKgMinor(shares.a, 1_000_000)).toBe(1_00); // GH₵1/kg
  });

  it('is zero everywhere with nothing to spread', () => {
    expect(allocateByWeight(0, [{ key: 'a', grams: 5 }])).toEqual({ a: 0 });
    expect(allocateByWeight(100, [{ key: 'a', grams: 0 }])).toEqual({ a: 0 });
  });
});

describe('shrinkage', () => {
  it('within the tolerance is normal — absorbed; beyond it is abnormal', () => {
    // 6,400 kg in, 2% tolerance = 128 kg allowance. Weigh out 6,300: 100 kg lost, all normal.
    expect(shrinkageSplit(6_400_000, 0, 6_300_000, 2)).toEqual({ lossGrams: 100_000, normalGrams: 100_000, abnormalGrams: 0, allowanceGrams: 128_000 });
    // Weigh out 6,200: 200 kg lost, 128 normal, 72 abnormal.
    expect(shrinkageSplit(6_400_000, 0, 6_200_000, 2)).toEqual({ lossGrams: 200_000, normalGrams: 128_000, abnormalGrams: 72_000, allowanceGrams: 128_000 });
  });

  it('the tolerance is used up over the lot\'s life, not renewed per weigh-out', () => {
    const second = shrinkageSplit(6_400_000, 100_000, 6_250_000, 2); // 128 − 100 = 28 kg allowance left; 50 lost
    expect(second).toEqual({ lossGrams: 50_000, normalGrams: 28_000, abnormalGrams: 22_000, allowanceGrams: 128_000 });
  });

  it('refuses a weigh-out heavier than what the lot still holds', () => {
    expect(() => shrinkageSplit(1_000, 0, 1_001, 2)).toThrow(/exceeds/);
  });

  it('values abnormal loss at the grade\'s average cost and posts it to stock loss', () => {
    const value = abnormalLossValue(72_000, { quantityGrams: 8_000_000, valueMinor: 9_200_000 }); // GH₵11.50/kg
    expect(value).toBe(82_800);
    const lines = stockLossJournal(value, '1030', names);
    expect(lines).toEqual([
      { accountCode: tradingAccounts.stockLoss, accountName: 'Stock Loss', amount: 82_800, type: 'debit' },
      { accountCode: '1030', accountName: 'Raw Materials Inventory', amount: 82_800, type: 'credit' },
    ]);
    expect(stockLossJournal(0, '1030', names)).toEqual([]);
  });
});

describe('agent floats', () => {
  it('an advance is a receivable; produce and cash back relieve it', () => {
    expect(floatAdvanceJournal(20_000_00, '1001', names).map((l) => [l.accountCode, l.type])).toEqual([['1060', 'debit'], ['1001', 'credit']]);
    expect(agentPurchaseJournal(15_000_00, '1030', names).map((l) => [l.accountCode, l.type])).toEqual([['1030', 'debit'], ['1060', 'credit']]);
    expect(floatReturnJournal(5_000_00, '1001', names).map((l) => [l.accountCode, l.type])).toEqual([['1001', 'debit'], ['1060', 'credit']]);
  });

  it('reconciles only when advanced = purchases + cash returned', () => {
    const advance = { amountMinor: 20_000_00, date: '2026-09-01' };
    expect(floatPosition(advance, 15_000_00, 5_000_00, '2026-09-10', 14)).toMatchObject({ outstandingMinor: 0, reconciles: true, overdue: false, ageDays: 9 });
    expect(floatPosition(advance, 15_000_00, 0, '2026-09-10', 14)).toMatchObject({ outstandingMinor: 5_000_00, reconciles: false, overdue: false });
  });

  it('flags outstanding float older than the limit — and not a reconciled one', () => {
    const advance = { amountMinor: 20_000_00, date: '2026-09-01' };
    expect(floatPosition(advance, 15_000_00, 0, '2026-09-16', 14)).toMatchObject({ ageDays: 15, overdue: true });
    expect(floatPosition(advance, 15_000_00, 5_000_00, '2026-09-30', 14)).toMatchObject({ ageDays: 29, overdue: false, reconciles: true });
    expect(floatPosition(advance, 15_000_00, 0, '2026-09-15', 14).overdue).toBe(false); // exactly the limit is not over it
  });

  it('summarises per agent for the dashboard', () => {
    const agents = [{ id: 'a', name: 'Ama' }, { id: 'b', name: 'Kojo' }];
    const summaries = agentFloatSummaries(agents, [
      { agentId: 'a', status: 'open', position: floatPosition({ amountMinor: 10_000_00, date: '2026-09-01' }, 4_000_00, 0, '2026-09-20', 14) },
      { agentId: 'a', status: 'open', position: floatPosition({ amountMinor: 5_000_00, date: '2026-09-18' }, 0, 0, '2026-09-20', 14) },
      { agentId: 'a', status: 'reconciled', position: floatPosition({ amountMinor: 8_000_00, date: '2026-08-01' }, 8_000_00, 0, '2026-09-20', 14) },
    ]);
    expect(summaries[0]).toEqual({ agentId: 'a', agentName: 'Ama', openFloats: 2, outstandingMinor: 11_000_00, oldestAgeDays: 19, overdue: true });
    expect(summaries[1]).toEqual({ agentId: 'b', agentName: 'Kojo', openFloats: 0, outstandingMinor: 0, oldestAgeDays: 0, overdue: false });
  });
});
