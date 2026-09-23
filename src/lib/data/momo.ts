/**
 * Mobile money and farmer payment readers: farmers with their two running
 * balances, advances, payment batches, statement mappings and imported
 * statement lines — Prisma → records. Every amount passes through toMinor().
 */

import type {
  Account,
  AdvanceRecovery,
  AgentPurchase,
  BankAccount,
  BankAccountKind as PrismaBankAccountKind,
  FarmerAdvance,
  FarmerAdvanceStatus,
  Farmer as PrismaFarmer,
  FarmerPayment,
  FarmerPaymentBatch,
  JournalEntry,
  JournalLine,
  PaymentBatchStatus,
  PaymentEvidence,
  PurchaseSettlement,
  StatementImport,
  StatementLine,
  StatementLineStatus,
  StatementMapping,
  User,
} from '@prisma/client';

import type { BankAccountKind } from '../momo';
import { decryptField } from '../pii-crypto';
import { prisma } from '../prisma';
import { postedJournal } from './documents';
import { toMinor } from './money';
import type {
  FarmerAdvanceRecord,
  FarmerRecord,
  PaymentBatchRecord,
  StatementImportRecord,
  StatementLineRecord,
  StatementMappingRecord,
} from './types';

type JournalRow = JournalEntry & { lines: (JournalLine & { account: Pick<Account, 'code' | 'name'> })[] };
const journalInclude = { lines: { include: { account: { select: { code: true, name: true } } } } } as const;

const isoDate = (value: Date) => value.toISOString().slice(0, 10);

// --- enum translations -----------------------------------------------------------------

const bankKindToRecord: Record<PrismaBankAccountKind, BankAccountKind> = { BANK: 'bank', MOBILE_MONEY: 'mobile-money', CASH: 'cash' };
export const bankKindToPrisma: Record<BankAccountKind, PrismaBankAccountKind> = { bank: 'BANK', 'mobile-money': 'MOBILE_MONEY', cash: 'CASH' };
export const bankAccountKindOf = (value: PrismaBankAccountKind): BankAccountKind => bankKindToRecord[value];

const settlementToRecord: Record<PurchaseSettlement, 'float' | 'payable'> = { FLOAT: 'float', PAYABLE: 'payable' };
export const settlementToPrisma: Record<'float' | 'payable', PurchaseSettlement> = { float: 'FLOAT', payable: 'PAYABLE' };
export const settlementOf = (value: PurchaseSettlement) => settlementToRecord[value];

const evidenceToRecord: Record<PaymentEvidence, 'signature' | 'thumbprint' | 'reference'> = { SIGNATURE: 'signature', THUMBPRINT: 'thumbprint', REFERENCE: 'reference' };
export const evidenceToPrisma: Record<'signature' | 'thumbprint' | 'reference', PaymentEvidence> = { signature: 'SIGNATURE', thumbprint: 'THUMBPRINT', reference: 'REFERENCE' };
export const evidenceKindOf = (value: PaymentEvidence | null) => (value ? evidenceToRecord[value] : null);

const advanceStatusToRecord: Record<FarmerAdvanceStatus, FarmerAdvanceRecord['status']> = { OPEN: 'open', SETTLED: 'settled' };
const batchStatusToRecord: Record<PaymentBatchStatus, PaymentBatchRecord['status']> = { DRAFT: 'draft', EXPORTED: 'exported', PAID: 'paid' };
const lineStatusToRecord: Record<StatementLineStatus, StatementLineRecord['status']> = { UNMATCHED: 'unmatched', MATCHED: 'matched', CHARGE: 'charge' };

// --- row → record ------------------------------------------------------------------------

type FarmerRow = PrismaFarmer & {
  advances: Pick<FarmerAdvance, 'amountMinor' | 'settledMinor' | 'status'>[];
  purchases: (Pick<AgentPurchase, 'status' | 'settlement' | 'grams' | 'priceMinor' | 'payableMinor'> & { payments: Pick<FarmerPayment, 'amountMinor'>[] })[];
};

export const farmerInclude = {
  advances: { select: { amountMinor: true, settledMinor: true, status: true } },
  purchases: { select: { status: true, settlement: true, grams: true, priceMinor: true, payableMinor: true, payments: { select: { amountMinor: true } } } },
} as const;

/** A farmer with what they owe and what is owed to them, both read from the detail. */
export function farmerRecord(row: FarmerRow): FarmerRecord {
  const posted = row.purchases.filter((p) => p.status === 'POSTED');
  const payableOutstandingMinor = posted.reduce((total, purchase) => {
    // A float purchase was paid on the spot by the agent; a payable one is owed until a batch clears it.
    if (purchase.settlement === 'FLOAT') return total;
    const paid = purchase.payments.reduce((s, p) => s + toMinor(p.amountMinor), 0);
    return total + toMinor(purchase.payableMinor) - paid;
  }, 0);
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    phone: decryptField('Farmer.phone', row.phone) ?? '',
    community: row.community ?? '',
    district: row.district ?? '',
    walletNumber: decryptField('Farmer.walletNumber', row.walletNumber) ?? '',
    isActive: row.isActive,
    advanceOutstandingMinor: row.advances.filter((a) => a.status === 'OPEN').reduce((s, a) => s + toMinor(a.amountMinor) - toMinor(a.settledMinor), 0),
    payableOutstandingMinor,
    deliveries: posted.length,
    gramsTotal: posted.reduce((s, p) => s + toMinor(p.grams), 0),
    grossMinor: posted.reduce((s, p) => s + toMinor(p.priceMinor), 0),
  };
}

export const advanceInclude = { journalEntry: { include: journalInclude } } as const;

export function farmerAdvanceRecord(row: FarmerAdvance & { journalEntry: JournalRow | null }): FarmerAdvanceRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    farmerId: row.farmerId,
    farmerName: row.farmerName,
    community: row.community ?? '',
    district: row.district ?? '',
    date: isoDate(row.date),
    amountMinor: toMinor(row.amountMinor),
    settledMinor: toMinor(row.settledMinor),
    status: advanceStatusToRecord[row.status],
    note: row.note ?? '',
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
  };
}

export const batchInclude = {
  bankAccount: { select: { name: true } },
  payments: { include: { farmer: { select: { name: true } } } },
  journalEntry: { include: journalInclude },
  createdBy: { select: { name: true } },
} as const;

export function paymentBatchRecord(
  row: FarmerPaymentBatch & {
    bankAccount: Pick<BankAccount, 'name'>;
    payments: (FarmerPayment & { farmer: Pick<PrismaFarmer, 'name'> })[];
    journalEntry: JournalRow | null;
    createdBy: Pick<User, 'name'> | null;
  },
): PaymentBatchRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    reference: row.reference,
    date: isoDate(row.date),
    bankAccountId: row.bankAccountId,
    bankAccountName: row.bankAccount.name,
    status: batchStatusToRecord[row.status],
    totalMinor: toMinor(row.totalMinor),
    feeMinor: toMinor(row.feeMinor),
    exportedAt: row.exportedAt ? row.exportedAt.toISOString() : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    note: row.note ?? '',
    payments: [...row.payments]
      .sort((a, b) => a.farmer.name.localeCompare(b.farmer.name))
      .map((payment) => ({
        id: payment.id,
        farmerId: payment.farmerId,
        farmerName: payment.farmer.name,
        purchaseId: payment.purchaseId,
        amountMinor: toMinor(payment.amountMinor),
        walletNumber: decryptField('FarmerPayment.walletNumber', payment.walletNumber) ?? '',
        paymentRef: payment.paymentRef ?? '',
      })),
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    createdByName: row.createdBy?.name ?? '',
  };
}

export function statementMappingRecord(row: StatementMapping): StatementMappingRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    dateColumn: row.dateColumn,
    descriptionColumn: row.descriptionColumn,
    referenceColumn: row.referenceColumn ?? '',
    amountColumn: row.amountColumn ?? '',
    moneyInColumn: row.moneyInColumn ?? '',
    moneyOutColumn: row.moneyOutColumn ?? '',
    feeColumn: row.feeColumn ?? '',
    levyColumn: row.levyColumn ?? '',
    balanceColumn: row.balanceColumn ?? '',
    chargeKeywords: row.chargeKeywords ?? '',
    dateFormat: row.dateFormat,
  };
}

export function statementLineRecord(row: StatementLine): StatementLineRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    importId: row.importId,
    bankAccountId: row.bankAccountId,
    date: isoDate(row.date),
    description: row.description,
    reference: row.reference ?? '',
    amountMinor: toMinor(row.amountMinor),
    feeMinor: toMinor(row.feeMinor),
    levyMinor: toMinor(row.levyMinor),
    balanceMinor: row.balanceMinor === null ? null : toMinor(row.balanceMinor),
    status: lineStatusToRecord[row.status],
    matchedBatchId: row.matchedBatchId,
    note: row.note ?? '',
  };
}

export const statementImportInclude = {
  bankAccount: { select: { name: true } },
  mapping: { select: { name: true } },
  createdBy: { select: { name: true } },
  lines: true,
} as const;

export function statementImportRecord(
  row: StatementImport & { bankAccount: Pick<BankAccount, 'name'>; mapping: Pick<StatementMapping, 'name'> | null; createdBy: Pick<User, 'name'> | null; lines: StatementLine[] },
): StatementImportRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    bankAccountId: row.bankAccountId,
    bankAccountName: row.bankAccount.name,
    mappingName: row.mapping?.name ?? '',
    fileName: row.fileName,
    fromDate: row.fromDate ? isoDate(row.fromDate) : null,
    toDate: row.toDate ? isoDate(row.toDate) : null,
    lineCount: row.lineCount,
    feeMinor: toMinor(row.feeMinor),
    createdAt: row.createdAt.toISOString(),
    createdByName: row.createdBy?.name ?? '',
    lines: [...row.lines].sort((a, b) => a.date.getTime() - b.date.getTime() || a.description.localeCompare(b.description)).map(statementLineRecord),
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/** Scoped by the principal's grant in every query. */
export async function loadMomoData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [farmers, advances, batches, mappings, imports] = await Promise.all([
    prisma.farmer.findMany({ where: scope, include: farmerInclude, orderBy: [{ entityId: 'asc' }, { name: 'asc' }] }),
    prisma.farmerAdvance.findMany({ where: scope, include: advanceInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 500 }),
    prisma.farmerPaymentBatch.findMany({ where: scope, include: batchInclude, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: 200 }),
    prisma.statementMapping.findMany({ where: scope, orderBy: [{ entityId: 'asc' }, { name: 'asc' }] }),
    prisma.statementImport.findMany({ where: scope, include: statementImportInclude, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);
  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));
  return {
    farmersByEntity: withAll(groupBy(farmers.map(farmerRecord), (r) => r.entityId)),
    farmerAdvancesByEntity: withAll(groupBy(advances.map(farmerAdvanceRecord), (r) => r.entityId)),
    paymentBatchesByEntity: withAll(groupBy(batches.map(paymentBatchRecord), (r) => r.entityId)),
    statementMappingsByEntity: withAll(groupBy(mappings.map(statementMappingRecord), (r) => r.entityId)),
    statementImportsByEntity: withAll(groupBy(imports.map(statementImportRecord), (r) => r.entityId)),
  };
}

/** One farmer's advances and recoveries, for the history report. */
export async function farmerHistory(entityId: string, farmerId: string) {
  const [advances, recoveries] = await Promise.all([
    prisma.farmerAdvance.findMany({ where: { entityId, farmerId }, orderBy: { date: 'asc' } }),
    prisma.advanceRecovery.findMany({ where: { entityId, advance: { farmerId } }, include: { purchase: { select: { date: true, clientRef: true } } } }),
  ]);
  return { advances, recoveries } as { advances: FarmerAdvance[]; recoveries: (AdvanceRecovery & { purchase: { date: Date; clientRef: string } })[] };
}
