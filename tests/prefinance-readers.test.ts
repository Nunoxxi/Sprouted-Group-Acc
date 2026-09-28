/**
 * The derived figures the pre-finance readers add to every row.
 *
 * These are the numbers a page and a report both show, so if they are wrong
 * the two will agree with each other and both be wrong — which is the hardest
 * kind of mistake to notice. They are worth stating separately from the rows
 * they are derived from.
 *
 * Only the pure row-to-record mapping is exercised; the queries around it
 * belong to Prisma.
 */

import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { advanceRecord, cycleRecord, facilityRecord } from '@/lib/data/prefinance';

const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const dec = (value: number | string) => new Prisma.Decimal(value);

type FacilityRow = Parameters<typeof facilityRecord>[0];
type AdvanceRow = Parameters<typeof advanceRecord>[0];
type CycleRow = Parameters<typeof cycleRecord>[0];

function facility(overrides: Partial<FacilityRow> = {}): FacilityRow {
  return {
    id: 'facility-1',
    entityId: 'crafts',
    reference: 'FAC-1',
    lenderId: null,
    limitMinor: 50_000_000n,
    ratePct: dec('28.500'),
    basis: 'ACTUAL_365',
    startsOn: date('2026-09-01'),
    endsOn: null,
    status: 'ACTIVE',
    notes: null,
    createdById: null,
    createdAt: date('2026-09-01'),
    updatedAt: date('2026-09-01'),
    lender: null,
    tranches: [],
    ...overrides,
  } as FacilityRow;
}

function advance(overrides: Partial<AdvanceRow> = {}): AdvanceRow {
  return {
    id: 'advance-1',
    entityId: 'crafts',
    aggregatorId: 'contact-1',
    reference: 'ADV-1',
    advancedOn: date('2026-09-05'),
    expectedOn: date('2026-09-19'),
    amountMinor: 5_000_000n,
    bankAccountId: null,
    facilityId: null,
    pricePerKgMinor: 950n,
    outturn: dec(48),
    moisturePct: dec(8),
    moistureMethod: 'WEIGHT_DEDUCTION',
    moisturePctPerPoint: null,
    outturnMethod: 'PROPORTIONAL',
    outturnMinorPerPoint: null,
    outturnBonus: null,
    status: 'OPEN',
    settledOn: null,
    journalEntryId: null,
    notes: null,
    createdById: null,
    createdAt: date('2026-09-05'),
    updatedAt: date('2026-09-05'),
    aggregator: { name: 'Kwame Mensah', exposureLimitMinor: null },
    bankAccount: null,
    facility: null,
    createdBy: null,
    deliveries: [],
    ...overrides,
  } as AdvanceRow;
}

describe('what a facility has left to draw', () => {
  it('counts only tranches that have not been repaid, so repaying frees the room again', () => {
    const record = facilityRecord(
      facility({
        tranches: [
          { amountMinor: 30_000_000n, repaidOn: null, interestMinor: 700_000n },
          { amountMinor: 10_000_000n, repaidOn: date('2026-10-01'), interestMinor: 200_000n },
        ],
      }),
    );
    expect(record.outstandingMinor).toBe(30_000_000);
    expect(record.drawnEverMinor).toBe(40_000_000);
    expect(record.headroomMinor).toBe(20_000_000);
    // Interest is charged on everything drawn, repaid or not.
    expect(record.accruedInterestMinor).toBe(900_000);
  });

  it('never reports negative headroom, even if a limit was somehow cut below what is drawn', () => {
    const record = facilityRecord(facility({ limitMinor: 10_000_000n, tranches: [{ amountMinor: 30_000_000n, repaidOn: null, interestMinor: 0n }] }));
    expect(record.headroomMinor).toBe(0);
  });

  it('keeps the rate exact, as text, rather than rounding it into a number', () => {
    expect(facilityRecord(facility({ ratePct: dec('28.500') })).ratePct).toBe('28.5');
    expect(facilityRecord(facility({ ratePct: dec('7.125') })).ratePct).toBe('7.125');
  });
});

describe('what an aggregator still owes', () => {
  it('is the advance less everything settled against it', () => {
    const record = advanceRecord(advance({ deliveries: [{ settledValueMinor: 2_585_837n }, { settledValueMinor: 2_328_000n }] }));
    expect(record.deliveredValueMinor).toBe(4_913_837);
    expect(record.outstandingMinor).toBe(86_163);
    expect(record.deliveryCount).toBe(2);
  });

  // A load worth more than the advance is money owed the other way. That is a
  // payable, not a debt with a minus sign in front of it.
  it('never goes negative when the loads came to more than the advance', () => {
    const record = advanceRecord(advance({ deliveries: [{ settledValueMinor: 6_000_000n }] }));
    expect(record.outstandingMinor).toBe(0);
  });

  it('carries the quality terms that were agreed, not whatever the defaults now say', () => {
    const record = advanceRecord(
      advance({ outturn: dec(46), moisturePct: dec(10), moistureMethod: 'PRICE_DEDUCTION', moisturePctPerPoint: dec('1.5'), outturnMethod: 'PER_POINT', outturnMinorPerPoint: 2_000n }),
    );
    expect(record.terms).toEqual({
      outturn: 46,
      moisturePct: 10,
      moistureMethod: 'price-deduction',
      moisturePctPerPoint: 1.5,
      outturnMethod: 'per-point',
      outturnMinorPerPoint: 2000,
      outturnBonus: null,
    });
  });

  it('reports the exposure limit from the contact, and null when none is set', () => {
    expect(advanceRecord(advance()).exposureLimitMinor).toBeNull();
    expect(advanceRecord(advance({ aggregator: { name: 'Kwame Mensah', exposureLimitMinor: 10_000_000n } })).exposureLimitMinor).toBe(10_000_000);
  });
});

describe('when a cycle counts as finished', () => {
  const cycle = (overrides: Partial<CycleRow> = {}): CycleRow =>
    ({
      id: 'cycle-1',
      entityId: 'crafts',
      reference: 'CYC-1',
      facilityId: null,
      drawnOn: date('2026-09-02'),
      advancedOn: date('2026-09-05'),
      deliveredOn: date('2026-09-20'),
      processedOn: null,
      soldOn: date('2026-10-10'),
      cashBackOn: null,
      drawnMinor: 30_000_000n,
      advancedMinor: 5_000_000n,
      proceedsMinor: 0n,
      costsMinor: 0n,
      notes: null,
      createdById: null,
      createdAt: date('2026-09-02'),
      updatedAt: date('2026-09-02'),
      facility: null,
      ...overrides,
    }) as CycleRow;

  it('is not finished when the goods are sold but the money has not arrived', () => {
    expect(cycleRecord(cycle()).isComplete).toBe(false);
  });

  it('is finished when the cash is back', () => {
    expect(cycleRecord(cycle({ cashBackOn: date('2026-11-05') })).isComplete).toBe(true);
  });
});
