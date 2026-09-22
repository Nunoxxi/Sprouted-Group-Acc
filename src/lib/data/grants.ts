/**
 * Grant readers: grants with their budget lines, conditions, receipts and
 * releases; the postings attributed to each grant, read from the ledger; and
 * the in-kind and staff-time contributions. Prisma → records, every amount
 * through toMinor().
 */

import type {
  Account,
  Contact,
  Fund,
  Grant,
  GrantBudgetLine,
  GrantCondition,
  GrantIncomePolicy,
  GrantReceipt,
  GrantRelease,
  GrantReleaseBasis,
  GrantReportingFrequency,
  GrantStatus,
  InKindContribution,
  InKindKind as PrismaInKindKind,
  JournalEntry,
  JournalLine,
  StaffTimeAllocation,
  User,
} from '@prisma/client';

import type { GrantActual, InKindKind, IncomePolicy, ReportingFrequency } from '../grants';
import { prisma } from '../prisma';
import { postedJournal } from './documents';
import { toMinor } from './money';
import type {
  GrantBudgetLineRecord,
  GrantConditionRecord,
  GrantReceiptRecord,
  GrantRecord,
  GrantReleaseRecord,
  InKindRecord,
  StaffTimeRecord,
} from './types';

type JournalRow = JournalEntry & { lines: (JournalLine & { account: Pick<Account, 'code' | 'name'> })[] };
const journalInclude = { lines: { include: { account: { select: { code: true, name: true } } } } } as const;

const isoDate = (value: Date) => value.toISOString().slice(0, 10);
/** A rate as the app carries it: an exact decimal string, trailing zeros trimmed. */
const rateText = (value: { toString(): string }) => {
  const text = value.toString();
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '.0') : text;
};

// --- enum translations ------------------------------------------------------------------

const policyToRecord: Record<GrantIncomePolicy, IncomePolicy> = { ON_RECEIPT: 'on-receipt', DEFERRED: 'deferred' };
export const policyToPrisma: Record<IncomePolicy, GrantIncomePolicy> = { 'on-receipt': 'ON_RECEIPT', deferred: 'DEFERRED' };

const frequencyToRecord: Record<GrantReportingFrequency, ReportingFrequency> = {
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  HALF_YEARLY: 'half-yearly',
  ANNUAL: 'annual',
  FINAL_ONLY: 'final-only',
};
export const frequencyToPrisma: Record<ReportingFrequency, GrantReportingFrequency> = {
  monthly: 'MONTHLY',
  quarterly: 'QUARTERLY',
  'half-yearly': 'HALF_YEARLY',
  annual: 'ANNUAL',
  'final-only': 'FINAL_ONLY',
};

const statusToRecord: Record<GrantStatus, GrantRecord['status']> = { DRAFT: 'draft', ACTIVE: 'active', CLOSED: 'closed' };
export const statusToPrisma: Record<GrantRecord['status'], GrantStatus> = { draft: 'DRAFT', active: 'ACTIVE', closed: 'CLOSED' };

const basisToRecord: Record<GrantReleaseBasis, 'spending' | 'condition'> = { SPENDING: 'spending', CONDITION: 'condition' };
export const basisToPrisma: Record<'spending' | 'condition', GrantReleaseBasis> = { spending: 'SPENDING', condition: 'CONDITION' };

const inKindToRecord: Record<PrismaInKindKind, InKindKind> = { GOODS: 'goods', SERVICES: 'services', FACILITIES: 'facilities' };
export const inKindToPrisma: Record<InKindKind, PrismaInKindKind> = { goods: 'GOODS', services: 'SERVICES', facilities: 'FACILITIES' };

// --- row → record ------------------------------------------------------------------------

export function budgetLineRecord(row: GrantBudgetLine & { account: Pick<Account, 'code' | 'name'> }): GrantBudgetLineRecord {
  return {
    id: row.id,
    grantId: row.grantId,
    code: row.code,
    name: row.name,
    accountId: row.accountId,
    accountCode: row.account.code,
    accountName: row.account.name,
    budgetMinor: toMinor(row.budgetMinor),
    note: row.note ?? '',
  };
}

export function conditionRecord(row: GrantCondition & { metBy: Pick<User, 'name'> | null; releases: Pick<GrantRelease, 'amountMinor'>[] }): GrantConditionRecord {
  return {
    id: row.id,
    grantId: row.grantId,
    description: row.description,
    dueDate: row.dueDate ? isoDate(row.dueDate) : null,
    metAt: row.metAt ? row.metAt.toISOString() : null,
    metByName: row.metBy?.name ?? '',
    note: row.note ?? '',
    releasedMinor: row.releases.reduce((total, release) => total + toMinor(release.amountMinor), 0),
  };
}

export function receiptRecord(row: GrantReceipt & { bankAccount: { name: string }; journalEntry: JournalRow | null }): GrantReceiptRecord {
  return {
    id: row.id,
    grantId: row.grantId,
    date: isoDate(row.date),
    txnCurrency: row.txnCurrency,
    txnAmountMinor: toMinor(row.txnAmountMinor),
    rate: rateText(row.rate),
    amountMinor: toMinor(row.amountMinor),
    bankAccountId: row.bankAccountId,
    bankAccountName: row.bankAccount.name,
    reference: row.reference ?? '',
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
  };
}

export function releaseRecord(row: GrantRelease & { journalEntry: JournalRow | null }): GrantReleaseRecord {
  return {
    id: row.id,
    grantId: row.grantId,
    date: isoDate(row.date),
    amountMinor: toMinor(row.amountMinor),
    basis: basisToRecord[row.basis],
    conditionId: row.conditionId,
    note: row.note ?? '',
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
  };
}

export const grantInclude = {
  donor: { select: { name: true } },
  fund: { select: { name: true } },
  createdBy: { select: { name: true } },
  budgetLines: { include: { account: { select: { code: true, name: true } } }, orderBy: { code: 'asc' } },
  conditions: { include: { metBy: { select: { name: true } }, releases: { select: { amountMinor: true } } }, orderBy: { createdAt: 'asc' } },
  receipts: { include: { bankAccount: { select: { name: true } }, journalEntry: { include: journalInclude } }, orderBy: { date: 'asc' } },
  releases: { include: { journalEntry: { include: journalInclude } }, orderBy: { date: 'asc' } },
  inKind: { select: { valueMinor: true } },
  staffTime: { select: { valueMinor: true } },
} as const;

type GrantRow = Grant & {
  donor: Pick<Contact, 'name'>;
  fund: Pick<Fund, 'name'> | null;
  createdBy: Pick<User, 'name'> | null;
  budgetLines: (GrantBudgetLine & { account: Pick<Account, 'code' | 'name'> })[];
  conditions: (GrantCondition & { metBy: Pick<User, 'name'> | null; releases: Pick<GrantRelease, 'amountMinor'>[] })[];
  receipts: (GrantReceipt & { bankAccount: { name: string }; journalEntry: JournalRow | null })[];
  releases: (GrantRelease & { journalEntry: JournalRow | null })[];
  inKind: Pick<InKindContribution, 'valueMinor'>[];
  staffTime: Pick<StaffTimeAllocation, 'valueMinor'>[];
};

/** `spentMinor` comes from the caller because it is read from the ledger, not from the grant's own rows. */
export function grantRecord(row: GrantRow, spentMinor: number): GrantRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    code: row.code,
    name: row.name,
    donorContactId: row.donorContactId,
    donorName: row.donor.name,
    fundId: row.fundId,
    fundName: row.fund?.name ?? '',
    projectId: row.projectId,
    currency: row.currency,
    amountMinor: toMinor(row.amountMinor),
    rate: rateText(row.rate),
    startDate: isoDate(row.startDate),
    endDate: isoDate(row.endDate),
    restricted: row.restricted,
    incomePolicy: policyToRecord[row.incomePolicy],
    reportingFrequency: frequencyToRecord[row.reportingFrequency],
    reportingStartDate: row.reportingStartDate ? isoDate(row.reportingStartDate) : null,
    reportingDueDays: row.reportingDueDays,
    underspendThresholdPct: row.underspendThresholdPct,
    status: statusToRecord[row.status],
    note: row.note ?? '',
    budgetLines: row.budgetLines.map(budgetLineRecord),
    conditions: row.conditions.map(conditionRecord),
    receipts: row.receipts.map(receiptRecord),
    releases: row.releases.map(releaseRecord),
    receivedMinor: row.receipts.reduce((total, receipt) => total + toMinor(receipt.amountMinor), 0),
    releasedMinor: row.releases.reduce((total, release) => total + toMinor(release.amountMinor), 0),
    spentMinor,
    inKindMinor: row.inKind.reduce((total, contribution) => total + toMinor(contribution.valueMinor), 0),
    staffTimeMinor: row.staffTime.reduce((total, allocation) => total + toMinor(allocation.valueMinor), 0),
    createdByName: row.createdBy?.name ?? '',
  };
}

export const inKindInclude = { donor: { select: { name: true } }, journalEntry: { include: journalInclude } } as const;

export function inKindRecord(row: InKindContribution & { donor: Pick<Contact, 'name'> | null; journalEntry: JournalRow | null }): InKindRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    grantId: row.grantId,
    budgetLineId: row.budgetLineId,
    date: isoDate(row.date),
    description: row.description,
    kind: inKindToRecord[row.kind],
    valueMinor: toMinor(row.valueMinor),
    basis: row.basis ?? '',
    donorContactId: row.donorContactId,
    donorName: row.donor?.name ?? '',
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
  };
}

export const staffTimeInclude = { account: { select: { code: true } } } as const;

export function staffTimeRecord(row: StaffTimeAllocation & { account: Pick<Account, 'code'> }): StaffTimeRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    grantId: row.grantId,
    budgetLineId: row.budgetLineId,
    personName: row.personName,
    role: row.role ?? '',
    periodStart: isoDate(row.periodStart),
    periodEnd: isoDate(row.periodEnd),
    hours: Number(row.hours),
    rateMinorPerHour: toMinor(row.rateMinorPerHour),
    valueMinor: toMinor(row.valueMinor),
    accountCode: row.account.code,
    note: row.note ?? '',
    posted: !!row.journalEntryId,
  };
}

// --- actuals from the ledger ----------------------------------------------------------------

/** Expenditure accounts: what a grant's money is spent on. */
const spendTypes = ['EXPENSE', 'COST_OF_SALES'] as const;

/**
 * Every posting attributed to a grant, in functional currency, signed so a
 * debit to an expense account is spending and a credit (a correction or a
 * reversal) takes it back. Read from the journal, so what the donor is shown
 * is what the books say.
 */
export async function grantActuals(scope: { entityId?: { in: string[] } }): Promise<(GrantActual & { grantId: string; entityId: string })[]> {
  const lines = await prisma.journalLine.findMany({
    where: { ...scope, grantId: { not: null }, account: { type: { in: [...spendTypes] } } },
    select: { entityId: true, grantId: true, budgetLineId: true, amountMinor: true, direction: true, journalEntry: { select: { postedAt: true } } },
  });
  return lines.map((line) => ({
    entityId: line.entityId,
    grantId: line.grantId as string,
    budgetLineId: line.budgetLineId,
    date: isoDate(line.journalEntry.postedAt),
    functionalMinor: (line.direction === 'MONEY_IN' ? 1 : -1) * toMinor(line.amountMinor),
  }));
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/** Scoped by the principal's grant in every query. */
export async function loadGrantData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [grants, actuals, inKind, staffTime] = await Promise.all([
    prisma.grant.findMany({ where: scope, include: grantInclude, orderBy: [{ entityId: 'asc' }, { startDate: 'desc' }] }),
    grantActuals(scope),
    prisma.inKindContribution.findMany({ where: scope, include: inKindInclude, orderBy: { date: 'desc' }, take: 500 }),
    prisma.staffTimeAllocation.findMany({ where: scope, include: staffTimeInclude, orderBy: { periodStart: 'desc' }, take: 500 }),
  ]);
  const spentByGrant = new Map<string, number>();
  for (const actual of actuals) spentByGrant.set(actual.grantId, (spentByGrant.get(actual.grantId) ?? 0) + actual.functionalMinor);

  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));
  return {
    grantsByEntity: withAll(groupBy(grants.map((row) => grantRecord(row, spentByGrant.get(row.id) ?? 0)), (r) => r.entityId)),
    grantActualsByEntity: withAll(groupBy(actuals, (r) => r.entityId)),
    inKindByEntity: withAll(groupBy(inKind.map(inKindRecord), (r) => r.entityId)),
    staffTimeByEntity: withAll(groupBy(staffTime.map(staffTimeRecord), (r) => r.entityId)),
  };
}

/** One grant, fresh from the database, for the server functions to return. */
export async function readGrant(entityId: string, grantId: string): Promise<GrantRecord> {
  const row = await prisma.grant.findFirstOrThrow({ where: { id: grantId, entityId }, include: grantInclude });
  const actuals = await grantActuals({ entityId: { in: [entityId] } });
  const spent = actuals.filter((actual) => actual.grantId === grantId).reduce((total, actual) => total + actual.functionalMinor, 0);
  return grantRecord(row, spent);
}
