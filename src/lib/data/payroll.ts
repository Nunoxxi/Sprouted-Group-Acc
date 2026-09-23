/**
 * Payroll readers: the saved column mappings, the departments and the
 * accounts their pay goes to, each month's run with its people and what it
 * left owing, and the percentages that split a person's cost across grants.
 *
 * No payroll is computed here or anywhere in the app. These read what was
 * imported.
 */

import type {
  Account,
  BankAccount,
  Grant,
  GrantBudgetLine,
  JournalEntry,
  JournalLine,
  PayrollAllocation,
  PayrollDepartment,
  PayrollLiability,
  PayrollLiabilityKind,
  PayrollLiabilityPayment,
  PayrollLine,
  PayrollMapping,
  PayrollRun,
  User,
} from '@prisma/client';

import type { LiabilityKind } from '../payroll';
import { prisma } from '../prisma';
import { postedJournal } from './documents';
import { toMinor } from './money';
import type { PayrollAllocationRecord, PayrollDepartmentRecord, PayrollLiabilityRecord, PayrollMappingRecord, PayrollRunRecord } from './types';

type JournalRow = JournalEntry & { lines: (JournalLine & { account: Pick<Account, 'code' | 'name'> })[] };
const journalInclude = { lines: { include: { account: { select: { code: true, name: true } } } } } as const;

const isoDate = (value: Date) => value.toISOString().slice(0, 10);
const pctText = (value: { toString(): string }) => {
  const text = value.toString();
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
};

// --- enum translations ------------------------------------------------------------

const kindToRecord: Record<PayrollLiabilityKind, LiabilityKind> = {
  PAYE: 'paye',
  SSNIT_TIER_1: 'ssnit-tier-1',
  SSNIT_TIER_2: 'ssnit-tier-2',
  NET_PAY: 'net-pay',
  OTHER_DEDUCTIONS: 'other-deductions',
};
export const kindToPrisma: Record<LiabilityKind, PayrollLiabilityKind> = {
  paye: 'PAYE',
  'ssnit-tier-1': 'SSNIT_TIER_1',
  'ssnit-tier-2': 'SSNIT_TIER_2',
  'net-pay': 'NET_PAY',
  'other-deductions': 'OTHER_DEDUCTIONS',
};
export const liabilityKindOf = (value: PayrollLiabilityKind): LiabilityKind => kindToRecord[value];

// --- row → record ------------------------------------------------------------------

export const mappingInclude = { defaultAccount: { select: { code: true } } } as const;

export function mappingRecord(row: PayrollMapping & { defaultAccount: Pick<Account, 'code'> | null }): PayrollMappingRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    employeeRefColumn: row.employeeRefColumn ?? '',
    employeeNameColumn: row.employeeNameColumn,
    departmentColumn: row.departmentColumn ?? '',
    grossColumn: row.grossColumn,
    payeColumn: row.payeColumn ?? '',
    employeeSsnitColumn: row.employeeSsnitColumn ?? '',
    employerSsnitColumn: row.employerSsnitColumn ?? '',
    ssnitTier2Column: row.ssnitTier2Column ?? '',
    otherDeductionsColumn: row.otherDeductionsColumn ?? '',
    netColumn: row.netColumn ?? '',
    defaultAccountCode: row.defaultAccount?.code ?? '',
  };
}

export const departmentInclude = { account: { select: { code: true, name: true } } } as const;

export function departmentRecord(row: PayrollDepartment & { account: Pick<Account, 'code' | 'name'> }): PayrollDepartmentRecord {
  return { id: row.id, entityId: row.entityId, name: row.name, accountCode: row.account.code, accountName: row.account.name };
}

export const runInclude = {
  mapping: { select: { name: true } },
  postedBy: { select: { name: true } },
  journalEntry: { include: journalInclude },
  lines: { orderBy: { employeeName: 'asc' } },
  liabilities: { include: { payments: { include: { bankAccount: { select: { name: true } } }, orderBy: { date: 'asc' } } } },
} as const;

type RunRow = PayrollRun & {
  mapping: Pick<PayrollMapping, 'name'> | null;
  postedBy: Pick<User, 'name'> | null;
  journalEntry: JournalRow | null;
  lines: PayrollLine[];
  liabilities: (PayrollLiability & { payments: (PayrollLiabilityPayment & { bankAccount: Pick<BankAccount, 'name'> })[] })[];
};

export function runRecord(row: RunRow): PayrollRunRecord {
  const grossMinor = toMinor(row.grossMinor);
  const employerSsnitMinor = toMinor(row.employerSsnitMinor);
  const ssnitTier2Minor = toMinor(row.ssnitTier2Minor);
  return {
    id: row.id,
    entityId: row.entityId,
    period: row.period,
    payDate: isoDate(row.payDate),
    mappingName: row.mapping?.name ?? '',
    fileName: row.fileName,
    grossMinor,
    payeMinor: toMinor(row.payeMinor),
    employeeSsnitMinor: toMinor(row.employeeSsnitMinor),
    employerSsnitMinor,
    ssnitTier2Minor,
    otherDeductionsMinor: toMinor(row.otherDeductionsMinor),
    netMinor: toMinor(row.netMinor),
    // What the month actually cost the entity: gross plus what it pays on top.
    employerCostMinor: grossMinor + employerSsnitMinor + ssnitTier2Minor,
    status: row.status === 'POSTED' ? 'posted' : 'draft',
    note: row.note ?? '',
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    postedByName: row.postedBy?.name ?? '',
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    lines: row.lines.map((line) => ({
      id: line.id,
      employeeRef: line.employeeRef ?? '',
      employeeName: line.employeeName,
      department: line.department ?? '',
      grossMinor: toMinor(line.grossMinor),
      payeMinor: toMinor(line.payeMinor),
      employeeSsnitMinor: toMinor(line.employeeSsnitMinor),
      employerSsnitMinor: toMinor(line.employerSsnitMinor),
      ssnitTier2Minor: toMinor(line.ssnitTier2Minor),
      otherDeductionsMinor: toMinor(line.otherDeductionsMinor),
      netMinor: toMinor(line.netMinor),
    })),
    liabilities: row.liabilities.map((liability) => liabilityRecord(liability, row.period)),
  };
}

export function liabilityRecord(
  row: PayrollLiability & { payments: (PayrollLiabilityPayment & { bankAccount: Pick<BankAccount, 'name'> })[] },
  period: string,
): PayrollLiabilityRecord {
  return {
    id: row.id,
    runId: row.runId,
    period,
    kind: kindToRecord[row.kind],
    amountMinor: toMinor(row.amountMinor),
    settledMinor: toMinor(row.settledMinor),
    dueDate: isoDate(row.dueDate),
    payments: row.payments.map((payment) => ({
      id: payment.id,
      date: isoDate(payment.date),
      amountMinor: toMinor(payment.amountMinor),
      bankAccountName: payment.bankAccount.name,
      reference: payment.reference ?? '',
    })),
  };
}

export const allocationInclude = { grant: { select: { code: true } }, budgetLine: { select: { code: true, name: true } } } as const;

export function allocationRecord(row: PayrollAllocation & { grant: Pick<Grant, 'code'>; budgetLine: Pick<GrantBudgetLine, 'code' | 'name'> | null }): PayrollAllocationRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    employeeKey: row.employeeKey,
    employeeName: row.employeeName ?? '',
    grantId: row.grantId,
    grantCode: row.grant.code,
    budgetLineId: row.budgetLineId,
    budgetLineName: row.budgetLine ? `${row.budgetLine.code} ${row.budgetLine.name}` : '',
    pct: pctText(row.pct),
  };
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) (groups[keyOf(item)] ??= []).push(item);
  return groups;
}

/** Scoped by the principal's grant in every query. */
export async function loadPayrollData(scope: { entityId?: { in: string[] } }, entityIds: string[]) {
  const [mappings, departments, runs, allocations] = await Promise.all([
    prisma.payrollMapping.findMany({ where: scope, include: mappingInclude, orderBy: [{ entityId: 'asc' }, { name: 'asc' }] }),
    prisma.payrollDepartment.findMany({ where: scope, include: departmentInclude, orderBy: [{ entityId: 'asc' }, { name: 'asc' }] }),
    prisma.payrollRun.findMany({ where: scope, include: runInclude, orderBy: { period: 'desc' }, take: 60 }),
    prisma.payrollAllocation.findMany({ where: scope, include: allocationInclude, orderBy: [{ employeeName: 'asc' }, { createdAt: 'asc' }] }),
  ]);
  const withAll = <T>(grouped: Record<string, T[]>): Record<string, T[]> => Object.fromEntries(entityIds.map((id) => [id, grouped[id] ?? []]));
  return {
    payrollMappingsByEntity: withAll(groupBy(mappings.map(mappingRecord), (row) => row.entityId)),
    payrollDepartmentsByEntity: withAll(groupBy(departments.map(departmentRecord), (row) => row.entityId)),
    payrollRunsByEntity: withAll(groupBy(runs.map(runRecord), (row) => row.entityId)),
    payrollAllocationsByEntity: withAll(groupBy(allocations.map(allocationRecord), (row) => row.entityId)),
  };
}

/** One run, fresh, for a server function to return. */
export async function readRun(entityId: string, runId: string): Promise<PayrollRunRecord> {
  return runRecord(await prisma.payrollRun.findFirstOrThrow({ where: { id: runId, entityId }, include: runInclude }));
}

/** Every payroll liability of an entity, for the dashboard. */
export async function liabilitiesFor(entityId: string) {
  const rows = await prisma.payrollLiability.findMany({
    where: { entityId, run: { status: 'POSTED' } },
    include: { run: { select: { period: true } }, payments: { include: { bankAccount: { select: { name: true } } } } },
    orderBy: { dueDate: 'asc' },
  });
  return rows.map((row) => liabilityRecord(row, row.run.period));
}
