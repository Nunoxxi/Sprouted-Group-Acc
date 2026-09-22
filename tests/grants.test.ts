/**
 * Grants: the donor's own reporting periods, budget against actual in both
 * currencies with overspend and underspend flagged, income recognised on
 * receipt or deferred and released as it is earned, in-kind contributions
 * grossed up, and staff time moved onto a grant without changing totals.
 * Pure.
 */

import { describe, expect, it } from 'vitest';

import {
  addMonths,
  budgetVsActual,
  byReportingPeriod,
  conditionRelease,
  conditionSummary,
  elapsedFraction,
  grantPosition,
  inKindJournal,
  incomeAccountFor,
  periodFor,
  receiptJournal,
  releaseJournal,
  reportingPeriods,
  runsGrants,
  spendingRelease,
  staffTimeJournal,
  staffTimeValue,
  toDonor,
  toFunctional,
  type BudgetLine,
  type GrantActual,
  type GrantLike,
} from '@/lib/grants';

const names: Record<string, string> = {
  '1001': 'Cash and Bank',
  '2070': 'Deferred Grant Income',
  '4001': 'Grants - Unrestricted',
  '4005': 'Grants - Restricted',
  '4035': 'Donated Goods & Services',
  '6020': 'Staff Salaries',
  '6055': 'In-kind Goods & Services Used',
};

const balanced = (lines: { amount: number; type: 'debit' | 'credit' }[]) =>
  lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0) ===
  lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);

const grant: GrantLike = {
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  reportingFrequency: 'quarterly',
  reportingStartDate: null,
  reportingDueDays: 30,
};

describe('who has grants', () => {
  it('the programme entity does; the trading entities do not', () => {
    expect(runsGrants('programs')).toBe(true);
    expect(runsGrants('manufacturing')).toBe(false);
  });
});

describe("the donor's reporting periods", () => {
  it('runs quarters across the grant, the last ending on the grant end date', () => {
    const periods = reportingPeriods(grant);
    expect(periods).toHaveLength(4);
    expect(periods[0]).toMatchObject({ start: '2026-01-01', end: '2026-03-31', dueDate: '2026-04-30' });
    expect(periods[3]).toMatchObject({ start: '2026-10-01', end: '2026-12-31', dueDate: '2027-01-30' });
  });

  it("follows the donor's own anchor, not our year", () => {
    const periods = reportingPeriods({ ...grant, startDate: '2026-01-01', reportingStartDate: '2025-11-01', endDate: '2026-10-31' });
    expect(periods[0]).toMatchObject({ start: '2025-11-01', end: '2026-01-31' });
    expect(periods.at(-1)?.end).toBe('2026-10-31');
  });

  it('cuts the last period short rather than running past the grant', () => {
    const periods = reportingPeriods({ ...grant, endDate: '2026-11-15' });
    expect(periods).toHaveLength(4);
    expect(periods[3]).toMatchObject({ start: '2026-10-01', end: '2026-11-15' });
  });

  it('a final-only grant has one period covering the whole thing', () => {
    const periods = reportingPeriods({ ...grant, reportingFrequency: 'final-only' });
    expect(periods).toEqual([{ index: 1, label: 'Final report', start: '2026-01-01', end: '2026-12-31', dueDate: '2027-01-30' }]);
  });

  it('monthly, half-yearly and annual all divide the year', () => {
    expect(reportingPeriods({ ...grant, reportingFrequency: 'monthly' })).toHaveLength(12);
    expect(reportingPeriods({ ...grant, reportingFrequency: 'half-yearly' })).toHaveLength(2);
    expect(reportingPeriods({ ...grant, reportingFrequency: 'annual' })).toHaveLength(1);
  });

  it('keeps the day of the month when the next month is shorter', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-31', 3)).toBe('2026-04-30');
  });

  it('finds the period a date falls in, and nothing outside the grant', () => {
    const periods = reportingPeriods(grant);
    expect(periodFor('2026-05-04', periods)?.index).toBe(2);
    expect(periodFor('2027-01-04', periods)).toBeNull();
  });

  it('measures how far through the grant a date is', () => {
    expect(elapsedFraction(grant, '2025-12-01')).toBe(0);
    expect(elapsedFraction(grant, '2027-01-01')).toBe(1);
    expect(elapsedFraction(grant, '2026-07-02')).toBeCloseTo(0.5, 2);
  });
});

describe('the two currencies', () => {
  it('converts a donor amount to ours and back at the grant rate', () => {
    expect(toFunctional(100_00, '15.5')).toBe(1550_00);
    expect(toDonor(1550_00, '15.5')).toBe(100_00);
  });

  it('a rate of zero converts nothing rather than dividing by it', () => {
    expect(toDonor(1000, '0')).toBe(0);
  });
});

describe('budget against actual', () => {
  const lines: BudgetLine[] = [
    { id: 'b1', code: 'B1', name: 'Farmer training', accountCode: '6001', budgetDonorMinor: 40_000_00 },
    { id: 'b2', code: 'B2', name: 'Seedlings', accountCode: '5020', budgetDonorMinor: 30_000_00 },
    { id: 'b3', code: 'B3', name: 'Monitoring', accountCode: '6005', budgetDonorMinor: 10_000_00 },
  ];
  // The donor budgeted in USD at 15.00 GHS to the dollar.
  const rate = '15.0';
  const actuals: GrantActual[] = [
    { budgetLineId: 'b1', date: '2026-02-10', functionalMinor: 300_000_00 }, // $20,000
    { budgetLineId: 'b2', date: '2026-02-10', functionalMinor: 495_000_00 }, // $33,000 — over
    { budgetLineId: 'b3', date: '2026-02-10', functionalMinor: 1_500_00 }, //   $100 — barely started
  ];
  const options = { rate, asOf: '2026-07-02', underspendThresholdPct: 75 };

  it('shows each line in the donor currency and in ours', () => {
    const result = budgetVsActual(grant, lines, actuals, options);
    expect(result.lines[0]).toMatchObject({
      budgetDonorMinor: 40_000_00,
      budgetFunctionalMinor: 600_000_00,
      actualDonorMinor: 20_000_00,
      actualFunctionalMinor: 300_000_00,
      varianceDonorMinor: 20_000_00,
      varianceFunctionalMinor: 300_000_00,
    });
  });

  it('flags a line spent past its budget', () => {
    const result = budgetVsActual(grant, lines, actuals, options);
    expect(result.lines[1].status).toBe('over');
    expect(result.overspent.map((l) => l.code)).toContain('B2');
  });

  it('flags a line far behind what the elapsed time suggests', () => {
    const result = budgetVsActual(grant, lines, actuals, options);
    expect(result.lines[2].status).toBe('under');
    expect(result.underspent.map((l) => l.code)).toEqual(['B3']);
  });

  it('calls nothing underspent in the first quarter of the grant', () => {
    const result = budgetVsActual(grant, lines, actuals, { ...options, asOf: '2026-02-15' });
    expect(result.underspent).toEqual([]);
  });

  it('a line on course is on track', () => {
    const result = budgetVsActual(grant, lines, actuals, options);
    expect(result.lines[0].status).toBe('on-track'); // half spent, half elapsed
  });

  it('gathers spending with no budget line rather than dropping it', () => {
    const result = budgetVsActual(grant, lines, [...actuals, { budgetLineId: null, date: '2026-03-01', functionalMinor: 7_500_00 }], options);
    const loose = result.lines.at(-1);
    expect(loose).toMatchObject({ code: '—', actualDonorMinor: 500_00, status: 'unbudgeted' });
    expect(result.overspent.map((l) => l.code)).toContain('—');
  });

  it('totals both currencies and the whole-grant status', () => {
    const result = budgetVsActual(grant, lines, actuals, options);
    expect(result.totals.budgetDonorMinor).toBe(80_000_00);
    expect(result.totals.actualDonorMinor).toBe(53_100_00);
    expect(result.totals.actualFunctionalMinor).toBe(796_500_00);
    expect(result.totals.status).toBe('on-track');
  });

  it('counts only postings inside the window it is given', () => {
    const result = budgetVsActual(grant, lines, actuals, { ...options, from: '2026-03-01', to: '2026-03-31' });
    expect(result.totals.actualFunctionalMinor).toBe(0);
  });

  it("splits the grant into the donor's periods, each with its own comparison", () => {
    const periods = byReportingPeriod(grant, lines, actuals, options);
    expect(periods).toHaveLength(4);
    expect(periods[0].comparison.totals.actualFunctionalMinor).toBe(796_500_00);
    expect(periods[1].comparison.totals.actualFunctionalMinor).toBe(0);
  });
});

describe('income recognition', () => {
  it('on receipt: the money is income the day it lands', () => {
    const lines = receiptJournal('on-receipt', true, 100_000_00, '1001', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.find((l) => l.type === 'credit')?.accountCode).toBe('4005');
  });

  it('unrestricted money lands in the unrestricted income account', () => {
    expect(incomeAccountFor(false)).toBe('4001');
    expect(receiptJournal('on-receipt', false, 100_00, '1001', names).find((l) => l.type === 'credit')?.accountCode).toBe('4001');
  });

  it('deferred: the money is a liability until it is earned', () => {
    const lines = receiptJournal('deferred', true, 100_000_00, '1001', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.find((l) => l.type === 'credit')?.accountCode).toBe('2070');
  });

  it('releasing deferred income moves it out of the liability into income', () => {
    const lines = releaseJournal(true, 25_000_00, names);
    expect(balanced(lines)).toBe(true);
    expect(lines.map((l) => [l.accountCode, l.type])).toEqual([
      ['2070', 'debit'],
      ['4005', 'credit'],
    ]);
  });

  it('spending earns the money: the release is the eligible spend not yet released', () => {
    expect(spendingRelease(100_000_00, 0, 30_000_00)).toEqual({ heldMinor: 100_000_00, earnedNotReleasedMinor: 30_000_00, releasableMinor: 30_000_00 });
  });

  it('never releases more than has actually been received', () => {
    const position = spendingRelease(20_000_00, 0, 50_000_00);
    expect(position.releasableMinor).toBe(20_000_00);
    expect(position.earnedNotReleasedMinor).toBe(50_000_00); // the rest is earned, waiting on the next instalment
  });

  it('releases nothing once spending has caught up with what was released', () => {
    expect(spendingRelease(100_000_00, 30_000_00, 30_000_00).releasableMinor).toBe(0);
  });

  it('a condition-based release is capped at what is held, and never negative', () => {
    expect(conditionRelease(100_000_00, 25_000_00, 50_000_00)).toBe(50_000_00);
    expect(conditionRelease(100_000_00, 25_000_00, 90_000_00)).toBe(75_000_00);
    expect(conditionRelease(100_000_00, 100_000_00, 10_000_00)).toBe(0);
  });

  it('nothing posts for a zero or negative amount', () => {
    expect(receiptJournal('deferred', true, 0, '1001', names)).toEqual([]);
    expect(releaseJournal(true, -5, names)).toEqual([]);
  });
});

describe('in-kind contributions', () => {
  it('grosses up: income for the value, expenditure for its use, surplus unchanged', () => {
    const lines = inKindJournal(12_000_00, names);
    expect(balanced(lines)).toBe(true);
    expect(lines.map((l) => [l.accountCode, l.type])).toEqual([
      ['6055', 'debit'],
      ['4035', 'credit'],
    ]);
  });
});

describe('staff time', () => {
  it('values hours at the hourly rate', () => {
    expect(staffTimeValue(37.5, 2_50)).toBe(93_75);
    expect(staffTimeValue(0, 2_50)).toBe(0);
    expect(staffTimeValue(-3, 2_50)).toBe(0);
  });

  it('moves cost onto the grant without changing what was spent in total', () => {
    const lines = staffTimeJournal(93_75, '6020', names);
    expect(balanced(lines)).toBe(true);
    // The same account both sides: the analysis changes, the totals do not.
    expect(new Set(lines.map((l) => l.accountCode))).toEqual(new Set(['6020']));
  });
});

describe('conditions', () => {
  it('counts what is met, outstanding and overdue', () => {
    const summary = conditionSummary(
      [
        { description: 'Baseline survey', dueDate: '2026-03-31', metAt: '2026-03-20' },
        { description: 'Mid-term report', dueDate: '2026-06-30', metAt: null },
        { description: 'Audit', dueDate: null, metAt: null },
      ],
      '2026-07-02',
    );
    expect(summary).toEqual({ total: 3, met: 1, outstanding: 2, overdue: 1 });
  });
});

describe("a grant's position", () => {
  it('deferred: what is recognised is what was released, the rest is a liability', () => {
    const position = grantPosition(100_000_00, '15.0', 900_000_00, 400_000_00, 450_000_00, 'deferred');
    expect(position).toMatchObject({
      awardFunctionalMinor: 1_500_000_00,
      outstandingFunctionalMinor: 600_000_00,
      recognisedFunctionalMinor: 400_000_00,
      deferredFunctionalMinor: 500_000_00,
    });
  });

  it('on receipt: everything received is recognised and nothing is deferred', () => {
    const position = grantPosition(100_000_00, '15.0', 900_000_00, 0, 450_000_00, 'on-receipt');
    expect(position.recognisedFunctionalMinor).toBe(900_000_00);
    expect(position.deferredFunctionalMinor).toBe(0);
    expect(position.spentFraction).toBeCloseTo(0.3, 5);
  });
});
