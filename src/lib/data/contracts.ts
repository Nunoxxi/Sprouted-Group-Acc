/**
 * Sales contract readers: contracts with their deliveries and selling
 * costs, and seed-fund movements — Prisma → records.
 */

import type { Account, Contact, ContractDelivery, ContractSellingCost, JournalEntry, JournalLine, SalesContract, SeedFundMovement, SellingCostKind as PrismaSellingCostKind, User } from '@prisma/client';

import type { PriceUnit, SellingCostKind } from '../contracts';
import { prisma } from '../prisma';
import { postedJournal } from './documents';
import { rateText } from './mappers';
import { toMinor } from './money';
import type { ContractDeliveryRecord, ContractSellingCostRecord, SalesContractRecord, SeedFundRecord } from './types';

type JournalRow = JournalEntry & { lines: (JournalLine & { account: Pick<Account, 'code' | 'name'> })[] };
const journalInclude = { lines: { include: { account: { select: { code: true, name: true } } } } } as const;

const sellingToRecord: Record<PrismaSellingCostKind, SellingCostKind> = { TRANSPORT_TO_BUYER: 'transport-to-buyer', PORT_HANDLING: 'port-handling', EXPORT_PERMIT: 'export-permit', LEVY: 'levy', OTHER: 'other' };
export const sellingToPrisma: Record<SellingCostKind, PrismaSellingCostKind> = { 'transport-to-buyer': 'TRANSPORT_TO_BUYER', 'port-handling': 'PORT_HANDLING', 'export-permit': 'EXPORT_PERMIT', levy: 'LEVY', other: 'OTHER' };
export function sellingCostKindOf(value: PrismaSellingCostKind | null): SellingCostKind | null {
  return value ? sellingToRecord[value] : null;
}

const isoDate = (value: Date) => value.toISOString().slice(0, 10);

export function deliveryRecord(row: ContractDelivery & { journalEntry: JournalRow | null; acceptanceJournal: JournalRow | null; createdBy: Pick<User, 'name'> | null }): ContractDeliveryRecord {
  return {
    id: row.id,
    contractId: row.contractId,
    deliveryNo: row.deliveryNo,
    date: isoDate(row.date),
    locationId: row.locationId,
    grams: toMinor(row.grams),
    destination: row.destination ?? '',
    rate: rateText(row.rate) ?? '1.0',
    revenueTxnMinor: toMinor(row.revenueTxnMinor),
    revenueMinor: toMinor(row.revenueMinor),
    costMinor: toMinor(row.costMinor),
    marginMinor: toMinor(row.marginMinor),
    haulageMinor: toMinor(row.haulageMinor),
    status: row.status === 'ACCEPTED' ? 'accepted' : row.status === 'AWAITING_ACCEPTANCE' ? 'awaiting-acceptance' : row.status === 'BEFORE_CUTOVER' ? 'before-cutover' : 'delivered',
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    acceptanceJournal: row.acceptanceJournal ? postedJournal(row.acceptanceJournal) : null,
    acceptedAt: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    note: row.note ?? '',
    createdByName: row.createdBy?.name ?? '',
  };
}

export function sellingCostRecord(row: ContractSellingCost & { documentLine: { documentId: string } }): ContractSellingCostRecord {
  return { id: row.id, kind: sellingToRecord[row.kind], description: row.description, date: isoDate(row.date), amountMinor: toMinor(row.amountMinor), documentId: row.documentLine.documentId };
}

export type ContractRow = SalesContract & {
  buyer: Pick<Contact, 'name'>;
  deliveries: (ContractDelivery & { journalEntry: JournalRow | null; acceptanceJournal: JournalRow | null; createdBy: Pick<User, 'name'> | null })[];
  sellingCosts: (ContractSellingCost & { documentLine: { documentId: string } })[];
  createdBy: Pick<User, 'name'> | null;
};

export function contractRecord(row: ContractRow): SalesContractRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    contractNo: row.contractNo,
    buyerContactId: row.buyerContactId,
    buyerName: row.buyer.name,
    commodityId: row.commodityId,
    itemId: row.itemId,
    quantityGrams: toMinor(row.quantityGrams),
    priceMinor: toMinor(row.priceMinor),
    priceUnit: (row.priceUnit === 'BAG' ? 'bag' : row.priceUnit === 'TONNE' ? 'tonne' : 'kg') as PriceUnit,
    currency: row.currency,
    contractRate: rateText(row.contractRate),
    deliveryTerms: row.deliveryTerms,
    deliveryFrom: isoDate(row.deliveryFrom),
    deliveryTo: isoDate(row.deliveryTo),
    recognizeOn: row.recognizeOn === 'ACCEPTANCE' ? 'acceptance' : 'delivery',
    saleType: row.saleType === 'EXPORT' ? 'export' : 'domestic',
    isCmc: row.isCmc,
    status: row.status === 'CLOSED' ? 'closed' : row.status === 'CANCELLED' ? 'cancelled' : 'open',
    note: row.note ?? '',
    deliveries: [...row.deliveries].sort((a, b) => a.deliveryNo - b.deliveryNo).map(deliveryRecord),
    sellingCosts: [...row.sellingCosts].sort((a, b) => a.date.getTime() - b.date.getTime()).map(sellingCostRecord),
    createdByName: row.createdBy?.name ?? '',
  };
}

export function seedFundRecord(row: SeedFundMovement & { journalEntry: JournalRow | null }): SeedFundRecord {
  return { id: row.id, kind: row.kind === 'RECEIVED' ? 'received' : row.kind === 'REPAID' ? 'repaid' : 'offset', date: isoDate(row.date), amountMinor: toMinor(row.amountMinor), bankAccountId: row.bankAccountId, journal: row.journalEntry ? postedJournal(row.journalEntry) : null, note: row.note ?? '' };
}

export const contractInclude = {
  buyer: { select: { name: true } },
  deliveries: { include: { journalEntry: { include: journalInclude }, acceptanceJournal: { include: journalInclude }, createdBy: { select: { name: true } } } },
  sellingCosts: { include: { documentLine: { select: { documentId: true } } } },
  createdBy: { select: { name: true } },
} as const;
export const seedFundInclude = { journalEntry: { include: journalInclude } } as const;

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/** Scoped by the principal's grant in every query. */
export async function loadContractData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [contracts, seedFunds] = await Promise.all([
    prisma.salesContract.findMany({ where: scope, include: contractInclude, orderBy: [{ createdAt: 'desc' }] }),
    prisma.seedFundMovement.findMany({ where: scope, include: seedFundInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
  ]);
  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));
  return {
    contractsByEntity: withAll(groupBy(contracts.map(contractRecord), (r) => r.entityId)),
    seedFundsByEntity: withAll(groupBy(seedFunds.map((row) => ({ entityId: row.entityId, ...seedFundRecord(row) })), (r) => r.entityId)),
  };
}
