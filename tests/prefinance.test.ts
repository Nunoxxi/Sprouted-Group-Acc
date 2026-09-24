/**
 * Pre-finance: the loan, the advances, the quality settlement that decides
 * what an aggregator is actually owed, and the measures that say how many
 * times the borrowed money went round before it had to be repaid.
 */

import { describe, expect, it } from 'vitest';

import {
  accrueInterest,
  addDays,
  ageAdvances,
  aggregatorRecord,
  averageCycleDays,
  checkExposure,
  cycleMargin,
  cycleStages,
  dailyInterest,
  daysBetween,
  drawnOn,
  headroom,
  idleCost,
  interestDays,
  interestOn,
  position,
  provisionTotal,
  recycleMeasures,
  repaymentRunway,
  settleAdvance,
  settleQuality,
  totalDrawn,
  valueOf,
  type Cycle,
  type Facility,
  type OpenAdvance,
  type Tranche,
} from '@/lib/prefinance';

const facility: Facility = { limitMinor: 5_000_000_00, ratePct: 24, basis: 'actual/365', repaymentDate: '2027-03-31' };

describe('money and weight', () => {
  it('values a weight at a price a kilogram, to the pesewa', () => {
    // 1,000 kg at GHS 12.50/kg
    expect(valueOf(1_000_000, 1250)).toBe(1_250_000);
  });

  it('rounds to whole pesewas rather than carrying a fraction', () => {
    expect(valueOf(333, 1000)).toBe(333);
    expect(Number.isInteger(valueOf(12_345, 1237))).toBe(true);
  });

  it('counts days between dates, and adds them', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(addDays('2027-03-31', -45)).toBe('2027-02-14');
  });
});

describe('interest', () => {
  it('counts actual days on the actual bases, and thirty-day months on 30/360', () => {
    expect(interestDays('2026-01-31', '2026-02-28', 'actual/365')).toBe(28);
    expect(interestDays('2026-01-31', '2026-02-28', '30/360')).toBe(28);
    expect(interestDays('2026-01-01', '2026-04-01', '30/360')).toBe(90);
  });

  it('a 360-day year costs more than a 365-day year at the same rate', () => {
    const on365 = interestOn(1_000_000_00, 24, 90, 'actual/365');
    const on360 = interestOn(1_000_000_00, 24, 90, 'actual/360');
    expect(on360).toBeGreaterThan(on365);
  });

  it('GHS 1,000,000 at 24% for 365 days is GHS 240,000', () => {
    expect(interestOn(1_000_000_00, 24, 365, 'actual/365')).toBe(240_000_00);
  });

  it('nothing accrues on nothing, on no days, or at no rate', () => {
    expect(interestOn(0, 24, 90, 'actual/365')).toBe(0);
    expect(interestOn(1_000_00, 24, 0, 'actual/365')).toBe(0);
    expect(interestOn(1_000_00, 0, 90, 'actual/365')).toBe(0);
  });

  it('a day of interest is the year divided by the basis', () => {
    expect(dailyInterest(365_000_00, 10, 'actual/365')).toBeCloseTo(100_00, 5);
  });
});

describe('the facility and its tranches', () => {
  const tranches: Tranche[] = [
    { id: 't1', drawnOn: '2026-10-01', amountMinor: 2_000_000_00 },
    { id: 't2', drawnOn: '2026-11-15', amountMinor: 1_500_000_00, repaidOn: '2027-01-31' },
  ];

  it('counts only what is drawn and not yet repaid', () => {
    expect(drawnOn(tranches, '2026-09-30')).toBe(0);
    expect(drawnOn(tranches, '2026-10-02')).toBe(2_000_000_00);
    expect(drawnOn(tranches, '2026-12-01')).toBe(3_500_000_00);
    expect(drawnOn(tranches, '2027-02-01')).toBe(2_000_000_00);
  });

  it('total drawn counts everything ever taken, repaid or not', () => {
    expect(totalDrawn(tranches)).toBe(3_500_000_00);
  });

  it('headroom is what is left of the limit, never negative', () => {
    expect(headroom(facility, tranches, '2026-12-01')).toBe(1_500_000_00);
    expect(headroom({ ...facility, limitMinor: 1_000_000_00 }, tranches, '2026-12-01')).toBe(0);
  });

  it('accrues on each tranche only for the days it was outstanding', () => {
    const rows = accrueInterest(tranches, facility, '2026-10-01', '2026-11-01');
    expect(rows).toHaveLength(1); // the second tranche had not been drawn yet
    expect(rows[0].trancheId).toBe('t1');
    expect(rows[0].days).toBe(31);
    expect(rows[0].amountMinor).toBe(interestOn(2_000_000_00, 24, 31, 'actual/365'));
  });

  it('stops accruing a tranche on the day it is repaid', () => {
    const rows = accrueInterest(tranches, facility, '2027-01-01', '2027-03-01');
    const second = rows.find((row) => row.trancheId === 't2');
    expect(second?.days).toBe(30); // 1 to 31 January, not to March
  });
});

describe('quality: what was agreed against what turned up', () => {
  const agreed = { outturn: 48, moisturePct: 8 };
  const price = 1500; // GHS 15.00 a kilogram

  it('a load exactly on basis settles at the agreed value, with no variance', () => {
    const s = settleQuality(agreed, price, { grams: 1_000_000, outturn: 48, moisturePct: 8 });
    expect(s.settledValueMinor).toBe(s.valueAtBasisMinor);
    expect(s.varianceMinor).toBe(0);
    expect(s.moistureVarianceMinor).toBe(0);
    expect(s.outturnVarianceMinor).toBe(0);
  });

  it('poor outturn moves the price down in proportion', () => {
    // 45 against a basis of 48 is 93.75% of the price.
    const s = settleQuality(agreed, price, { grams: 1_000_000, outturn: 45, moisturePct: 8 });
    expect(s.adjustedPricePerKgMinor).toBe(1406); // 1500 × 45/48, to the pesewa
    expect(s.outturnVarianceMinor).toBeLessThan(0);
    expect(s.moistureVarianceMinor).toBe(0);
  });

  it('good outturn earns more, because outturn is what a processor buys', () => {
    const s = settleQuality(agreed, price, { grams: 1_000_000, outturn: 50, moisturePct: 8 });
    expect(s.adjustedPricePerKgMinor).toBeGreaterThan(price);
    expect(s.outturnVarianceMinor).toBeGreaterThan(0);
  });

  it('wet nuts lose weight, because water is not cashew', () => {
    const s = settleQuality(agreed, price, { grams: 1_000_000, outturn: 48, moisturePct: 12 });
    expect(s.adjustedGrams).toBeLessThan(1_000_000);
    expect(s.moistureVarianceMinor).toBeLessThan(0);
    expect(s.outturnVarianceMinor).toBe(0);
  });

  it('a drier load than agreed earns no bonus weight', () => {
    const s = settleQuality(agreed, price, { grams: 1_000_000, outturn: 48, moisturePct: 5 });
    expect(s.adjustedGrams).toBe(1_000_000);
    expect(s.moistureVarianceMinor).toBe(0);
  });

  it('the two effects add back exactly to the total variance', () => {
    for (const delivered of [
      { grams: 1_000_000, outturn: 45, moisturePct: 12 },
      { grams: 847_312, outturn: 50.5, moisturePct: 9.4 },
      { grams: 1_234_567, outturn: 43.2, moisturePct: 8 },
    ]) {
      const s = settleQuality(agreed, price, delivered);
      expect(s.moistureVarianceMinor + s.outturnVarianceMinor).toBe(s.varianceMinor);
    }
  });

  it('reports the differences as numbers a person can argue with', () => {
    const s = settleQuality(agreed, price, { grams: 1_000_000, outturn: 45.5, moisturePct: 11.2 });
    expect(s.outturnDifference).toBe(-2.5);
    expect(s.moistureDifference).toBe(3.2);
  });
});

describe('settling the advance', () => {
  it('a delivery worth less than the advance leaves the aggregator owing', () => {
    const s = settleAdvance(500_000_00, 420_000_00, 'collect-shortfall');
    expect(s.differenceMinor).toBe(80_000_00);
    expect(s.outcome).toBe('collect-shortfall');
    expect(s.explanation).toContain('80000.00');
  });

  it('or can be carried against their next advance instead', () => {
    expect(settleAdvance(500_000_00, 420_000_00, 'carry-forward').outcome).toBe('carry-forward');
  });

  it('a delivery worth more than the advance is a top-up we owe them', () => {
    const s = settleAdvance(500_000_00, 560_000_00);
    expect(s.differenceMinor).toBe(-60_000_00);
    expect(s.outcome).toBe('pay-top-up');
  });

  it('cannot call a shortfall a top-up by asking for one', () => {
    expect(settleAdvance(500_000_00, 420_000_00, 'pay-top-up').outcome).toBe('carry-forward');
  });

  it('an exact match is square', () => {
    expect(settleAdvance(500_000_00, 500_000_00).outcome).toBe('square');
  });
});

describe('ageing and provisioning', () => {
  const thresholds = { flagAfterDays: 14, provisionAfterDays: 60, provisionPct: 50 };
  const advances: OpenAdvance[] = [
    { id: 'a1', aggregatorId: 'g1', aggregatorName: 'Kwame', amountMinor: 100_000_00, advancedOn: '2026-10-01', expectedOn: '2026-10-21' },
    { id: 'a2', aggregatorId: 'g2', aggregatorName: 'Adjoa', amountMinor: 200_000_00, advancedOn: '2026-11-01', expectedOn: '2026-11-21' },
    { id: 'a3', aggregatorId: 'g3', aggregatorName: 'Yaw', amountMinor: 50_000_00, advancedOn: '2026-12-01', expectedOn: '2026-12-21' },
  ];

  it('puts the most overdue first', () => {
    const aged = ageAdvances(advances, thresholds, '2026-12-25');
    expect(aged.map((row) => row.aggregatorName)).toEqual(['Kwame', 'Adjoa', 'Yaw']);
  });

  it('is not overdue before the expected date', () => {
    const aged = ageAdvances(advances, thresholds, '2026-10-15');
    expect(aged.find((row) => row.id === 'a1')?.daysOverdue).toBe(-6);
    expect(aged.find((row) => row.id === 'a1')?.flagged).toBe(false);
  });

  it('flags past the first threshold and provides past the second', () => {
    const aged = ageAdvances(advances, thresholds, '2026-12-25');
    const kwame = aged.find((row) => row.id === 'a1')!;
    expect(kwame.daysOverdue).toBe(65);
    expect(kwame.flagged).toBe(true);
    expect(kwame.provisionMinor).toBe(50_000_00); // half of 100,000

    const yaw = aged.find((row) => row.id === 'a3')!;
    expect(yaw.flagged).toBe(false);
    expect(yaw.provisionMinor).toBe(0);
  });

  it('provides nothing when the percentage is nil', () => {
    const aged = ageAdvances(advances, { ...thresholds, provisionPct: 0 }, '2027-06-01');
    expect(provisionTotal(aged)).toBe(0);
  });

  it('totals the provision across every advance old enough', () => {
    const aged = ageAdvances(advances, thresholds, '2027-06-01');
    expect(provisionTotal(aged)).toBe(175_000_00); // half of 350,000
  });
});

describe("an aggregator's record", () => {
  const history = {
    advancedMinor: 1_000_000_00,
    deliveredValueMinor: 940_000_00,
    deliveries: 4,
    daysToDeliver: [18, 24, 31, 27],
    qualityVariances: [-2_000_00, -3_500_00, -1_000_00, 500_00],
    unrecoveredMinor: 12_000_00,
    currentExposureMinor: 300_000_00,
    exposureLimitMinor: 400_000_00,
  };

  it('averages the days and the quality effect', () => {
    const record = aggregatorRecord(history);
    expect(record.averageDaysToDeliver).toBe(25);
    expect(record.averageQualityVarianceMinor).toBe(-150_000); // GHS 1,500 average shortfall
  });

  it('says how much more they may hold', () => {
    expect(aggregatorRecord(history).availableMinor).toBe(100_000_00);
  });

  it('has no average and no limit to speak of for somebody new', () => {
    const record = aggregatorRecord({ ...history, deliveries: 0, daysToDeliver: [], qualityVariances: [], exposureLimitMinor: 0 });
    expect(record.averageDaysToDeliver).toBeNull();
    expect(record.averageQualityVarianceMinor).toBeNull();
    expect(record.availableMinor).toBeNull();
  });

  it('warns before an advance that would pass the limit, and says why it matters', () => {
    const record = aggregatorRecord(history);
    const check = checkExposure(record, 150_000_00, 'Kwame');
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.warning).toContain('past the');
    expect(check.ok === false && check.warning).toContain('Nothing is held as security');
  });

  it('allows one that fits, and never blocks when no limit is set', () => {
    expect(checkExposure(aggregatorRecord(history), 100_000_00, 'Kwame').ok).toBe(true);
    expect(checkExposure(aggregatorRecord({ ...history, exposureLimitMinor: 0 }), 9_000_000_00, 'Kwame').ok).toBe(true);
  });
});

describe('cycles', () => {
  const cycle: Cycle = {
    id: 'c1',
    reference: 'CYCLE-1',
    drawnOn: '2026-10-01',
    deployedOn: '2026-10-05',
    deployedMinor: 1_000_000_00,
    firstDeliveryOn: '2026-10-29',
    soldOn: '2026-11-10',
    cashBackOn: '2026-11-25',
    proceedsMinor: 1_260_000_00,
    costOfGoodsMinor: 1_000_000_00,
    landedCostMinor: 40_000_00,
    grams: 80_000_000, // 80 tonnes
  };

  it('breaks the days into the four stages, so you can see where time went', () => {
    const stages = cycleStages(cycle);
    expect(stages).toEqual({ drawdownToAdvance: 4, advanceToDelivery: 24, deliveryToSale: 12, saleToCash: 15, totalDays: 55 });
  });

  it('leaves a stage empty until it has happened', () => {
    const stages = cycleStages({ ...cycle, soldOn: null, cashBackOn: null });
    expect(stages.deliveryToSale).toBeNull();
    expect(stages.totalDays).toBeNull();
  });

  it('averages only the cycles that finished', () => {
    const unfinished: Cycle = { ...cycle, id: 'c2', cashBackOn: null };
    expect(averageCycleDays([cycle, unfinished])).toBe(55);
    expect(averageCycleDays([unfinished])).toBeNull();
  });

  it('margin is proceeds less goods, less landed cost, less the interest for the days held', () => {
    const margin = cycleMargin(cycle, facility);
    expect(margin.grossMarginMinor).toBe(220_000_00);
    expect(margin.financeCostMinor).toBe(interestOn(1_000_000_00, 24, 55, 'actual/365'));
    expect(margin.netMarginMinor).toBe(margin.grossMarginMinor - margin.financeCostMinor);
    expect(margin.netMarginMinor).toBeLessThan(margin.grossMarginMinor);
  });

  it('and is given per kilogram as well', () => {
    const margin = cycleMargin(cycle, facility);
    expect(margin.grossMarginPerKgMinor).toBe(275); // GHS 2.75 a kilogram over 80 tonnes
    expect(margin.netMarginPerKgMinor).toBeLessThan(margin.grossMarginPerKgMinor!);
  });

  it('a cycle that moved no weight has no per-kilogram figure rather than a divide by zero', () => {
    const margin = cycleMargin({ ...cycle, grams: 0 }, facility);
    expect(margin.grossMarginPerKgMinor).toBeNull();
  });

  it('a short cycle carries less finance cost than a long one', () => {
    const slow = cycleMargin({ ...cycle, cashBackOn: '2027-01-25' }, facility);
    const quick = cycleMargin(cycle, facility);
    expect(slow.financeCostMinor).toBeGreaterThan(quick.financeCostMinor);
  });
});

describe('how many times the money went round', () => {
  const cycles: Cycle[] = [
    { id: 'c1', reference: '1', deployedOn: '2026-10-05', deployedMinor: 2_000_000_00, drawnOn: '2026-10-01', cashBackOn: '2026-11-25' },
    { id: 'c2', reference: '2', deployedOn: '2026-12-01', deployedMinor: 2_000_000_00, drawnOn: '2026-11-28', cashBackOn: '2027-01-20' },
    { id: 'c3', reference: '3', deployedOn: '2027-02-01', deployedMinor: 1_500_000_00, drawnOn: '2027-01-28' },
  ];

  it('the cash measure is everything deployed against the limit', () => {
    const measures = recycleMeasures(facility, cycles);
    expect(measures.totalDeployedMinor).toBe(5_500_000_00);
    expect(measures.cashBasedTimes).toBe(1.1); // 5.5m deployed on a 5m limit
  });

  it('the cycle measure is a year at the current pace', () => {
    const measures = recycleMeasures(facility, cycles);
    expect(measures.averageCycleDays).toBe(54); // (55 + 53) / 2
    expect(measures.cycleBasedTimes).toBe(Math.round((365 / 54) * 100) / 100);
    expect(measures.completedCycles).toBe(2);
  });

  it('says nothing rather than zero when nothing has completed', () => {
    const measures = recycleMeasures(facility, [cycles[2]]);
    expect(measures.cycleBasedTimes).toBeNull();
    expect(measures.averageCycleDays).toBeNull();
  });
});

describe('the cost of money standing still', () => {
  it('charges the full rate on whatever is drawn but not working', () => {
    const days = [
      { date: '2026-10-01', drawnMinor: 1_000_000_00, deployedMinor: 0 },
      { date: '2026-10-02', drawnMinor: 1_000_000_00, deployedMinor: 400_000_00 },
      { date: '2026-10-03', drawnMinor: 1_000_000_00, deployedMinor: 1_000_000_00 },
    ];
    const cost = idleCost(days, facility);
    expect(cost.idleDays).toBe(2);
    expect(cost.peakIdleMinor).toBe(1_000_000_00);
    expect(cost.idleBalanceDaysMinor).toBe(1_600_000_00);
    expect(cost.costMinor).toBeGreaterThan(0);
  });

  it('costs nothing on a day the money is fully deployed', () => {
    const cost = idleCost([{ date: '2026-10-03', drawnMinor: 1_000_000_00, deployedMinor: 1_000_000_00 }], facility);
    expect(cost).toEqual({ idleDays: 0, idleBalanceDaysMinor: 0, peakIdleMinor: 0, costMinor: 0 });
  });

  it('never treats over-deployment as negative idleness', () => {
    const cost = idleCost([{ date: '2026-10-03', drawnMinor: 500_000_00, deployedMinor: 900_000_00 }], facility);
    expect(cost.costMinor).toBe(0);
  });
});

describe('the last day a new advance can still get back', () => {
  it('works back from the repayment date by one average cycle', () => {
    const runway = repaymentRunway(facility, 54, '2026-12-01');
    expect(runway.lastSafeAdvanceDate).toBe('2027-02-05');
    expect(runway.closed).toBe(false);
    expect(runway.explanation).toContain('2027-02-05');
  });

  it('warns as it comes close', () => {
    expect(repaymentRunway(facility, 54, '2027-01-28').closingSoon).toBe(true);
    expect(repaymentRunway(facility, 54, '2026-12-01').closingSoon).toBe(false);
  });

  it('says plainly once it has passed', () => {
    const runway = repaymentRunway(facility, 54, '2027-02-20');
    expect(runway.closed).toBe(true);
    expect(runway.explanation).toContain('funded another way');
  });

  it('says there is nothing to work from until a cycle has completed', () => {
    const runway = repaymentRunway(facility, null, '2026-12-01');
    expect(runway.lastSafeAdvanceDate).toBeNull();
    expect(runway.explanation).toContain('No cycle has completed');
  });
});

describe('the position, at a glance', () => {
  it('adds up to a picture somebody can act on', () => {
    const tranches: Tranche[] = [{ id: 't1', drawnOn: '2026-10-01', amountMinor: 3_000_000_00 }];
    const openAdvances: OpenAdvance[] = [
      { id: 'a1', aggregatorId: 'g1', aggregatorName: 'Kwame', amountMinor: 800_000_00, advancedOn: '2026-11-01', expectedOn: '2026-11-21' },
    ];
    const cycles: Cycle[] = [
      { id: 'c1', reference: '1', deployedOn: '2026-10-05', deployedMinor: 2_000_000_00, drawnOn: '2026-10-01', cashBackOn: '2026-11-25' },
    ];

    const p = position({
      facility,
      tranches,
      cycles,
      openAdvances,
      thresholds: { flagAfterDays: 14, provisionAfterDays: 60, provisionPct: 50 },
      stockHeldMinor: 1_200_000_00,
      asOf: '2026-12-01',
    });

    expect(p.drawnMinor).toBe(3_000_000_00);
    expect(p.headroomMinor).toBe(2_000_000_00);
    expect(p.deployedMinor).toBe(2_000_000_00); // 800k with aggregators + 1.2m in stock
    expect(p.idleMinor).toBe(1_000_000_00);
    expect(p.advancesOutstandingMinor).toBe(800_000_00);
    expect(p.daysToRepayment).toBe(120);
    expect(p.completedCycles).toBe(1);
    expect(p.runway.lastSafeAdvanceDate).not.toBeNull();
  });

  it('never shows negative idle money when more is deployed than drawn', () => {
    const p = position({
      facility,
      tranches: [{ id: 't1', drawnOn: '2026-10-01', amountMinor: 500_000_00 }],
      cycles: [],
      openAdvances: [],
      thresholds: { flagAfterDays: 14, provisionAfterDays: 60, provisionPct: 50 },
      stockHeldMinor: 900_000_00,
      asOf: '2026-12-01',
    });
    expect(p.idleMinor).toBe(0);
  });
});
