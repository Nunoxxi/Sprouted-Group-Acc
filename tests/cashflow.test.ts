/**
 * Cash flow forecasting: the 13-week and 12-month buckets, the buying-season
 * curve and the working capital it needs before anything is sold, flows from
 * documents, contracts, grants and recurring costs, balances per currency and
 * combined, the minimum-cash flag, scenarios side by side, and the group.
 * Pure.
 */

import { describe, expect, it } from 'vitest';

import {
  addDays,
  buildForecast,
  buildGroupForecast,
  bucketOf,
  bucketsFor,
  compareScenarios,
  contractFlows,
  convertAt,
  defaultAssumptions,
  documentFlows,
  forecastCurrency,
  grantFlows,
  missingRates,
  monthStart,
  recurringFlows,
  seasonFlows,
  seasonProfile,
  weekStart,
  type Assumptions,
  type Flow,
  type Season,
} from '@/lib/cashflow';

const assumptions: Assumptions = { ...defaultAssumptions };

describe('buckets', () => {
  it('13 weeks run from the Monday of the anchor week', () => {
    const buckets = bucketsFor('weekly-13', '2026-09-24'); // a Thursday
    expect(buckets).toHaveLength(13);
    expect(buckets[0]).toMatchObject({ start: '2026-09-21', end: '2026-09-27', label: 'w/c 2026-09-21' });
    expect(buckets[12].end).toBe('2026-12-20');
  });

  it('a Sunday belongs to the week that started the Monday before', () => {
    expect(weekStart('2026-09-27')).toBe('2026-09-21');
    expect(weekStart('2026-09-21')).toBe('2026-09-21');
  });

  it('12 months run from the first of the anchor month and cover a year', () => {
    const buckets = bucketsFor('monthly-12', '2026-09-24');
    expect(buckets).toHaveLength(12);
    expect(buckets[0]).toMatchObject({ start: '2026-09-01', end: '2026-09-30', label: '2026-09' });
    expect(buckets[5]).toMatchObject({ start: '2027-02-01', end: '2027-02-28' });
    expect(buckets[11].end).toBe('2027-08-31');
    expect(monthStart('2026-09-24')).toBe('2026-09-01');
  });

  it('finds the bucket a date falls in, and nothing outside', () => {
    const buckets = bucketsFor('weekly-13', '2026-09-24');
    expect(bucketOf('2026-09-21', buckets)).toBe(0);
    expect(bucketOf('2026-10-01', buckets)).toBe(1);
    expect(bucketOf('2027-01-01', buckets)).toBeNull();
  });
});

describe('the buying season', () => {
  const season: Season = {
    id: 's1',
    commodityName: 'Raw cashew',
    currency: 'GHS',
    startDate: '2026-02-01',
    peakDate: '2026-03-15',
    endDate: '2026-04-30',
    expectedGrams: 400_000_000, // 400 tonnes
    priceMinorPerKgMinor: 12_00, // GH₵12.00 a kilo
  };

  it('spreads buying as a triangle peaking where the crop does', () => {
    const profile = seasonProfile(season);
    expect(profile[0].date).toBe('2026-02-01');
    expect(profile.at(-1)?.date).toBe('2026-04-30');
    expect(profile.reduce((sum, day) => sum + day.share, 0)).toBeCloseTo(1, 10);
    const peak = profile.find((day) => day.date === '2026-03-15')!;
    expect(peak.share).toBeGreaterThan(profile[0].share);
    expect(peak.share).toBeGreaterThan(profile.at(-1)!.share);
  });

  it('a season peaking on its first day is a ramp down, not a triangle', () => {
    const profile = seasonProfile({ startDate: '2026-02-01', peakDate: '2026-02-01', endDate: '2026-02-10' });
    expect(profile[0].share).toBeGreaterThan(profile.at(-1)!.share);
    expect(profile.reduce((sum, day) => sum + day.share, 0)).toBeCloseTo(1, 10);
  });

  it('the purchases add back to volume times price, to the pesewa', () => {
    const flows = seasonFlows(season, assumptions).filter((flow) => flow.source === 'purchase');
    const total = flows.reduce((sum, flow) => sum + flow.amountMinor, 0);
    expect(total).toBe(-4_800_000_00); // 400,000 kg × GH₵12
  });

  it('money goes out before the produce is bought, by the float lead time', () => {
    const flows = seasonFlows(season, { ...assumptions, floatLeadDays: 7 }).filter((flow) => flow.source === 'purchase');
    expect(flows[0].date).toBe('2026-01-25'); // a week before the season opens
  });

  it('the float is extra working capital that goes out first and comes back at the end', () => {
    const floats = seasonFlows(season, assumptions).filter((flow) => flow.source === 'float');
    expect(floats).toHaveLength(2);
    expect(floats[0].amountMinor).toBeLessThan(0);
    expect(floats[0].date).toBe('2026-01-25');
    expect(floats[1].amountMinor).toBe(-floats[0].amountMinor);
    expect(floats[1].date).toBe('2026-04-30');
    // It nets to nothing over the season: timing, not cost.
    expect(floats[0].amountMinor + floats[1].amountMinor).toBe(0);
  });

  it('a scenario can change the price and the volume', () => {
    const dearer = seasonFlows(season, { ...assumptions, pricePct: 110, volumePct: 90 }).filter((flow) => flow.source === 'purchase');
    expect(dearer.reduce((sum, flow) => sum + flow.amountMinor, 0)).toBe(-4_752_000_00); // 360,000 kg × GH₵13.20
  });

  it('a season with no volume or no price costs nothing', () => {
    expect(seasonFlows({ ...season, expectedGrams: 0 }, assumptions)).toEqual([]);
    expect(seasonFlows({ ...season, priceMinorPerKgMinor: 0 }, assumptions)).toEqual([]);
  });
});

describe('flows from what the books already know', () => {
  it('an invoice is money in on its due date, a bill money out on its', () => {
    const flows = documentFlows(
      [
        { id: 'i1', kind: 'invoice', number: 'INV-0001', contactName: 'Buyer', currency: 'USD', outstandingMinor: 10_000_00, dueDate: '2026-10-15' },
        { id: 'b1', kind: 'bill', number: 'BILL-0001', contactName: 'Supplier', currency: 'GHS', outstandingMinor: 5_000_00, dueDate: '2026-10-20' },
      ],
      assumptions,
    );
    expect(flows[0]).toMatchObject({ source: 'invoice', date: '2026-10-15', amountMinor: 10_000_00, currency: 'USD' });
    expect(flows[1]).toMatchObject({ source: 'bill', date: '2026-10-20', amountMinor: -5_000_00, currency: 'GHS' });
  });

  it('a collection delay moves the money in, and leaves what we owe alone', () => {
    const flows = documentFlows(
      [
        { id: 'i1', kind: 'invoice', number: 'INV-0001', contactName: 'Buyer', currency: 'USD', outstandingMinor: 10_000_00, dueDate: '2026-10-15' },
        { id: 'b1', kind: 'bill', number: 'BILL-0001', contactName: 'Supplier', currency: 'GHS', outstandingMinor: 5_000_00, dueDate: '2026-10-20' },
      ],
      { ...assumptions, collectionDelayDays: 30 },
    );
    expect(flows[0].date).toBe('2026-11-14');
    expect(flows[1].date).toBe('2026-10-20');
  });

  it('a settled document brings nothing', () => {
    expect(documentFlows([{ id: 'i1', kind: 'invoice', number: 'INV-1', contactName: 'X', currency: 'GHS', outstandingMinor: 0, dueDate: '2026-10-15' }], assumptions)).toEqual([]);
  });

  it('an undelivered contract is cash when the buyer pays, terms and delay included', () => {
    const flows = contractFlows(
      [{ id: 'c1', contractNo: 'SC-0001', buyerName: 'Rotterdam', currency: 'EUR', undeliveredMinor: 140_000_00, deliveryDate: '2026-11-30', paymentTermsDays: 30 }],
      { ...assumptions, collectionDelayDays: 14 },
    );
    expect(flows[0]).toMatchObject({ source: 'contract', date: '2027-01-13', currency: 'EUR', amountMinor: 140_000_00 });
  });

  it("a grant's remaining award is spread over the reporting periods still to come", () => {
    const flows = grantFlows({ id: 'g1', code: 'GRT-1', currency: 'USD', outstandingMinor: 30_000_00, periodStarts: ['2026-01-01', '2026-07-01', '2027-01-01', '2027-07-01'] }, '2026-09-01');
    expect(flows).toHaveLength(2);
    expect(flows.map((flow) => flow.date)).toEqual(['2027-01-01', '2027-07-01']);
    expect(flows.reduce((sum, flow) => sum + flow.amountMinor, 0)).toBe(30_000_00);
  });

  it('a grant with nothing left to come, or no periods ahead, brings nothing', () => {
    expect(grantFlows({ id: 'g1', code: 'G', currency: 'USD', outstandingMinor: 0, periodStarts: ['2027-01-01'] }, '2026-09-01')).toEqual([]);
    expect(grantFlows({ id: 'g1', code: 'G', currency: 'USD', outstandingMinor: 100, periodStarts: ['2025-01-01'] }, '2026-09-01')).toEqual([]);
  });

  it('a monthly cost repeats through the window and stops when it ends', () => {
    const flows = recurringFlows({ id: 'r1', name: 'Payroll', currency: 'GHS', amountMinor: 40_000_00, frequency: 'monthly', startDate: '2026-01-31', endDate: null }, '2026-09-01', '2026-12-31');
    expect(flows.map((flow) => flow.date)).toEqual(['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']);
    expect(flows.every((flow) => flow.amountMinor === -40_000_00)).toBe(true);
  });

  it('a weekly cost repeats every seven days', () => {
    const flows = recurringFlows({ id: 'r2', name: 'Casual labour', currency: 'GHS', amountMinor: 1_000_00, frequency: 'weekly', startDate: '2026-09-07', endDate: '2026-09-28' }, '2026-09-01', '2026-12-31');
    expect(flows.map((flow) => flow.date)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
  });

  it('a cost that has already ended brings nothing', () => {
    expect(recurringFlows({ id: 'r3', name: 'Old lease', currency: 'GHS', amountMinor: 100, frequency: 'monthly', startDate: '2025-01-01', endDate: '2025-12-31' }, '2026-09-01', '2026-12-31')).toEqual([]);
  });
});

describe('one currency', () => {
  const buckets = bucketsFor('weekly-13', '2026-09-21');
  const flows: Flow[] = [
    { source: 'invoice', date: '2026-09-23', currency: 'GHS', amountMinor: 50_000_00, description: 'in', reference: 'a' },
    { source: 'bill', date: '2026-09-25', currency: 'GHS', amountMinor: -20_000_00, description: 'out', reference: 'b' },
    { source: 'recurring', date: '2026-10-31', currency: 'GHS', amountMinor: -40_000_00, description: 'payroll', reference: 'c' },
    { source: 'invoice', date: '2027-06-01', currency: 'GHS', amountMinor: 900_00, description: 'way ahead', reference: 'd' },
    { source: 'invoice', date: '2026-09-23', currency: 'USD', amountMinor: 1_000_00, description: 'other currency', reference: 'e' },
  ];

  it('totals each bucket and carries the balance forward', () => {
    const result = forecastCurrency('GHS', 10_000_00, flows, buckets, 0);
    expect(result.buckets[0]).toMatchObject({ inMinor: 50_000_00, outMinor: 20_000_00, netMinor: 30_000_00, closingMinor: 40_000_00 });
    expect(result.buckets[1].closingMinor).toBe(40_000_00);
    expect(result.buckets[5]).toMatchObject({ netMinor: -40_000_00, closingMinor: 0 }); // 31 October falls in the week of the 26th
  });

  it('keeps what falls beyond the horizon rather than dropping it', () => {
    expect(forecastCurrency('GHS', 0, flows, buckets, 0).beyondMinor).toBe(900_00);
  });

  it('ignores other currencies', () => {
    const result = forecastCurrency('GHS', 0, flows, buckets, 0);
    expect(result.buckets[0].inMinor).toBe(50_000_00);
  });

  it('flags the first bucket under the minimum and remembers the lowest point', () => {
    const result = forecastCurrency('GHS', 10_000_00, flows, buckets, 25_000_00);
    expect(result.buckets[0].belowMinimum).toBe(false); // closes at 40,000
    expect(result.buckets[5].belowMinimum).toBe(true); // closes at nil
    expect(result.firstShortfall?.label).toBe('w/c 2026-10-26');
    expect(result.lowestClosingMinor).toBe(0);
  });

  it('keeps each source separate so the table can show where money goes', () => {
    const result = forecastCurrency('GHS', 0, flows, buckets, 0);
    expect(result.buckets[0].bySource).toEqual({ invoice: 50_000_00, bill: -20_000_00 });
  });
});

describe('every currency, then the combined view', () => {
  const flows: Flow[] = [
    { source: 'invoice', date: '2026-09-23', currency: 'USD', amountMinor: 10_000_00, description: 'export', reference: 'a' },
    { source: 'recurring', date: '2026-09-25', currency: 'GHS', amountMinor: -80_000_00, description: 'payroll', reference: 'b' },
  ];
  const withRate: Assumptions = { ...assumptions, rates: { USD: '15.0' }, minimumCashMinor: 20_000_00 };

  it('shows a cedi shortage even while the dollars look healthy', () => {
    const forecast = buildForecast('weekly-13', '2026-09-21', { GHS: 10_000_00, USD: 5_000_00 }, flows, withRate, 'GHS');
    const cedis = forecast.byCurrency.find((row) => row.currency === 'GHS')!;
    const dollars = forecast.byCurrency.find((row) => row.currency === 'USD')!;
    expect(cedis.buckets[0].closingMinor).toBe(-70_000_00);
    expect(cedis.firstShortfall).not.toBeNull();
    expect(dollars.buckets[0].closingMinor).toBe(15_000_00);
    expect(dollars.firstShortfall).toBeNull();
  });

  it('the functional currency comes first', () => {
    const forecast = buildForecast('weekly-13', '2026-09-21', { USD: 1 }, flows, withRate, 'GHS');
    expect(forecast.byCurrency[0].currency).toBe('GHS');
  });

  it('combines at the rate set, so the dollars cover the wages', () => {
    const forecast = buildForecast('weekly-13', '2026-09-21', { GHS: 10_000_00, USD: 5_000_00 }, flows, withRate, 'GHS');
    // 10,000 + 5,000×15 = 85,000 opening; +150,000 in, −80,000 out
    expect(forecast.combined.openingMinor).toBe(85_000_00);
    expect(forecast.combined.buckets[0].closingMinor).toBe(155_000_00);
    expect(forecast.combined.buckets[0].belowMinimum).toBe(false);
  });

  it('names the currencies whose rate is missing rather than quietly using 1:1', () => {
    expect(missingRates(flows, { ...assumptions, rates: {} }, 'GHS')).toEqual(['USD']);
    expect(missingRates(flows, withRate, 'GHS')).toEqual([]);
    expect(convertAt(100, undefined)).toBe(100);
    expect(convertAt(100, '0')).toBe(100);
    expect(convertAt(100, '15.5')).toBe(1550);
  });
});

describe('scenarios side by side', () => {
  const flows: Flow[] = [{ source: 'recurring', date: '2026-09-25', currency: 'GHS', amountMinor: -30_000_00, description: 'payroll', reference: 'a' }];
  const base = buildForecast('weekly-13', '2026-09-21', { GHS: 50_000_00 }, flows, assumptions, 'GHS');
  const worse = buildForecast('weekly-13', '2026-09-21', { GHS: 50_000_00 }, [...flows, { source: 'purchase', date: '2026-09-26', currency: 'GHS', amountMinor: -40_000_00, description: 'extra buying', reference: 'b' }], { ...assumptions, minimumCashMinor: 10_000_00 }, 'GHS');

  it('lines them up on the same buckets and shows the difference', () => {
    const comparison = compareScenarios([
      { name: 'Baseline', forecast: base },
      { name: 'Heavy buying', forecast: worse },
    ]);
    expect(comparison[0].differenceFromFirst[0]).toBe(0);
    expect(comparison[1].closingByBucket[0]).toBe(-20_000_00);
    expect(comparison[1].differenceFromFirst[0]).toBe(-40_000_00);
    expect(comparison[1].lowestClosingMinor).toBe(-20_000_00);
    expect(comparison[1].firstShortfallLabel).toBe('w/c 2026-09-21');
    expect(comparison[0].firstShortfallLabel).toBeNull();
  });

  it('comparing nothing gives nothing', () => {
    expect(compareScenarios([])).toEqual([]);
  });
});

describe('the group', () => {
  const roots = buildForecast('weekly-13', '2026-09-21', { GHS: 100_000_00 }, [{ source: 'recurring', date: '2026-09-23', currency: 'GHS', amountMinor: -40_000_00, description: 'payroll', reference: 'a' }], assumptions, 'GHS');
  const crafts = buildForecast('weekly-13', '2026-09-21', { USD: 20_000_00 }, [{ source: 'purchase', date: '2026-09-23', currency: 'USD', amountMinor: -5_000_00, description: 'buying', reference: 'b' }], { ...assumptions, rates: {} }, 'USD');

  it('adds each entity together at the group rate', () => {
    const group = buildGroupForecast(
      [
        { entityId: 'sprouted-roots', entityName: 'Sprouted Roots', functionalCurrency: 'GHS', forecast: roots },
        { entityId: 'sprouted-crafts', entityName: 'Sprouted Crafts', functionalCurrency: 'USD', forecast: crafts },
      ],
      { USD: '15.0' },
      'GHS',
      50_000_00,
    );
    // 100,000 + 20,000×15 = 400,000 opening
    expect(group.combined.openingMinor).toBe(400_000_00);
    // −40,000 and −5,000×15 = −75,000 in the first week
    expect(group.combined.buckets[0].netMinor).toBe(-115_000_00);
    expect(group.combined.buckets[0].closingMinor).toBe(285_000_00);
    expect(group.entities.map((entity) => entity.entityName)).toEqual(['Sprouted Roots', 'Sprouted Crafts']);
  });

  it('flags the group falling under its own minimum', () => {
    const group = buildGroupForecast([{ entityId: 'sprouted-roots', entityName: 'Sprouted Roots', functionalCurrency: 'GHS', forecast: roots }], {}, 'GHS', 100_000_00);
    expect(group.combined.buckets[0].belowMinimum).toBe(true);
    expect(group.combined.firstShortfall?.label).toBe('w/c 2026-09-21');
  });

  it('a group with no entities is empty rather than broken', () => {
    const group = buildGroupForecast([], {}, 'GHS', 0);
    expect(group.buckets).toEqual([]);
    expect(group.combined.openingMinor).toBe(0);
  });
});

describe('dates', () => {
  it('adds days across a month end', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
