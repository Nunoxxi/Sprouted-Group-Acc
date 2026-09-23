/**
 * Trading readers: commodities, lots, buying agents, floats and agent
 * purchases — Prisma → records. Every quantity and amount passes through
 * toMinor() here.
 */

import type {
  Account,
  AgentPurchase,
  AgentPurchaseStatus,
  BuyingAgent,
  Farmer,
  FarmerAdvance,
  FarmerPayment,
  Commodity,
  CommodityKind as PrismaCommodityKind,
  Contact,
  FloatAdvance,
  FloatReturn,
  JournalEntry,
  JournalLine,
  LandedCostKind as PrismaLandedCostKind,
  Lot,
  PaymentMethod,
  User,
} from '@prisma/client';

import { prisma } from '../prisma';
import { decryptField } from '../pii-crypto';
import { evidenceKindOf, settlementOf } from './momo';
import type { CommodityKind, LandedCostKind, Quality } from '../trading';
import { postedJournal } from './documents';
import { toMinor } from './money';
import type { AgentPurchaseRecord, BuyingAgentRecord, CommodityRecord, FloatAdvanceRecord, LotRecord } from './types';

type JournalRow = JournalEntry & { lines: (JournalLine & { account: Pick<Account, 'code' | 'name'> })[] };
const journalInclude = { lines: { include: { account: { select: { code: true, name: true } } } } } as const;

// --- enum translations -------------------------------------------------------

const kindToRecord: Record<PrismaCommodityKind, CommodityKind> = { CASHEW: 'cashew', COCOA: 'cocoa', OTHER: 'other' };
export const kindToPrisma: Record<CommodityKind, PrismaCommodityKind> = { cashew: 'CASHEW', cocoa: 'COCOA', other: 'OTHER' };

const landedToRecord: Record<PrismaLandedCostKind, LandedCostKind> = { TRANSPORT: 'transport', BAGS: 'bags', LOADING: 'loading', FUMIGATION: 'fumigation', LEVY: 'levy', COMMISSION: 'commission' };
export const landedToPrisma: Record<LandedCostKind, PrismaLandedCostKind> = { transport: 'TRANSPORT', bags: 'BAGS', loading: 'LOADING', fumigation: 'FUMIGATION', levy: 'LEVY', commission: 'COMMISSION' };
export function landedCostKindOf(value: PrismaLandedCostKind | null): LandedCostKind | null {
  return value ? landedToRecord[value] : null;
}

const paymentToRecord: Record<PaymentMethod, AgentPurchaseRecord['paymentMethod']> = { CASH: 'cash', MOBILE_MONEY: 'mobile-money' };
export const paymentToPrisma: Record<AgentPurchaseRecord['paymentMethod'], PaymentMethod> = { cash: 'CASH', 'mobile-money': 'MOBILE_MONEY' };
const statusToRecord: Record<AgentPurchaseStatus, AgentPurchaseRecord['status']> = { PENDING: 'pending', POSTED: 'posted', REJECTED: 'rejected' };

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Quality columns → the one shape the forms and lots share. */
export function qualityOf(row: { kor: { toString(): string } | null; moisturePct: { toString(): string } | null; nutCount: number | null; cocoaGrade: string | null; beanCount: number | null }): Quality {
  return {
    kor: row.kor === null ? null : Number(row.kor),
    moisturePct: row.moisturePct === null ? null : Number(row.moisturePct),
    nutCount: row.nutCount,
    cocoaGrade: row.cocoaGrade,
    beanCount: row.beanCount,
  };
}

// --- row → record --------------------------------------------------------------

export function commodityRecord(row: Commodity): CommodityRecord {
  return { id: row.id, entityId: row.entityId, code: row.code, name: row.name, kind: kindToRecord[row.kind], gramsPerBag: row.gramsPerBag, shrinkageTolerancePct: Number(row.shrinkageTolerancePct), isActive: row.isActive };
}

export function lotRecord(row: Lot & { supplier: Pick<Contact, 'name'> | null; createdBy: Pick<User, 'name'> | null; documentLine: { documentId: string } | null; agentPurchase: { id: string } | null }): LotRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    commodityId: row.commodityId,
    itemId: row.itemId,
    locationId: row.locationId,
    lotRef: row.lotRef,
    date: isoDate(row.date),
    supplierContactId: row.supplierContactId,
    supplierName: row.supplier?.name ?? '',
    farmerName: row.farmerName ?? '',
    community: row.community ?? '',
    district: row.district ?? '',
    quality: qualityOf(row),
    gramsIn: toMinor(row.gramsIn),
    gramsShrunk: toMinor(row.gramsShrunk),
    landedCostMinor: toMinor(row.landedCostMinor),
    documentId: row.documentLine?.documentId ?? null,
    agentPurchaseId: row.agentPurchase?.id ?? null,
    note: row.note ?? '',
    createdByName: row.createdBy?.name ?? '',
  };
}

export function agentRecord(row: BuyingAgent): BuyingAgentRecord {
  return { id: row.id, entityId: row.entityId, name: row.name, phone: decryptField('BuyingAgent.phone', row.phone) ?? '', defaultLocationId: row.defaultLocationId, isActive: row.isActive };
}

export function floatRecord(
  row: FloatAdvance & { journalEntry: JournalRow | null; returns: (FloatReturn & { journalEntry: JournalRow | null })[]; purchases: Pick<AgentPurchase, 'priceMinor' | 'payableMinor' | 'settlement' | 'status'>[]; createdBy: Pick<User, 'name'> | null; reconciledBy: Pick<User, 'name'> | null },
): FloatAdvanceRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    agentId: row.agentId,
    date: isoDate(row.date),
    amountMinor: toMinor(row.amountMinor),
    bankAccountId: row.bankAccountId,
    isOpening: row.bankAccountId === null,
    status: row.status === 'RECONCILED' ? 'reconciled' : 'open',
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    returns: [...row.returns].sort((a, b) => a.date.getTime() - b.date.getTime()).map((r) => ({ id: r.id, date: isoDate(r.date), amountMinor: toMinor(r.amountMinor), bankAccountId: r.bankAccountId, journal: r.journalEntry ? postedJournal(r.journalEntry) : null })),
    // What left the float: purchases the agent settled, net of any advance recovered
    // (the farmer was handed the net, so only the net came out of the float).
    purchasedMinor: row.purchases.filter((p) => p.status === 'POSTED' && p.settlement === 'FLOAT').reduce((s, p) => s + toMinor(p.payableMinor), 0),
    reconciledAt: row.reconciledAt ? row.reconciledAt.toISOString() : null,
    reconciledByName: row.reconciledBy?.name ?? null,
    createdByName: row.createdBy?.name ?? '',
  };
}

type PurchaseRow = AgentPurchase & {
  journalEntry: JournalRow | null;
  createdBy: Pick<User, 'name'> | null;
  postedBy: Pick<User, 'name'> | null;
  payments: Pick<FarmerPayment, 'amountMinor'>[];
  farmer: (Pick<Farmer, 'id'> & { advances: Pick<FarmerAdvance, 'amountMinor' | 'settledMinor' | 'status'>[] }) | null;
};

export function purchaseRecord(row: PurchaseRow): AgentPurchaseRecord {
  const payableMinor = toMinor(row.payableMinor);
  const paidInBatches = row.payments.reduce((s, p) => s + toMinor(p.amountMinor), 0);
  return {
    id: row.id,
    entityId: row.entityId,
    agentId: row.agentId,
    floatId: row.floatId,
    clientRef: row.clientRef,
    date: isoDate(row.date),
    farmerName: row.farmerName,
    community: row.community ?? '',
    district: row.district ?? '',
    itemId: row.itemId,
    locationId: row.locationId,
    bags: row.bags === null ? null : Number(row.bags),
    grams: toMinor(row.grams),
    priceMinor: toMinor(row.priceMinor),
    paymentMethod: paymentToRecord[row.paymentMethod],
    settlement: settlementOf(row.settlement),
    farmerId: row.farmerId,
    recoveredMinor: toMinor(row.recoveredMinor),
    payableMinor,
    // The agent settled it on the spot; anything else is paid only as batches clear.
    paidMinor: row.settlement === 'FLOAT' ? payableMinor : paidInBatches,
    advanceRemainingMinor: (row.farmer?.advances ?? []).filter((a) => a.status === 'OPEN').reduce((s, a) => s + toMinor(a.amountMinor) - toMinor(a.settledMinor), 0),
    paymentRef: row.paymentRef ?? '',
    evidenceKind: evidenceKindOf(row.evidenceKind),
    evidenceAt: row.evidenceAt ? row.evidenceAt.toISOString() : null,
    quality: qualityOf(row),
    note: row.note ?? '',
    status: statusToRecord[row.status],
    rejectReason: row.rejectReason ?? '',
    lotId: row.lotId,
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    syncedAt: row.syncedAt.toISOString(),
    createdByName: row.createdBy?.name ?? '',
    postedByName: row.postedBy?.name ?? null,
  };
}

export const lotInclude = { supplier: { select: { name: true } }, createdBy: { select: { name: true } }, documentLine: { select: { documentId: true } }, agentPurchase: { select: { id: true } } } as const;
export const floatInclude = { journalEntry: { include: journalInclude }, returns: { include: { journalEntry: { include: journalInclude } } }, purchases: { select: { priceMinor: true, payableMinor: true, settlement: true, status: true } }, createdBy: { select: { name: true } }, reconciledBy: { select: { name: true } } } as const;
export const purchaseInclude = {
  journalEntry: { include: journalInclude },
  createdBy: { select: { name: true } },
  postedBy: { select: { name: true } },
  payments: { select: { amountMinor: true } },
  farmer: { select: { id: true, advances: { select: { amountMinor: true, settledMinor: true, status: true } } } },
} as const;

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/** Scoped by the principal's grant in every query. */
export async function loadTradingData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [commodities, lots, agents, floats, purchases] = await Promise.all([
    prisma.commodity.findMany({ where: scope, orderBy: [{ entityId: 'asc' }, { code: 'asc' }] }),
    prisma.lot.findMany({ where: scope, include: lotInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 500 }),
    prisma.buyingAgent.findMany({ where: scope, orderBy: [{ entityId: 'asc' }, { name: 'asc' }] }),
    prisma.floatAdvance.findMany({ where: scope, include: floatInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
    prisma.agentPurchase.findMany({ where: scope, include: purchaseInclude, orderBy: [{ date: 'desc' }, { syncedAt: 'desc' }], take: 500 }),
  ]);
  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));
  return {
    commoditiesByEntity: withAll(groupBy(commodities.map(commodityRecord), (r) => r.entityId)),
    lotsByEntity: withAll(groupBy(lots.map(lotRecord), (r) => r.entityId)),
    agentsByEntity: withAll(groupBy(agents.map(agentRecord), (r) => r.entityId)),
    floatsByEntity: withAll(groupBy(floats.map(floatRecord), (r) => r.entityId)),
    agentPurchasesByEntity: withAll(groupBy(purchases.map(purchaseRecord), (r) => r.entityId)),
  };
}
