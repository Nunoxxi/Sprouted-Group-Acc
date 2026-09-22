/**
 * Cash flow readers: the buying seasons, recurring costs and scenarios a
 * person maintains, and everything a forecast is built from — cash on hand,
 * open documents, undelivered contracts, grant schedules and agent floats.
 *
 * The forecast itself is not stored. It is computed from these in the
 * browser, so changing an assumption redraws it without another round trip
 * and nothing can go stale behind the person's back.
 */

import type {
  Account,
  BuyingSeason,
  CashScenario,
  CashScenarioLine,
  CashScenarioRate,
  Commodity,
  Grant,
  GrantReceipt,
  RecurringCost,
  RecurringFrequency as PrismaRecurringFrequency,
} from '@prisma/client';

import { contractValueMinor, type PriceUnit } from '../contracts';
import { controlAccounts } from '../documents';
import type { Flow, RecurringFrequency } from '../cashflow';
import { grantFlows } from '../cashflow';
import type { Currency } from '../fx';
import { reportingPeriods } from '../grants';
import { prisma } from '../prisma';

import { toMinor } from './money';
import type { BuyingSeasonRecord, CashScenarioRecord, CashSourceRecord, RecurringCostRecord } from './types';

const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const rateText = (value: { toString(): string }) => {
  const text = value.toString();
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '.0') : text;
};

// --- enum translations --------------------------------------------------------------

const frequencyToRecord: Record<PrismaRecurringFrequency, RecurringFrequency> = { WEEKLY: 'weekly', MONTHLY: 'monthly', QUARTERLY: 'quarterly', ANNUAL: 'annual' };
export const frequencyToPrisma: Record<RecurringFrequency, PrismaRecurringFrequency> = { weekly: 'WEEKLY', monthly: 'MONTHLY', quarterly: 'QUARTERLY', annual: 'ANNUAL' };

// --- row → record --------------------------------------------------------------------

export const seasonInclude = { commodity: { select: { name: true } } } as const;

export function seasonRecord(row: BuyingSeason & { commodity: Pick<Commodity, 'name'> }): BuyingSeasonRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    commodityId: row.commodityId,
    commodityName: row.commodity.name,
    name: row.name,
    startDate: isoDate(row.startDate),
    peakDate: isoDate(row.peakDate),
    endDate: isoDate(row.endDate),
    expectedGrams: toMinor(row.expectedGrams),
    priceMinorPerKg: toMinor(row.priceMinorPerKg),
    currency: row.currency,
    note: row.note ?? '',
    isActive: row.isActive,
  };
}

export const recurringInclude = { account: { select: { code: true } } } as const;

export function recurringRecord(row: RecurringCost & { account: Pick<Account, 'code'> | null }): RecurringCostRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    currency: row.currency,
    amountMinor: toMinor(row.amountMinor),
    frequency: frequencyToRecord[row.frequency],
    startDate: isoDate(row.startDate),
    endDate: row.endDate ? isoDate(row.endDate) : null,
    accountCode: row.account?.code ?? '',
    note: row.note ?? '',
    isActive: row.isActive,
  };
}

export const scenarioInclude = { rates: true, lines: { orderBy: { date: 'asc' } } } as const;

export function scenarioRecord(row: CashScenario & { rates: CashScenarioRate[]; lines: CashScenarioLine[] }): CashScenarioRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    isBaseline: row.isBaseline,
    collectionDelayDays: row.collectionDelayDays,
    pricePct: row.pricePct,
    volumePct: row.volumePct,
    floatLeadDays: row.floatLeadDays,
    minimumCashMinor: toMinor(row.minimumCashMinor),
    note: row.note ?? '',
    rates: Object.fromEntries(row.rates.map((rate) => [rate.currency, rateText(rate.rate)])),
    lines: row.lines.map((line) => ({
      id: line.id,
      scenarioId: line.scenarioId,
      date: isoDate(line.date),
      currency: line.currency,
      amountMinor: toMinor(line.amountMinor),
      description: line.description,
    })),
  };
}

// --- what a forecast is built from -------------------------------------------------------

/** Cash and bank balances now, by the currency of the account holding them. */
async function openingBalances(entityId: string): Promise<Record<string, number>> {
  const banks = await prisma.bankAccount.findMany({ where: { entityId, isActive: true }, include: { account: { select: { id: true } } } });
  if (banks.length === 0) return {};
  const sums = await prisma.journalLine.groupBy({
    by: ['accountId', 'direction'],
    where: { entityId, accountId: { in: banks.map((bank) => bank.account.id) } },
    _sum: { amountMinor: true },
  });
  const byAccount = new Map<string, number>();
  for (const row of sums) {
    const signed = (row.direction === 'MONEY_IN' ? 1 : -1) * toMinor(row._sum.amountMinor ?? 0n);
    byAccount.set(row.accountId, (byAccount.get(row.accountId) ?? 0) + signed);
  }
  const openings: Record<string, number> = {};
  for (const bank of banks) {
    // The ledger holds functional amounts; a foreign account's balance is
    // shown in its own currency at the scenario rate, so it is converted back.
    openings[bank.currency] = (openings[bank.currency] ?? 0) + (byAccount.get(bank.account.id) ?? 0);
  }
  return openings;
}

/**
 * Open invoices and bills, at what is still outstanding in their own
 * currency. What the document is worth comes off its own posted journal —
 * the receivable or payable line, in the currency it was raised in — rather
 * than being recomputed, so a document is worth today exactly what it was
 * worth when it posted, whatever has changed since.
 */
async function openDocuments(entityId: string) {
  const rows = await prisma.document.findMany({
    where: { entityId, status: 'AWAITING_PAYMENT' },
    include: { contact: { select: { name: true } }, journalEntry: { include: { lines: { include: { account: { select: { code: true } } } } } } },
  });
  return rows.flatMap((row) => {
    const isBill = row.kind === 'BILL';
    const controlCode = isBill ? controlAccounts.payables : controlAccounts.receivables;
    const control = row.journalEntry?.lines.find((line) => line.account.code === controlCode);
    if (!control) return [];
    const outstandingMinor = toMinor(control.txnAmountMinor) - toMinor(row.paidTxnMinor);
    if (outstandingMinor <= 0) return [];
    return [
      {
        id: row.id,
        kind: isBill ? ('bill' as const) : ('invoice' as const),
        number: row.number ?? row.id.slice(-6),
        contactName: row.contact.name,
        currency: row.currency as Currency,
        outstandingMinor,
        dueDate: isoDate(row.dueDate),
      },
    ];
  });
}

/**
 * Contracts with quantity still to deliver, valued at the contract price in
 * the contract's own currency. Cash is expected when the buyer pays: the
 * contract carries no payment terms of its own, so the scenario's collection
 * delay is what shifts it.
 */
async function openContracts(entityId: string) {
  const rows = await prisma.salesContract.findMany({
    where: { entityId, status: 'OPEN' },
    include: { buyer: { select: { name: true } }, commodity: { select: { gramsPerBag: true } }, deliveries: { select: { grams: true } } },
  });
  return rows.flatMap((row) => {
    const deliveredGrams = row.deliveries.reduce((total, delivery) => total + toMinor(delivery.grams), 0);
    const undeliveredGrams = Math.max(toMinor(row.quantityGrams) - deliveredGrams, 0);
    if (undeliveredGrams <= 0) return [];
    const undeliveredMinor = contractValueMinor(undeliveredGrams, toMinor(row.priceMinor), row.priceUnit as PriceUnit, row.commodity.gramsPerBag);
    return [
      {
        id: row.id,
        contractNo: row.contractNo,
        buyerName: row.buyer.name,
        currency: row.currency as Currency,
        undeliveredMinor,
        deliveryDate: isoDate(row.deliveryTo),
        paymentTermsDays: 0,
      },
    ];
  });
}

/** Grant money still to come, on the donor's own reporting schedule. */
async function grantSchedules(entityId: string, from: string): Promise<Flow[]> {
  const grants = await prisma.grant.findMany({ where: { entityId, status: 'ACTIVE' }, include: { receipts: { select: { txnAmountMinor: true, txnCurrency: true } } } });
  return grants.flatMap((grant: Grant & { receipts: Pick<GrantReceipt, 'txnAmountMinor' | 'txnCurrency'>[] }) => {
    // Receipts are recorded in the account's currency; only those in the
    // donor's own currency count against the award without a rate guess.
    const receivedInDonorCurrency = grant.receipts.filter((receipt) => receipt.txnCurrency === grant.currency).reduce((total, receipt) => total + toMinor(receipt.txnAmountMinor), 0);
    const outstandingMinor = toMinor(grant.amountMinor) - receivedInDonorCurrency;
    const periodStarts = reportingPeriods({
      startDate: isoDate(grant.startDate),
      endDate: isoDate(grant.endDate),
      reportingFrequency: ({ MONTHLY: 'monthly', QUARTERLY: 'quarterly', HALF_YEARLY: 'half-yearly', ANNUAL: 'annual', FINAL_ONLY: 'final-only' } as const)[grant.reportingFrequency],
      reportingStartDate: grant.reportingStartDate ? isoDate(grant.reportingStartDate) : null,
      reportingDueDays: grant.reportingDueDays,
    }).map((period) => period.start);
    return grantFlows({ id: grant.id, code: grant.code, currency: grant.currency as Currency, outstandingMinor, periodStarts }, from);
  });
}

// Floats already advanced are not a future flow: that cash has left the bank
// and the opening balance already reflects it. What it buys arrives as
// produce, not money. The float a *coming* season needs is forecast from the
// season itself, in seasonFlows.

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/** Everything one entity's forecast is built from. */
export async function cashSourcesFor(entityId: string, entityName: string, functionalCurrency: Currency, from: string): Promise<CashSourceRecord> {
  const [openings, documents, contracts, grants, seasons, recurring] = await Promise.all([
    openingBalances(entityId),
    openDocuments(entityId),
    openContracts(entityId),
    grantSchedules(entityId, from),
    prisma.buyingSeason.findMany({ where: { entityId, isActive: true }, include: seasonInclude, orderBy: { startDate: 'asc' } }),
    prisma.recurringCost.findMany({ where: { entityId, isActive: true }, include: recurringInclude, orderBy: { name: 'asc' } }),
  ]);
  return {
    entityId,
    entityName,
    functionalCurrency,
    openings,
    fixedFlows: grants,
    seasons: seasons.map(seasonRecord),
    recurring: recurring.map(recurringRecord),
    documents,
    contracts,
  };
}

/** Scoped by the principal's grant in every query. */
export async function loadCashflowData(
  scope: { entityId?: { in: string[] } },
  entityIds: string[],
  entities: { id: string; name: string; functionalCurrency: string }[],
) {
  const [seasons, recurring, scenarios] = await Promise.all([
    prisma.buyingSeason.findMany({ where: scope, include: seasonInclude, orderBy: [{ entityId: 'asc' }, { startDate: 'asc' }] }),
    prisma.recurringCost.findMany({ where: scope, include: recurringInclude, orderBy: [{ entityId: 'asc' }, { name: 'asc' }] }),
    prisma.cashScenario.findMany({ where: scope, include: scenarioInclude, orderBy: [{ entityId: 'asc' }, { isBaseline: 'desc' }, { name: 'asc' }] }),
  ]);
  const from = new Date().toISOString().slice(0, 10);
  const sources = await Promise.all(entities.map((entity) => cashSourcesFor(entity.id, entity.name, entity.functionalCurrency as Currency, from)));

  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));
  return {
    seasonsByEntity: withAll(groupBy(seasons.map(seasonRecord), (row) => row.entityId)),
    recurringByEntity: withAll(groupBy(recurring.map(recurringRecord), (row) => row.entityId)),
    scenariosByEntity: withAll(groupBy(scenarios.map(scenarioRecord), (row) => row.entityId)),
    cashSourcesByEntity: Object.fromEntries(sources.map((source) => [source.entityId, source])),
  };
}
