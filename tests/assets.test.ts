/**
 * Fixed assets and tax: straight-line and reducing-balance depreciation that
 * lands exactly on the residual, disposals and their gain or loss, capital
 * allowance pools on classes and rates that are settings rather than code,
 * the tax computation, and the provisional instalments. Pure.
 */

import { describe, expect, it } from 'vitest';

import {
  addMonths,
  allowanceSchedule,
  bookValue,
  depreciationFor,
  depreciationJournal,
  depreciationSchedule,
  disposalJournal,
  disposalResult,
  finalMonth,
  instalments,
  isTaxed,
  monthOf,
  monthsBetween,
  poolAllowance,
  provisionalPaymentJournal,
  provisionalPosition,
  reducingMonthlyRate,
  taxChargeJournal,
  taxComputation,
  type AllowanceClass,
  type AssetLike,
} from '@/lib/assets';

const names: Record<string, string> = {
  '1001': 'Cash and Bank',
  '1200': 'Fixed Assets at Cost',
  '1205': 'Accumulated Depreciation',
  '2055': 'Corporate Income Tax Payable',
  '6040': 'Depreciation',
  '7030': 'Gain or Loss on Asset Disposal',
  '7040': 'Corporate Income Tax',
};

const balanced = (lines: { amount: number; type: 'debit' | 'credit' }[]) =>
  lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0) ===
  lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);

const truck: AssetLike = {
  costMinor: 240_000_00,
  residualMinor: 24_000_00,
  usefulLifeMonths: 60,
  method: 'straight-line',
  inServiceMonth: '2026-01',
};

describe('months', () => {
  it('reads the month off a date and counts between months', () => {
    expect(monthOf('2026-09-22')).toBe('2026-09');
    expect(monthsBetween('2026-01', '2026-09')).toBe(8);
    expect(monthsBetween('2026-09', '2026-01')).toBe(-8);
    expect(addMonths('2026-11', 3)).toBe('2027-02');
  });

  it('knows the last month an asset depreciates in', () => {
    expect(finalMonth(truck)).toBe('2030-12');
  });
});

describe('straight line', () => {
  it('writes off cost less residual evenly', () => {
    expect(depreciationFor(truck, '2026-01', 0)).toBe(3_600_00); // 216,000 over 60
    expect(depreciationFor(truck, '2026-06', 18_000_00)).toBe(3_600_00);
  });

  it('starts the month it goes into service, not before', () => {
    expect(depreciationFor(truck, '2025-12', 0)).toBe(0);
    expect(depreciationFor(truck, '2026-01', 0)).toBeGreaterThan(0);
  });

  it('stops at the end of its life', () => {
    expect(depreciationFor(truck, '2030-12', 212_400_00)).toBeGreaterThan(0);
    expect(depreciationFor(truck, '2031-01', 216_000_00)).toBe(0);
  });

  it('lands exactly on the residual, whatever the rounding', () => {
    const odd: AssetLike = { ...truck, costMinor: 100_000_07, residualMinor: 1_00, usefulLifeMonths: 7 };
    const rows = depreciationSchedule(odd);
    expect(rows).toHaveLength(7);
    expect(rows.at(-1)?.accumulatedMinor).toBe(100_000_07 - 1_00);
    expect(rows.at(-1)?.closingMinor).toBe(1_00);
  });

  it('never writes below the residual even if asked again', () => {
    expect(depreciationFor(truck, '2029-01', 216_000_00)).toBe(0);
  });

  it('an asset with no life depreciates nothing', () => {
    expect(depreciationFor({ ...truck, usefulLifeMonths: 0 }, '2026-01', 0)).toBe(0);
  });
});

describe('reducing balance', () => {
  const machine: AssetLike = { costMinor: 100_000_00, residualMinor: 10_000_00, usefulLifeMonths: 24, method: 'reducing-balance', inServiceMonth: '2026-01' };

  it('derives the rate that reaches the residual at the end of the life', () => {
    const rate = reducingMonthlyRate(machine)!;
    expect(rate).toBeGreaterThan(0);
    expect(Math.pow(1 - rate, 24)).toBeCloseTo(0.1, 8);
  });

  it('charges more early and less later', () => {
    const first = depreciationFor(machine, '2026-01', 0);
    const rows = depreciationSchedule(machine);
    expect(first).toBe(rows[0].chargeMinor);
    expect(rows[0].chargeMinor).toBeGreaterThan(rows[11].chargeMinor);
    expect(rows[11].chargeMinor).toBeGreaterThan(rows[22].chargeMinor);
  });

  it('still lands exactly on the residual', () => {
    const rows = depreciationSchedule(machine);
    expect(rows.at(-1)?.closingMinor).toBe(10_000_00);
    expect(rows.reduce((sum, row) => sum + row.chargeMinor, 0)).toBe(90_000_00);
  });

  it('cannot be used with no residual, because it would never get there', () => {
    expect(reducingMonthlyRate({ costMinor: 100_00, residualMinor: 0, usefulLifeMonths: 12 })).toBeNull();
    expect(reducingMonthlyRate({ costMinor: 100_00, residualMinor: 200_00, usefulLifeMonths: 12 })).toBeNull();
    expect(depreciationFor({ ...machine, residualMinor: 0 }, '2026-01', 0)).toBe(0);
  });
});

describe('the monthly posting', () => {
  it('charges depreciation against what the assets have lost', () => {
    const lines = depreciationJournal(12_500_00, '6040', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.map((l) => [l.accountCode, l.type])).toEqual([
      ['6040', 'debit'],
      ['1205', 'credit'],
    ]);
  });

  it('a month with nothing to charge posts nothing', () => {
    expect(depreciationJournal(0, '6040', names)).toEqual([]);
  });
});

describe('disposal', () => {
  it('works out what was left and what selling made', () => {
    expect(disposalResult({ costMinor: 240_000_00, accumulatedMinor: 180_000_00, proceedsMinor: 75_000_00 })).toEqual({ bookValueMinor: 60_000_00, gainLossMinor: 15_000_00 });
  });

  it('a sale below book value is a loss', () => {
    expect(disposalResult({ costMinor: 240_000_00, accumulatedMinor: 180_000_00, proceedsMinor: 40_000_00 }).gainLossMinor).toBe(-20_000_00);
  });

  it('takes the cost and its depreciation off the books and balances, gain or loss', () => {
    const gain = disposalJournal({ costMinor: 240_000_00, accumulatedMinor: 180_000_00, proceedsMinor: 75_000_00 }, '1001', names);
    expect(balanced(gain)).toBe(true);
    expect(gain.find((l) => l.accountCode === '7030')).toMatchObject({ amount: 15_000_00, type: 'credit' });

    const loss = disposalJournal({ costMinor: 240_000_00, accumulatedMinor: 180_000_00, proceedsMinor: 40_000_00 }, '1001', names);
    expect(balanced(loss)).toBe(true);
    expect(loss.find((l) => l.accountCode === '7030')).toMatchObject({ amount: 20_000_00, type: 'debit' });
  });

  it('scrapping for nothing writes the whole book value off and still balances', () => {
    const lines = disposalJournal({ costMinor: 240_000_00, accumulatedMinor: 200_000_00, proceedsMinor: 0 }, '1001', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.some((l) => l.accountCode === '1001')).toBe(false);
    expect(lines.find((l) => l.accountCode === '7030')).toMatchObject({ amount: 40_000_00, type: 'debit' });
  });

  it('selling a fully written down asset is all gain', () => {
    const lines = disposalJournal({ costMinor: 240_000_00, accumulatedMinor: 240_000_00, proceedsMinor: 5_000_00 }, '1001', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.find((l) => l.accountCode === '7030')).toMatchObject({ amount: 5_000_00, type: 'credit' });
  });

  it('book value is cost less what has gone', () => {
    expect(bookValue(240_000_00, 180_000_00)).toBe(60_000_00);
  });
});

describe('capital allowances', () => {
  // The classes and rates are settings; these are only what a person typed in.
  const pool: AllowanceClass = { id: 'c1', code: '1', name: 'Computers', ratePct: '40', method: 'reducing-balance' };
  const building: AllowanceClass = { id: 'c2', code: '5', name: 'Buildings', ratePct: '10', method: 'straight-line' };

  it('writes a reducing-balance pool down by its rate after additions and disposals', () => {
    const row = poolAllowance({ classId: 'c1', openingMinor: 100_000_00, additionsMinor: 50_000_00, disposalProceedsMinor: 20_000_00, straightLineCostMinor: 0 }, pool);
    expect(row.baseMinor).toBe(130_000_00);
    expect(row.allowanceMinor).toBe(52_000_00);
    expect(row.closingMinor).toBe(78_000_00);
  });

  it('a straight-line class takes its rate on cost, not on the pool', () => {
    const row = poolAllowance({ classId: 'c2', openingMinor: 900_000_00, additionsMinor: 0, disposalProceedsMinor: 0, straightLineCostMinor: 1_000_000_00 }, building);
    expect(row.baseMinor).toBe(1_000_000_00);
    expect(row.allowanceMinor).toBe(100_000_00);
    expect(row.closingMinor).toBe(800_000_00);
  });

  it('never claims more than is left in the pool', () => {
    const row = poolAllowance({ classId: 'c2', openingMinor: 50_000_00, additionsMinor: 0, disposalProceedsMinor: 0, straightLineCostMinor: 1_000_000_00 }, building);
    expect(row.allowanceMinor).toBe(50_000_00);
    expect(row.closingMinor).toBe(0);
  });

  it('a pool emptied by disposals claims nothing and does not go negative', () => {
    const row = poolAllowance({ classId: 'c1', openingMinor: 10_000_00, additionsMinor: 0, disposalProceedsMinor: 30_000_00, straightLineCostMinor: 0 }, pool);
    expect(row.allowanceMinor).toBe(0);
    expect(row.closingMinor).toBe(-20_000_00); // a balancing charge, for the person to see
  });

  it('a rate of nothing claims nothing', () => {
    expect(poolAllowance({ classId: 'c1', openingMinor: 100_00, additionsMinor: 0, disposalProceedsMinor: 0, straightLineCostMinor: 0 }, { ...pool, ratePct: '0' }).allowanceMinor).toBe(0);
  });

  it('totals every class for the year', () => {
    const schedule = allowanceSchedule(
      [
        { classId: 'c1', openingMinor: 100_000_00, additionsMinor: 50_000_00, disposalProceedsMinor: 20_000_00, straightLineCostMinor: 0 },
        { classId: 'c2', openingMinor: 900_000_00, additionsMinor: 0, disposalProceedsMinor: 0, straightLineCostMinor: 1_000_000_00 },
        { classId: 'gone', openingMinor: 1, additionsMinor: 0, disposalProceedsMinor: 0, straightLineCostMinor: 0 },
      ],
      [pool, building],
    );
    expect(schedule.rows).toHaveLength(2); // the class that no longer exists is left out
    expect(schedule.totalAllowanceMinor).toBe(152_000_00);
    expect(schedule.totalClosingMinor).toBe(878_000_00);
  });
});

describe('the tax computation', () => {
  const base = {
    accountingProfitMinor: 500_000_00,
    depreciationMinor: 120_000_00,
    addBacks: [{ id: 'a1', kind: 'add-back' as const, description: 'Entertainment', amountMinor: 20_000_00 }],
    deductions: [{ id: 'd1', kind: 'deduction' as const, description: 'Prior year accrual paid', amountMinor: 10_000_00 }],
    incentives: [],
    capitalAllowancesMinor: 152_000_00,
    ratePct: '25',
    lossBroughtForwardMinor: 0,
  };

  it('adds back depreciation and what is not allowed, then takes off the allowances', () => {
    const result = taxComputation(base);
    expect(result.adjustedProfitMinor).toBe(630_000_00); // 500 + 120 + 20 − 10
    expect(result.chargeableIncomeMinor).toBe(478_000_00);
    expect(result.taxChargeMinor).toBe(119_500_00);
  });

  it('takes an incentive off the chargeable income', () => {
    const result = taxComputation({ ...base, incentives: [{ id: 'i1', kind: 'incentive', description: 'Agro-processing holiday', amountMinor: 478_000_00 }] });
    expect(result.incentivesMinor).toBe(478_000_00);
    expect(result.chargeableIncomeMinor).toBe(0);
    expect(result.taxChargeMinor).toBe(0);
  });

  it('uses losses brought forward, but only as far as the profit goes', () => {
    const result = taxComputation({ ...base, lossBroughtForwardMinor: 600_000_00 });
    expect(result.lossUsedMinor).toBe(478_000_00);
    expect(result.chargeableIncomeMinor).toBe(0);
    expect(result.lossCarriedForwardMinor).toBe(122_000_00);
  });

  it('a loss is not taxed and carries forward, growing', () => {
    const result = taxComputation({ ...base, accountingProfitMinor: -700_000_00, lossBroughtForwardMinor: 50_000_00 });
    expect(result.chargeableIncomeMinor).toBe(0);
    expect(result.taxChargeMinor).toBe(0);
    expect(result.lossCarriedForwardMinor).toBe(772_000_00); // 50,000 brought forward plus this year's 722,000
  });

  it('the rate is a setting, so a different one gives a different charge', () => {
    expect(taxComputation({ ...base, ratePct: '1' }).taxChargeMinor).toBe(4_780_00);
    expect(taxComputation({ ...base, ratePct: '0' }).taxChargeMinor).toBe(0);
  });

  it('an exempt entity has no computation at all', () => {
    expect(isTaxed('exempt')).toBe(false);
    expect(isTaxed('taxable')).toBe(true);
    expect(isTaxed('special-rate')).toBe(true);
  });

  it('the charge is an expense and a liability until it is paid', () => {
    const lines = taxChargeJournal(119_500_00, names);
    expect(balanced(lines)).toBe(true);
    expect(lines.map((l) => [l.accountCode, l.type])).toEqual([
      ['7040', 'debit'],
      ['2055', 'credit'],
    ]);
    expect(taxChargeJournal(0, names)).toEqual([]);
  });
});

describe('provisional tax', () => {
  it('falls due at the end of the third, sixth, ninth and twelfth month of the tax year', () => {
    const rows = instalments('2026-01', 100_000_00, [], '2026-05-01');
    expect(rows.map((row) => row.dueDate)).toEqual(['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31']);
  });

  it('follows a year that does not start in January', () => {
    const rows = instalments('2026-04', 100_000_00, [], '2026-05-01');
    expect(rows.map((row) => row.dueDate)).toEqual(['2026-06-30', '2026-09-30', '2026-12-31', '2027-03-31']);
  });

  it('splits the estimate four ways, the last carrying the rounding', () => {
    const rows = instalments('2026-01', 100_000_03, [], '2026-01-01');
    expect(rows.map((row) => row.estimatedMinor)).toEqual([2_500_001, 2_500_001, 2_500_001, 2_500_000]);
    expect(rows.reduce((sum, row) => sum + row.estimatedMinor, 0)).toBe(100_000_03);
  });

  it('counts what has been paid and flags what is late', () => {
    const rows = instalments('2026-01', 100_000_00, [{ quarter: 1, paidMinor: 25_000_00, paidDate: '2026-03-28' }], '2026-08-01');
    expect(rows[0]).toMatchObject({ paidMinor: 25_000_00, outstandingMinor: 0, overdue: false, paidDate: '2026-03-28' });
    expect(rows[1]).toMatchObject({ outstandingMinor: 25_000_00, overdue: true });
    expect(rows[2].overdue).toBe(false); // not due yet
  });

  it('a part payment leaves the rest outstanding', () => {
    const rows = instalments('2026-01', 100_000_00, [{ quarter: 1, paidMinor: 10_000_00, paidDate: '2026-03-28' }], '2026-04-01');
    expect(rows[0]).toMatchObject({ outstandingMinor: 15_000_00, overdue: true });
  });

  it('sums the position and names the next one due', () => {
    const rows = instalments('2026-01', 100_000_00, [{ quarter: 1, paidMinor: 25_000_00, paidDate: '2026-03-28' }], '2026-08-01');
    const position = provisionalPosition(rows, '2026-08-01');
    expect(position).toMatchObject({ estimatedMinor: 100_000_00, paidMinor: 25_000_00, outstandingMinor: 75_000_00, overdueMinor: 25_000_00 });
    expect(position.next?.quarter).toBe(3);
  });

  it('nothing is next once they are all paid', () => {
    const rows = instalments('2026-01', 100_000_00, [1, 2, 3, 4].map((quarter) => ({ quarter, paidMinor: 25_000_00, paidDate: '2026-12-31' })), '2027-01-01');
    expect(provisionalPosition(rows, '2027-01-01').next).toBeNull();
    expect(provisionalPosition(rows, '2027-01-01').outstandingMinor).toBe(0);
  });

  it('paying takes it off the liability and out of the bank', () => {
    const lines = provisionalPaymentJournal(25_000_00, '1001', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.map((l) => [l.accountCode, l.type])).toEqual([
      ['2055', 'debit'],
      ['1001', 'credit'],
    ]);
  });
});
