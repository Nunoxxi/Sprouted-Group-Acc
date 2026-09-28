/**
 * Pre-finance readers: facilities and what is drawn against them, advances and
 * what has been delivered against those, and the cycles the money goes round
 * in. Prisma rows in, JSON-safe records out, every amount through toMinor().
 *
 * Derived figures that the screens need on every row — what a facility has
 * left, what an aggregator still owes — are worked out here rather than in the
 * component, so a page and a report reading the same advance cannot disagree
 * about it. The arithmetic itself stays in src/lib/prefinance.ts.
 *
 * Every query is scoped by entity. Nothing in this file reads across entities.
 */

import type {
  AdvanceDelivery,
  AdvanceStatus,
  AggregatorAdvance,
  BankAccount,
  Contact,
  InterestBasis,
  LoanFacility,
  LoanFacilityStatus,
  LoanTranche,
  MoistureMethod as PrismaMoistureMethod,
  OutturnMethod as PrismaOutturnMethod,
  PreFinanceCycle,
  PreFinanceSetting,
  User,
} from '@prisma/client';

import type { DayCountBasis, MoistureMethod, OutturnMethod } from '../prefinance';
import { prisma } from '../prisma';
import { toMinor } from './money';
import type {
  AdvanceDeliveryRecord,
  AggregatorAdvanceRecord,
  LoanFacilityRecord,
  LoanTrancheRecord,
  PreFinanceCycleRecord,
  PreFinanceSettingRecord,
  QualityTermsRecord,
} from './types';

const isoDate = (value: Date): string => value.toISOString().slice(0, 10);

/** A rate as the app carries it: an exact decimal string, trailing zeros trimmed. */
const rateText = (value: { toString(): string }): string => {
  const text = value.toString();
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '.0') : text;
};

const decimalNumber = (value: { toString(): string } | null): number | null =>
  value === null ? null : Number(value.toString());

// --- enum translations --------------------------------------------------------------------------

const basisToRecord: Record<InterestBasis, DayCountBasis> = {
  ACTUAL_365: 'actual/365',
  ACTUAL_360: 'actual/360',
  THIRTY_360: '30/360',
};
export const basisToPrisma: Record<DayCountBasis, InterestBasis> = {
  'actual/365': 'ACTUAL_365',
  'actual/360': 'ACTUAL_360',
  '30/360': 'THIRTY_360',
};

const moistureToRecord: Record<PrismaMoistureMethod, MoistureMethod> = {
  WEIGHT_DEDUCTION: 'weight-deduction',
  PRICE_DEDUCTION: 'price-deduction',
};
export const moistureToPrisma: Record<MoistureMethod, PrismaMoistureMethod> = {
  'weight-deduction': 'WEIGHT_DEDUCTION',
  'price-deduction': 'PRICE_DEDUCTION',
};

const outturnToRecord: Record<PrismaOutturnMethod, OutturnMethod> = {
  PROPORTIONAL: 'proportional',
  PER_POINT: 'per-point',
};
export const outturnToPrisma: Record<OutturnMethod, PrismaOutturnMethod> = {
  proportional: 'PROPORTIONAL',
  'per-point': 'PER_POINT',
};

const facilityStatusToRecord: Record<LoanFacilityStatus, LoanFacilityRecord['status']> = {
  ACTIVE: 'active',
  CLOSED: 'closed',
};
export const facilityStatusToPrisma: Record<LoanFacilityRecord['status'], LoanFacilityStatus> = {
  active: 'ACTIVE',
  closed: 'CLOSED',
};

const advanceStatusToRecord: Record<AdvanceStatus, AggregatorAdvanceRecord['status']> = {
  OPEN: 'open',
  SETTLED: 'settled',
  WRITTEN_OFF: 'written-off',
};
export const advanceStatusToPrisma: Record<AggregatorAdvanceRecord['status'], AdvanceStatus> = {
  open: 'OPEN',
  settled: 'SETTLED',
  'written-off': 'WRITTEN_OFF',
};

// --- row → record -------------------------------------------------------------------------------

/** What the Ghanaian cashew trade normally assumes, until somebody says otherwise. */
export const preFinanceDefaults: Omit<PreFinanceSettingRecord, 'entityId' | 'updatedAt' | 'updatedByName'> = {
  defaultOutturn: 48,
  defaultMoisturePct: 8,
  defaultMoistureMethod: 'weight-deduction',
  defaultMoisturePctPerPoint: null,
  defaultOutturnMethod: 'proportional',
  defaultOutturnMinorPerPoint: null,
  defaultOutturnBonus: null,
  flagAfterDays: 14,
  provisionAfterDays: 60,
  provisionPct: 50,
};

export function settingRecord(row: (PreFinanceSetting & { updatedBy: Pick<User, 'name'> | null }) | null, entityId: string): PreFinanceSettingRecord {
  if (!row) return { entityId, ...preFinanceDefaults, updatedAt: null, updatedByName: '' };
  return {
    entityId: row.entityId,
    defaultOutturn: Number(row.defaultOutturn.toString()),
    defaultMoisturePct: Number(row.defaultMoisturePct.toString()),
    defaultMoistureMethod: moistureToRecord[row.defaultMoistureMethod],
    defaultMoisturePctPerPoint: decimalNumber(row.defaultMoisturePctPerPoint),
    defaultOutturnMethod: outturnToRecord[row.defaultOutturnMethod],
    defaultOutturnMinorPerPoint: row.defaultOutturnMinorPerPoint === null ? null : toMinor(row.defaultOutturnMinorPerPoint),
    defaultOutturnBonus: row.defaultOutturnBonus,
    flagAfterDays: row.flagAfterDays,
    provisionAfterDays: row.provisionAfterDays,
    provisionPct: Number(row.provisionPct.toString()),
    updatedAt: row.updatedAt.toISOString(),
    updatedByName: row.updatedBy?.name ?? '',
  };
}

type FacilityRow = LoanFacility & {
  lender: Pick<Contact, 'name'> | null;
  tranches: Pick<LoanTranche, 'amountMinor' | 'repaidOn' | 'interestMinor'>[];
};

export function facilityRecord(row: FacilityRow): LoanFacilityRecord {
  const drawnEver = row.tranches.reduce((sum, tranche) => sum + toMinor(tranche.amountMinor), 0);
  const outstanding = row.tranches
    .filter((tranche) => tranche.repaidOn === null)
    .reduce((sum, tranche) => sum + toMinor(tranche.amountMinor), 0);
  const limit = toMinor(row.limitMinor);
  return {
    id: row.id,
    entityId: row.entityId,
    reference: row.reference,
    lenderId: row.lenderId,
    lenderName: row.lender?.name ?? '',
    limitMinor: limit,
    ratePct: rateText(row.ratePct),
    basis: basisToRecord[row.basis],
    startsOn: isoDate(row.startsOn),
    endsOn: row.endsOn ? isoDate(row.endsOn) : null,
    status: facilityStatusToRecord[row.status],
    notes: row.notes ?? '',
    outstandingMinor: outstanding,
    drawnEverMinor: drawnEver,
    // What is still borrowable. Repaid tranches free the headroom again.
    headroomMinor: Math.max(limit - outstanding, 0),
    accruedInterestMinor: row.tranches.reduce((sum, tranche) => sum + toMinor(tranche.interestMinor), 0),
    trancheCount: row.tranches.length,
  };
}

type TrancheRow = LoanTranche & {
  facility: Pick<LoanFacility, 'reference'>;
  bankAccount: Pick<BankAccount, 'name'> | null;
  createdBy: Pick<User, 'name'> | null;
};

export function trancheRecord(row: TrancheRow): LoanTrancheRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    facilityId: row.facilityId,
    facilityReference: row.facility.reference,
    drawnOn: isoDate(row.drawnOn),
    amountMinor: toMinor(row.amountMinor),
    bankAccountId: row.bankAccountId,
    bankAccountName: row.bankAccount?.name ?? '',
    repaidOn: row.repaidOn ? isoDate(row.repaidOn) : null,
    interestToDate: row.interestToDate ? isoDate(row.interestToDate) : null,
    interestMinor: toMinor(row.interestMinor),
    isPosted: row.journalEntryId !== null,
    createdByName: row.createdBy?.name ?? '',
  };
}

export function termsRecord(row: AggregatorAdvance): QualityTermsRecord {
  return {
    outturn: Number(row.outturn.toString()),
    moisturePct: Number(row.moisturePct.toString()),
    moistureMethod: moistureToRecord[row.moistureMethod],
    moisturePctPerPoint: decimalNumber(row.moisturePctPerPoint),
    outturnMethod: outturnToRecord[row.outturnMethod],
    outturnMinorPerPoint: row.outturnMinorPerPoint === null ? null : toMinor(row.outturnMinorPerPoint),
    outturnBonus: row.outturnBonus,
  };
}

type AdvanceRow = AggregatorAdvance & {
  aggregator: Pick<Contact, 'name' | 'exposureLimitMinor'>;
  bankAccount: Pick<BankAccount, 'name'> | null;
  facility: Pick<LoanFacility, 'reference'> | null;
  createdBy: Pick<User, 'name'> | null;
  deliveries: Pick<AdvanceDelivery, 'settledValueMinor'>[];
};

export function advanceRecord(row: AdvanceRow): AggregatorAdvanceRecord {
  const amount = toMinor(row.amountMinor);
  const delivered = row.deliveries.reduce((sum, delivery) => sum + toMinor(delivery.settledValueMinor), 0);
  return {
    id: row.id,
    entityId: row.entityId,
    reference: row.reference,
    aggregatorId: row.aggregatorId,
    aggregatorName: row.aggregator.name,
    exposureLimitMinor: row.aggregator.exposureLimitMinor === null ? null : toMinor(row.aggregator.exposureLimitMinor),
    advancedOn: isoDate(row.advancedOn),
    expectedOn: isoDate(row.expectedOn),
    amountMinor: amount,
    pricePerKgMinor: toMinor(row.pricePerKgMinor),
    bankAccountId: row.bankAccountId,
    bankAccountName: row.bankAccount?.name ?? '',
    facilityId: row.facilityId,
    facilityReference: row.facility?.reference ?? '',
    terms: termsRecord(row),
    status: advanceStatusToRecord[row.status],
    settledOn: row.settledOn ? isoDate(row.settledOn) : null,
    notes: row.notes ?? '',
    isPosted: row.journalEntryId !== null,
    createdByName: row.createdBy?.name ?? '',
    deliveredValueMinor: delivered,
    // Never negative: a load worth more than the advance is money owed the
    // other way, and that belongs in payables rather than as a negative debt.
    outstandingMinor: Math.max(amount - delivered, 0),
    deliveryCount: row.deliveries.length,
  };
}

type DeliveryRow = AdvanceDelivery & {
  advance: Pick<AggregatorAdvance, 'reference'> & { aggregator: Pick<Contact, 'name'> };
  createdBy: Pick<User, 'name'> | null;
};

export function deliveryRecord(row: DeliveryRow): AdvanceDeliveryRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    advanceId: row.advanceId,
    advanceReference: row.advance.reference,
    aggregatorName: row.advance.aggregator.name,
    deliveredOn: isoDate(row.deliveredOn),
    vehicle: row.vehicle ?? '',
    waybill: row.waybill ?? '',
    grossGrams: row.grossGrams === null ? null : toMinor(row.grossGrams),
    tareGrams: row.tareGrams === null ? null : toMinor(row.tareGrams),
    bags: row.bags,
    assayedBy: row.assayedBy ?? '',
    grams: toMinor(row.grams),
    outturn: Number(row.outturn.toString()),
    moisturePct: Number(row.moisturePct.toString()),
    adjustedGrams: toMinor(row.adjustedGrams),
    adjustedPricePerKgMinor: toMinor(row.adjustedPricePerKgMinor),
    valueAtBasisMinor: toMinor(row.valueAtBasisMinor),
    settledValueMinor: toMinor(row.settledValueMinor),
    varianceMinor: toMinor(row.varianceMinor),
    moistureVarianceMinor: toMinor(row.moistureVarianceMinor),
    outturnVarianceMinor: toMinor(row.outturnVarianceMinor),
    notes: row.notes ?? '',
    isPosted: row.journalEntryId !== null,
    createdByName: row.createdBy?.name ?? '',
  };
}

type CycleRow = PreFinanceCycle & { facility: Pick<LoanFacility, 'reference'> | null };

export function cycleRecord(row: CycleRow): PreFinanceCycleRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    reference: row.reference,
    facilityId: row.facilityId,
    facilityReference: row.facility?.reference ?? '',
    drawnOn: isoDate(row.drawnOn),
    advancedOn: row.advancedOn ? isoDate(row.advancedOn) : null,
    deliveredOn: row.deliveredOn ? isoDate(row.deliveredOn) : null,
    processedOn: row.processedOn ? isoDate(row.processedOn) : null,
    soldOn: row.soldOn ? isoDate(row.soldOn) : null,
    cashBackOn: row.cashBackOn ? isoDate(row.cashBackOn) : null,
    drawnMinor: toMinor(row.drawnMinor),
    advancedMinor: toMinor(row.advancedMinor),
    proceedsMinor: toMinor(row.proceedsMinor),
    costsMinor: toMinor(row.costsMinor),
    notes: row.notes ?? '',
    // A cycle is complete when the cash is back, not when the sale was made.
    isComplete: row.cashBackOn !== null,
  };
}

// --- includes -----------------------------------------------------------------------------------

const facilityInclude = {
  lender: { select: { name: true } },
  tranches: { select: { amountMinor: true, repaidOn: true, interestMinor: true } },
} as const;

const trancheInclude = {
  facility: { select: { reference: true } },
  bankAccount: { select: { name: true } },
  createdBy: { select: { name: true } },
} as const;

const advanceInclude = {
  aggregator: { select: { name: true, exposureLimitMinor: true } },
  bankAccount: { select: { name: true } },
  facility: { select: { reference: true } },
  createdBy: { select: { name: true } },
  deliveries: { select: { settledValueMinor: true } },
} as const;

const deliveryInclude = {
  advance: { select: { reference: true, aggregator: { select: { name: true } } } },
  createdBy: { select: { name: true } },
} as const;

const cycleInclude = { facility: { select: { reference: true } } } as const;

// --- loaders ------------------------------------------------------------------------------------

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/**
 * Everything the pre-finance screens read, in one pass and scoped by the
 * principal's grant. Entities with nothing recorded come back as empty lists
 * rather than missing keys, so a page never has to guard for undefined.
 */
export async function loadPreFinanceData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [settings, facilities, tranches, advances, deliveries, cycles] = await Promise.all([
    prisma.preFinanceSetting.findMany({ where: scope, include: { updatedBy: { select: { name: true } } } }),
    prisma.loanFacility.findMany({ where: scope, include: facilityInclude, orderBy: [{ status: 'asc' }, { startsOn: 'desc' }] }),
    prisma.loanTranche.findMany({ where: scope, include: trancheInclude, orderBy: { drawnOn: 'desc' } }),
    prisma.aggregatorAdvance.findMany({ where: scope, include: advanceInclude, orderBy: [{ status: 'asc' }, { expectedOn: 'asc' }] }),
    prisma.advanceDelivery.findMany({ where: scope, include: deliveryInclude, orderBy: { deliveredOn: 'desc' } }),
    prisma.preFinanceCycle.findMany({ where: scope, include: cycleInclude, orderBy: { drawnOn: 'desc' } }),
  ]);

  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> =>
    Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));

  return {
    preFinanceSettingsByEntity: Object.fromEntries(
      entityIds.map((id) => [id, settingRecord(settings.find((row) => row.entityId === id) ?? null, id)]),
    ) as Record<string, PreFinanceSettingRecord>,
    facilitiesByEntity: withAll(groupBy(facilities.map(facilityRecord), (row) => row.entityId)),
    tranchesByEntity: withAll(groupBy(tranches.map(trancheRecord), (row) => row.entityId)),
    advancesByEntity: withAll(groupBy(advances.map(advanceRecord), (row) => row.entityId)),
    advanceDeliveriesByEntity: withAll(groupBy(deliveries.map(deliveryRecord), (row) => row.entityId)),
    preFinanceCyclesByEntity: withAll(groupBy(cycles.map(cycleRecord), (row) => row.entityId)),
  };
}

/** One advance with its deliveries, for the settlement screen. */
export async function loadAdvance(entityId: string, advanceId: string) {
  const [advance, deliveries] = await Promise.all([
    prisma.aggregatorAdvance.findFirst({ where: { id: advanceId, entityId }, include: advanceInclude }),
    prisma.advanceDelivery.findMany({ where: { advanceId, entityId }, include: deliveryInclude, orderBy: { deliveredOn: 'asc' } }),
  ]);
  if (!advance) return null;
  return { advance: advanceRecord(advance), deliveries: deliveries.map(deliveryRecord) };
}

/**
 * What one aggregator's record looks like, for the exposure check.
 *
 * Counts only what is still open: a limit is about how much is at risk now,
 * not how much has ever been handed over.
 */
export async function aggregatorExposure(entityId: string, aggregatorId: string) {
  const [contact, open, settled] = await Promise.all([
    prisma.contact.findFirst({ where: { id: aggregatorId }, select: { name: true, exposureLimitMinor: true } }),
    prisma.aggregatorAdvance.findMany({
      where: { entityId, aggregatorId, status: 'OPEN' },
      select: { amountMinor: true, deliveries: { select: { settledValueMinor: true, varianceMinor: true } } },
    }),
    prisma.aggregatorAdvance.findMany({
      where: { entityId, aggregatorId, status: { in: ['SETTLED', 'WRITTEN_OFF'] } },
      select: {
        amountMinor: true,
        advancedOn: true,
        settledOn: true,
        status: true,
        deliveries: { select: { settledValueMinor: true, varianceMinor: true } },
      },
    }),
  ]);
  if (!contact) return null;

  const outstandingMinor = open.reduce((sum, advance) => {
    const delivered = advance.deliveries.reduce((total, delivery) => total + toMinor(delivery.settledValueMinor), 0);
    return sum + Math.max(toMinor(advance.amountMinor) - delivered, 0);
  }, 0);

  const everyAdvance = [...open, ...settled];
  const everyDelivery = everyAdvance.flatMap((advance) => advance.deliveries);

  // What was never recovered: an advance marked written off, less whatever did
  // arrive against it. That is the figure a track record turns on.
  const unrecoveredMinor = settled
    .filter((advance) => advance.status === 'WRITTEN_OFF')
    .reduce((sum, advance) => {
      const delivered = advance.deliveries.reduce((total, delivery) => total + toMinor(delivery.settledValueMinor), 0);
      return sum + Math.max(toMinor(advance.amountMinor) - delivered, 0);
    }, 0);

  return {
    name: contact.name,
    exposureLimitMinor: contact.exposureLimitMinor === null ? null : toMinor(contact.exposureLimitMinor),
    outstandingMinor,
    openCount: open.length,
    completedCount: settled.length,
    advancedMinor: everyAdvance.reduce((sum, advance) => sum + toMinor(advance.amountMinor), 0),
    deliveredValueMinor: everyDelivery.reduce((sum, delivery) => sum + toMinor(delivery.settledValueMinor), 0),
    qualityVariances: everyDelivery.map((delivery) => toMinor(delivery.varianceMinor)),
    unrecoveredMinor,
    daysToDeliver: settled
      .filter((advance) => advance.settledOn !== null)
      .map((advance) => Math.round((advance.settledOn!.getTime() - advance.advancedOn.getTime()) / 86_400_000)),
  };
}
