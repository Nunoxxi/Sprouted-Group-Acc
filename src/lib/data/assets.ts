/**
 * Fixed asset and tax readers: the register with each asset's accumulated
 * depreciation and book value, the monthly runs, the capital allowance
 * classes, and each tax year with what the ledger and the register say about
 * it — the accounting profit, the depreciation in it, and the additions and
 * disposals that move the pools.
 *
 * The computation itself is pure and lives in src/lib/assets.ts. Nothing here
 * decides anything; it only reads.
 */

import type {
  Account,
  AssetDisposal,
  CapitalAllowanceClass,
  Contact,
  DepreciationLine,
  DepreciationMethod as PrismaDepreciationMethod,
  DepreciationRun,
  FixedAsset,
  JournalEntry,
  JournalLine,
  ProvisionalTaxPayment,
  TaxAdjustment,
  TaxAdjustmentKind,
  TaxYear,
  TaxYearPool,
  User,
} from '@prisma/client';

import { assetAccounts, type AdjustmentKind, type AllowanceMethod, type DepreciationMethod } from '../assets';
import { prisma } from '../prisma';
import { postedJournal } from './documents';
import { toMinor } from './money';
import type { AllowanceClassRecord, DepreciationRunRecord, FixedAssetRecord, TaxYearRecord } from './types';

type JournalRow = JournalEntry & { lines: (JournalLine & { account: Pick<Account, 'code' | 'name'> })[] };
const journalInclude = { lines: { include: { account: { select: { code: true, name: true } } } } } as const;

const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const rateText = (value: { toString(): string }) => {
  const text = value.toString();
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
};

// --- enum translations -------------------------------------------------------------

const methodToRecord: Record<PrismaDepreciationMethod, DepreciationMethod> = { STRAIGHT_LINE: 'straight-line', REDUCING_BALANCE: 'reducing-balance' };
export const methodToPrisma: Record<DepreciationMethod, PrismaDepreciationMethod> = { 'straight-line': 'STRAIGHT_LINE', 'reducing-balance': 'REDUCING_BALANCE' };

const adjustmentToRecord: Record<TaxAdjustmentKind, AdjustmentKind> = { ADD_BACK: 'add-back', DEDUCTION: 'deduction', INCENTIVE: 'incentive' };
export const adjustmentToPrisma: Record<AdjustmentKind, TaxAdjustmentKind> = { 'add-back': 'ADD_BACK', deduction: 'DEDUCTION', incentive: 'INCENTIVE' };

// --- row → record -------------------------------------------------------------------

export const assetInclude = {
  supplier: { select: { name: true } },
  allowanceClass: { select: { name: true } },
  depreciation: { select: { amountMinor: true } },
  disposal: true,
} as const;

type AssetRow = FixedAsset & {
  supplier: Pick<Contact, 'name'> | null;
  allowanceClass: Pick<CapitalAllowanceClass, 'name'> | null;
  depreciation: Pick<DepreciationLine, 'amountMinor'>[];
  disposal: AssetDisposal | null;
};

export function assetRecord(row: AssetRow): FixedAssetRecord {
  const accumulatedMinor = toMinor(row.openingAccumulated) + row.depreciation.reduce((total, line) => total + toMinor(line.amountMinor), 0);
  return {
    id: row.id,
    entityId: row.entityId,
    code: row.code,
    description: row.description,
    category: row.category ?? '',
    purchaseDate: isoDate(row.purchaseDate),
    inServiceDate: isoDate(row.inServiceDate),
    costMinor: toMinor(row.costMinor),
    residualMinor: toMinor(row.residualMinor),
    usefulLifeMonths: row.usefulLifeMonths,
    method: methodToRecord[row.method],
    supplierContactId: row.supplierContactId,
    supplierName: row.supplier?.name ?? '',
    location: row.location ?? '',
    custodian: row.custodian ?? '',
    serialNumber: row.serialNumber ?? '',
    allowanceClassId: row.allowanceClassId,
    allowanceClassName: row.allowanceClass?.name ?? '',
    note: row.note ?? '',
    status: row.status === 'DISPOSED' ? 'disposed' : 'in-use',
    accumulatedMinor,
    bookValueMinor: toMinor(row.costMinor) - accumulatedMinor,
    disposal: row.disposal
      ? {
          date: isoDate(row.disposal.date),
          proceedsMinor: toMinor(row.disposal.proceedsMinor),
          bookValueMinor: toMinor(row.disposal.bookValueMinor),
          gainLossMinor: toMinor(row.disposal.gainLossMinor),
          note: row.disposal.note ?? '',
        }
      : null,
  };
}

export const runInclude = {
  journalEntry: { include: journalInclude },
  postedBy: { select: { name: true } },
  lines: { include: { asset: { select: { code: true, description: true } } } },
} as const;

export function runRecord(
  row: DepreciationRun & { journalEntry: JournalRow | null; postedBy: Pick<User, 'name'> | null; lines: (DepreciationLine & { asset: Pick<FixedAsset, 'code' | 'description'> })[] },
): DepreciationRunRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    period: row.period,
    totalMinor: toMinor(row.totalMinor),
    postedAt: row.postedAt.toISOString(),
    postedByName: row.postedBy?.name ?? '',
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    lines: [...row.lines]
      .sort((a, b) => a.asset.code.localeCompare(b.asset.code))
      .map((line) => ({ assetId: line.assetId, assetCode: line.asset.code, description: line.asset.description, amountMinor: toMinor(line.amountMinor) })),
  };
}

export function allowanceClassRecord(row: CapitalAllowanceClass): AllowanceClassRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    code: row.code,
    name: row.name,
    ratePct: rateText(row.ratePct),
    method: methodToRecord[row.method] as AllowanceMethod,
    note: row.note ?? '',
    isActive: row.isActive,
  };
}

export const taxYearInclude = {
  adjustments: { orderBy: { createdAt: 'asc' } },
  pools: true,
  provisional: { include: { bankAccount: { select: { name: true } }, journalEntry: { include: journalInclude } }, orderBy: { date: 'asc' } },
} as const;

type TaxYearRow = TaxYear & {
  adjustments: TaxAdjustment[];
  pools: TaxYearPool[];
  provisional: (ProvisionalTaxPayment & { bankAccount: { name: string }; journalEntry: JournalRow | null })[];
};

/**
 * The accounting profit for a window, read from the ledger: income less cost
 * of sales and expenses. Company tax itself is left out — the profit the
 * computation starts from is the profit before tax.
 */
async function accountingProfit(entityId: string, from: Date, to: Date): Promise<{ profitMinor: number; depreciationMinor: number }> {
  const accounts = await prisma.account.findMany({ where: { entityId, type: { in: ['INCOME', 'COST_OF_SALES', 'EXPENSE'] } }, select: { id: true, type: true, code: true, category: true } });
  if (accounts.length === 0) return { profitMinor: 0, depreciationMinor: 0 };
  const sums = await prisma.journalLine.groupBy({
    by: ['accountId', 'direction'],
    where: { entityId, accountId: { in: accounts.map((account) => account.id) }, journalEntry: { postedAt: { gte: from, lte: to } } },
    _sum: { amountMinor: true },
  });
  const byAccount = new Map<string, number>();
  for (const row of sums) {
    const signed = (row.direction === 'MONEY_IN' ? 1 : -1) * toMinor(row._sum.amountMinor ?? 0n);
    byAccount.set(row.accountId, (byAccount.get(row.accountId) ?? 0) + signed);
  }
  let profitMinor = 0;
  let depreciationMinor = 0;
  for (const account of accounts) {
    // The tax charge itself is left out: the computation starts from the
    // profit before tax, or it would be chasing its own tail.
    if (account.code === assetAccounts.incomeTaxCharge) continue;
    const balance = byAccount.get(account.id) ?? 0;
    // Income carries a credit balance and costs a debit one, so the profit is
    // simply the negative of everything in the profit and loss.
    profitMinor -= balance;
    if (account.category === assetAccounts.depreciationCategory) depreciationMinor += balance;
  }
  return { profitMinor, depreciationMinor };
}

/** What the register did in the year, by capital allowance class. */
async function poolMovements(entityId: string, from: Date, to: Date) {
  const assets = await prisma.fixedAsset.findMany({
    where: { entityId, allowanceClassId: { not: null } },
    select: { id: true, allowanceClassId: true, costMinor: true, purchaseDate: true, disposal: { select: { date: true, proceedsMinor: true } } },
  });
  const additionsByClass: Record<string, number> = {};
  const disposalProceedsByClass: Record<string, number> = {};
  const straightLineCostByClass: Record<string, number> = {};
  for (const asset of assets) {
    const classId = asset.allowanceClassId as string;
    if (asset.purchaseDate >= from && asset.purchaseDate <= to) additionsByClass[classId] = (additionsByClass[classId] ?? 0) + toMinor(asset.costMinor);
    if (asset.disposal && asset.disposal.date >= from && asset.disposal.date <= to) {
      disposalProceedsByClass[classId] = (disposalProceedsByClass[classId] ?? 0) + toMinor(asset.disposal.proceedsMinor);
    }
    // Straight-line classes claim on cost for as long as the asset is held.
    const goneBefore = asset.disposal && asset.disposal.date < from;
    const boughtAfter = asset.purchaseDate > to;
    if (!goneBefore && !boughtAfter) straightLineCostByClass[classId] = (straightLineCostByClass[classId] ?? 0) + toMinor(asset.costMinor);
  }
  return { additionsByClass, disposalProceedsByClass, straightLineCostByClass };
}

export async function taxYearRecord(row: TaxYearRow): Promise<TaxYearRecord> {
  const [profit, movements] = await Promise.all([accountingProfit(row.entityId, row.startDate, row.endDate), poolMovements(row.entityId, row.startDate, row.endDate)]);
  return {
    id: row.id,
    entityId: row.entityId,
    label: row.label,
    startDate: isoDate(row.startDate),
    endDate: isoDate(row.endDate),
    ratePct: rateText(row.ratePct),
    lossBroughtForwardMinor: toMinor(row.lossBroughtForwardMinor),
    estimatedLiabilityMinor: toMinor(row.estimatedLiabilityMinor),
    taxChargeMinor: row.taxChargeMinor === null ? null : toMinor(row.taxChargeMinor),
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    note: row.note ?? '',
    adjustments: row.adjustments.map((adjustment) => ({
      id: adjustment.id,
      kind: adjustmentToRecord[adjustment.kind],
      description: adjustment.description,
      amountMinor: toMinor(adjustment.amountMinor),
      note: adjustment.note ?? '',
    })),
    pools: row.pools.map((pool) => ({ classId: pool.classId, openingMinor: toMinor(pool.openingMinor) })),
    provisional: row.provisional.map((payment) => ({
      id: payment.id,
      quarter: payment.quarter,
      date: isoDate(payment.date),
      amountMinor: toMinor(payment.amountMinor),
      bankAccountId: payment.bankAccountId,
      bankAccountName: payment.bankAccount.name,
      reference: payment.reference ?? '',
      journal: payment.journalEntry ? postedJournal(payment.journalEntry) : null,
    })),
    accountingProfitMinor: profit.profitMinor,
    depreciationMinor: profit.depreciationMinor,
    ...movements,
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/** Scoped by the principal's grant in every query. */
export async function loadAssetData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [assets, runs, classes, years] = await Promise.all([
    prisma.fixedAsset.findMany({ where: scope, include: assetInclude, orderBy: [{ entityId: 'asc' }, { code: 'asc' }] }),
    prisma.depreciationRun.findMany({ where: scope, include: runInclude, orderBy: { period: 'desc' }, take: 120 }),
    prisma.capitalAllowanceClass.findMany({ where: scope, orderBy: [{ entityId: 'asc' }, { code: 'asc' }] }),
    prisma.taxYear.findMany({ where: scope, include: taxYearInclude, orderBy: { startDate: 'desc' } }),
  ]);
  const yearRecords = await Promise.all(years.map(taxYearRecord));
  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));
  return {
    assetsByEntity: withAll(groupBy(assets.map(assetRecord), (row) => row.entityId)),
    depreciationRunsByEntity: withAll(groupBy(runs.map(runRecord), (row) => row.entityId)),
    allowanceClassesByEntity: withAll(groupBy(classes.map(allowanceClassRecord), (row) => row.entityId)),
    taxYearsByEntity: withAll(groupBy(yearRecords, (row) => row.entityId)),
  };
}

/** One tax year, fresh, for a server function to return. */
export async function readTaxYear(entityId: string, taxYearId: string): Promise<TaxYearRecord> {
  return taxYearRecord(await prisma.taxYear.findFirstOrThrow({ where: { id: taxYearId, entityId }, include: taxYearInclude }));
}

/** One asset, fresh. */
export async function readAsset(entityId: string, assetId: string): Promise<FixedAssetRecord> {
  return assetRecord(await prisma.fixedAsset.findFirstOrThrow({ where: { id: assetId, entityId }, include: assetInclude }));
}
