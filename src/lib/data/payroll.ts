/**
 * Readers for payroll: employees and their pay, staff loans, pay runs with
 * their lines and journals, what the runs left owing, and the facts the
 * reports are built from.
 *
 * Only someone who holds payroll:view is sent any of it (loadPayrollData is
 * given that answer by the caller); src/lib/data/redact.ts then masks the
 * numbers that identify a person, as it does for contacts and farmers.
 */

import type { Account, Employee, EmployeeAllocation, EmployeeAllowance, JournalEntry, JournalLine, PayRun, PayRunDeduction, PayRunLine, PayrollRemittance, Prisma, StaffLoan } from '@prisma/client';

import type { BenefitKind, EmploymentType, PayInput, PayResult, Residency } from '../payroll-engine';
import { payrollAccounts } from '../payroll-accounts';
import { factOf, type PayLineFact } from '../payroll-reports';
import { runTotals, type RemittanceKind, type RunTotals } from '../payroll-run';
import { decryptField } from '../pii-crypto';
import { prisma } from '../prisma';
import { postedJournal } from './documents';
import { toMinor } from './money';
import type { PostedJournal } from './types';

const isoDate = (value: Date) => value.toISOString().slice(0, 10);

// --- employees --------------------------------------------------------------------------------

export type EmployeeRecord = {
  id: string;
  entityId: string;
  staffNumber: string;
  name: string;
  email: string;
  tin: string;
  ssnitNumber: string;
  startDate: string;
  endDate: string | null;
  employmentType: EmploymentType;
  residency: Residency;
  department: string;
  expenseAccountCode: string;
  payMethod: 'bank' | 'mobile-money';
  bankName: string;
  bankAccountNumber: string;
  momoNumber: string;
  basicMinor: number;
  juniorStaffOvertime: boolean;
  tier3Minor: number;
  benefitsInKind: BenefitKind[];
  reliefs: { marriage: boolean; childrenInEducation: number; agedDependants: number; disability: boolean; oldAge: boolean };
  allowances: { id: string; name: string; amountMinor: number; taxable: boolean; pensionable: boolean }[];
  allocations: { id: string; projectId: string; shareBasisPoints: number }[];
};

export const employmentTypeOf: Record<Employee['employmentType'], EmploymentType> = { PERMANENT: 'permanent', CONTRACT: 'contract', CASUAL: 'casual' };
export const employmentTypeToPrisma: Record<EmploymentType, Employee['employmentType']> = { permanent: 'PERMANENT', contract: 'CONTRACT', casual: 'CASUAL' };
export const residencyOf: Record<Employee['residency'], Residency> = { RESIDENT: 'resident', NON_RESIDENT: 'non-resident' };
export const residencyToPrisma: Record<Residency, Employee['residency']> = { resident: 'RESIDENT', 'non-resident': 'NON_RESIDENT' };

export const employeeInclude = {
  expenseAccount: { select: { code: true } },
  allowances: { where: { endedAt: null }, orderBy: { createdAt: 'asc' } },
  allocations: { where: { endedAt: null }, orderBy: { createdAt: 'asc' } },
} as const;

type EmployeeRow = Employee & { expenseAccount: Pick<Account, 'code'>; allowances: EmployeeAllowance[]; allocations: EmployeeAllocation[] };

export function employeeRecord(row: EmployeeRow): EmployeeRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    staffNumber: row.staffNumber,
    name: row.name,
    email: decryptField('Employee.email', row.email) ?? '',
    tin: row.tin ?? '',
    ssnitNumber: row.ssnitNumber ?? '',
    startDate: isoDate(row.startDate),
    endDate: row.endDate ? isoDate(row.endDate) : null,
    employmentType: employmentTypeOf[row.employmentType],
    residency: residencyOf[row.residency],
    department: row.department ?? '',
    expenseAccountCode: row.expenseAccount.code,
    payMethod: row.payMethod === 'MOBILE_MONEY' ? 'mobile-money' : 'bank',
    bankName: row.bankName ?? '',
    bankAccountNumber: decryptField('Employee.bankAccountNumber', row.bankAccountNumber) ?? '',
    momoNumber: decryptField('Employee.momoNumber', row.momoNumber) ?? '',
    basicMinor: toMinor(row.basicMinor),
    juniorStaffOvertime: row.juniorStaffOvertime,
    tier3Minor: toMinor(row.tier3Minor),
    benefitsInKind: row.benefitsInKind as BenefitKind[],
    reliefs: { marriage: row.marriageRelief, childrenInEducation: row.childrenInEducation, agedDependants: row.agedDependants, disability: row.disabilityRelief, oldAge: row.oldAgeRelief },
    allowances: row.allowances.map((a) => ({ id: a.id, name: a.name, amountMinor: toMinor(a.amountMinor), taxable: a.taxable, pensionable: a.pensionable })),
    allocations: row.allocations.map((a) => ({ id: a.id, projectId: a.projectId, shareBasisPoints: a.shareBasisPoints })),
  };
}

// --- loans ------------------------------------------------------------------------------------

export type StaffLoanRecord = {
  id: string;
  entityId: string;
  employeeId: string;
  kind: 'loan' | 'advance';
  description: string;
  principalMinor: number;
  instalmentMinor: number;
  issuedOn: string;
  firstPeriod: string;
  /** Instalments taken on posted, unreversed runs. */
  repaidMinor: number;
  outstandingMinor: number;
  repayments: { period: string; amountMinor: number }[];
};

export const loanInclude = { repayments: { include: { line: { include: { run: { select: { period: true, status: true } } } } } } } as const;
type LoanRow = StaffLoan & { repayments: (PayRunDeduction & { line: PayRunLine & { run: Pick<PayRun, 'period' | 'status'> } })[] };

export function staffLoanRecord(row: LoanRow): StaffLoanRecord {
  const repayments = row.repayments
    .filter((r) => r.line.run.status === 'POSTED')
    .map((r) => ({ period: r.line.run.period, amountMinor: toMinor(r.amountMinor) }))
    .sort((a, b) => a.period.localeCompare(b.period));
  const repaidMinor = repayments.reduce((sum, r) => sum + r.amountMinor, 0);
  return {
    id: row.id,
    entityId: row.entityId,
    employeeId: row.employeeId,
    kind: row.kind === 'advance' ? 'advance' : 'loan',
    description: row.description,
    principalMinor: toMinor(row.principalMinor),
    instalmentMinor: toMinor(row.instalmentMinor),
    issuedOn: isoDate(row.issuedOn),
    firstPeriod: row.firstPeriod,
    repaidMinor,
    outstandingMinor: toMinor(row.principalMinor) - repaidMinor,
    repayments,
  };
}

// --- pay runs ---------------------------------------------------------------------------------

/** What a line's inputsJson holds: everything a re-run of this line starts from. */
export type StoredLineInputs = {
  input: PayInput;
  allocations: { projectId: string; fundId: string | null; shareBasisPoints: number }[];
  expenseAccountCode: string;
  deductions: { loanId: string | null; name: string; amountMinor: number }[];
};

export type PayRunLineRecord = {
  id: string;
  employeeId: string;
  bonusInputMinor: number;
  overtimeInputMinor: number;
  error: string | null;
  inputs: StoredLineInputs | null;
  result: PayResult | null;
};

export type PayRunStatus = 'draft' | 'approved' | 'posted' | 'reversed';

export type PayRunRecord = {
  id: string;
  entityId: string;
  period: string;
  sequence: number;
  status: PayRunStatus;
  payDate: string;
  calculatedAt: string | null;
  approvedByName: string;
  approvedAt: string | null;
  postedByName: string;
  postedAt: string | null;
  reversedByName: string;
  reversedAt: string | null;
  reversalReason: string;
  lines: PayRunLineRecord[];
  totals: RunTotals;
  journal: PostedJournal | null;
  reversalJournal: PostedJournal | null;
};

const statusOf: Record<PayRun['status'], PayRunStatus> = { DRAFT: 'draft', APPROVED: 'approved', POSTED: 'posted', REVERSED: 'reversed' };

const journalInclude = { lines: { include: { account: { select: { code: true, name: true } } } } } as const;
type JournalRow = JournalEntry & { lines: (JournalLine & { account: Pick<Account, 'code' | 'name'> })[] };

export const payRunInclude = {
  lines: { orderBy: { id: 'asc' } },
  journalEntry: { include: journalInclude },
  reversalJournal: { include: journalInclude },
} as const satisfies Prisma.PayRunInclude;

type PayRunRow = PayRun & { lines: PayRunLine[]; journalEntry: JournalRow | null; reversalJournal: JournalRow | null };

function parse<T>(json: string | null): T | null {
  if (!json) return null;
  return JSON.parse(json) as T;
}

export function payRunRecord(row: PayRunRow, userNames: Record<string, string>): PayRunRecord {
  const lines = row.lines.map((line) => ({
    id: line.id,
    employeeId: line.employeeId,
    bonusInputMinor: toMinor(line.bonusInputMinor),
    overtimeInputMinor: toMinor(line.overtimeInputMinor),
    error: line.error,
    inputs: parse<StoredLineInputs>(line.inputsJson),
    result: parse<PayResult>(line.resultJson),
  }));
  const name = (id: string | null) => (id ? (userNames[id] ?? '') : '');
  return {
    id: row.id,
    entityId: row.entityId,
    period: row.period,
    sequence: row.sequence,
    status: statusOf[row.status],
    payDate: isoDate(row.payDate),
    calculatedAt: row.calculatedAt ? row.calculatedAt.toISOString() : null,
    approvedByName: name(row.approvedById),
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    postedByName: name(row.postedById),
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    reversedByName: name(row.reversedById),
    reversedAt: row.reversedAt ? row.reversedAt.toISOString() : null,
    reversalReason: row.reversalReason ?? '',
    lines,
    totals: runTotals(lines.flatMap((line) => (line.result ? [line.result] : []))),
    journal: row.journalEntry ? postedJournal(row.journalEntry) : null,
    reversalJournal: row.reversalJournal ? postedJournal(row.reversalJournal) : null,
  };
}

// --- remittances ------------------------------------------------------------------------------

export type RemittanceRecord = {
  id: string;
  entityId: string;
  runId: string;
  period: string;
  kind: RemittanceKind;
  amountMinor: number;
  dueDate: string;
  paidOn: string | null;
  reference: string;
  bankAccountName: string;
  cancelled: boolean;
};

export const remittanceKindOf: Record<PayrollRemittance['kind'], RemittanceKind> = { PAYE: 'paye', SSNIT_TIER_1: 'ssnit-tier1', SSNIT_TIER_2: 'ssnit-tier2', TIER_3: 'tier3', NET_PAY: 'net-pay' };
export const remittanceKindToPrisma: Record<RemittanceKind, PayrollRemittance['kind']> = { paye: 'PAYE', 'ssnit-tier1': 'SSNIT_TIER_1', 'ssnit-tier2': 'SSNIT_TIER_2', tier3: 'TIER_3', 'net-pay': 'NET_PAY' };

export const remittanceInclude = { run: { select: { period: true } }, bankAccount: { select: { name: true } } } as const;

export function remittanceRecord(row: PayrollRemittance & { run: Pick<PayRun, 'period'>; bankAccount: { name: string } | null }): RemittanceRecord {
  return {
    id: row.id,
    entityId: row.entityId,
    runId: row.runId,
    period: row.run.period,
    kind: remittanceKindOf[row.kind],
    amountMinor: toMinor(row.amountMinor),
    dueDate: isoDate(row.dueDate),
    paidOn: row.paidOn ? isoDate(row.paidOn) : null,
    reference: row.reference ?? '',
    bankAccountName: row.bankAccount?.name ?? '',
    cancelled: row.cancelledAt !== null,
  };
}

// --- the facts the reports read ------------------------------------------------------------------

/** Every line of every posted run, as report facts, using the employee's details as they stand. */
export function payFactsOf(runs: PayRunRecord[], employees: EmployeeRecord[]): PayLineFact[] {
  const byId = new Map(employees.map((e) => [e.id, e]));
  return runs
    .filter((run) => run.status === 'posted')
    .flatMap((run) =>
      run.lines.flatMap((line) => {
        const person = byId.get(line.employeeId);
        if (!person || !line.result || !line.inputs) return [];
        return [
          factOf({
            entityId: run.entityId,
            runId: run.id,
            employee: { id: person.id, staffNumber: person.staffNumber, name: person.name, department: person.department || null, tin: person.tin || null, ssnitNumber: person.ssnitNumber || null, startDate: person.startDate, endDate: person.endDate },
            input: line.inputs.input,
            result: line.result,
            allocations: line.inputs.allocations.map((a) => ({ projectId: a.projectId, shareBasisPoints: a.shareBasisPoints })),
          }),
        ];
      }),
    );
}

/** Casual labour paid from agents' floats, for the labour report. */
export type CasualLabourFact = { entityId: string; date: string; amountMinor: number; workers: number | null; description: string };

/** The payroll control accounts the reconciliation reads, by code. */
export const controlAccountCodes = [payrollAccounts.netPay, payrollAccounts.paye, payrollAccounts.ssnitTier1, payrollAccounts.ssnitTier2, payrollAccounts.tier3, payrollAccounts.staffLoans] as const;

/**
 * Each control account's balance as the ledger stands, positive on its normal
 * side: credit for the liabilities, debit for staff loans.
 */
export async function ledgerBalances(scope: { entityId?: { in: string[] } }, entityIds: string[]): Promise<Record<string, Record<string, number>>> {
  const accounts = await prisma.account.findMany({ where: { ...scope, code: { in: [...controlAccountCodes] } }, select: { id: true, code: true, entityId: true } });
  const sums = accounts.length
    ? await prisma.journalLine.groupBy({ by: ['accountId', 'direction'], where: { accountId: { in: accounts.map((a) => a.id) } }, _sum: { amountMinor: true } })
    : [];
  const result: Record<string, Record<string, number>> = Object.fromEntries(entityIds.map((id) => [id, {}]));
  for (const account of accounts) {
    const debit = toMinor(sums.find((s) => s.accountId === account.id && s.direction === 'MONEY_IN')?._sum.amountMinor ?? 0n);
    const credit = toMinor(sums.find((s) => s.accountId === account.id && s.direction === 'MONEY_OUT')?._sum.amountMinor ?? 0n);
    (result[account.entityId] ??= {})[account.code] = account.code === payrollAccounts.staffLoans ? debit - credit : credit - debit;
  }
  return result;
}

// --- the loader ---------------------------------------------------------------------------------

export type PayrollData = {
  employeesByEntity: Record<string, EmployeeRecord[]>;
  payRunsByEntity: Record<string, PayRunRecord[]>;
  staffLoansByEntity: Record<string, StaffLoanRecord[]>;
  remittancesByEntity: Record<string, RemittanceRecord[]>;
  payFactsByEntity: Record<string, PayLineFact[]>;
  casualLabourByEntity: Record<string, CasualLabourFact[]>;
  payrollLedgerByEntity: Record<string, Record<string, number>>;
};

export function emptyPayrollData(entityIds: string[]): PayrollData {
  const none = <T>() => Object.fromEntries(entityIds.map((id) => [id, [] as T[]]));
  return {
    employeesByEntity: none(),
    payRunsByEntity: none(),
    staffLoansByEntity: none(),
    remittancesByEntity: none(),
    payFactsByEntity: none(),
    casualLabourByEntity: none(),
    payrollLedgerByEntity: Object.fromEntries(entityIds.map((id) => [id, {}])),
  };
}

/** Scoped by the principal's grant in every query. Nothing at all for someone without payroll:view. */
export async function loadPayrollData(scope: { entityId?: { in: string[] } }, entityIds: string[], canView: boolean): Promise<PayrollData> {
  if (!canView) return emptyPayrollData(entityIds);
  const [employees, runs, loans, remittances, labour, ledger] = await Promise.all([
    prisma.employee.findMany({ where: scope, include: employeeInclude, orderBy: { staffNumber: 'asc' } }),
    prisma.payRun.findMany({ where: scope, include: payRunInclude, orderBy: [{ period: 'desc' }, { sequence: 'desc' }], take: 120 }),
    prisma.staffLoan.findMany({ where: scope, include: loanInclude, orderBy: { issuedOn: 'desc' } }),
    prisma.payrollRemittance.findMany({ where: scope, include: remittanceInclude, orderBy: { dueDate: 'asc' } }),
    prisma.floatLabourPayment.findMany({ where: scope, orderBy: { date: 'desc' } }),
    ledgerBalances(scope, entityIds),
  ]);
  const userIds = [...new Set(runs.flatMap((r) => [r.approvedById, r.postedById, r.reversedById]).filter((id): id is string => Boolean(id)))];
  const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
  const userNames = Object.fromEntries(users.map((u) => [u.id, u.name]));

  const data = emptyPayrollData(entityIds);
  for (const row of employees) data.employeesByEntity[row.entityId]?.push(employeeRecord(row));
  for (const row of runs) data.payRunsByEntity[row.entityId]?.push(payRunRecord(row, userNames));
  for (const row of loans) data.staffLoansByEntity[row.entityId]?.push(staffLoanRecord(row));
  for (const row of remittances) data.remittancesByEntity[row.entityId]?.push(remittanceRecord(row));
  for (const row of labour) data.casualLabourByEntity[row.entityId]?.push({ entityId: row.entityId, date: isoDate(row.date), amountMinor: toMinor(row.amountMinor), workers: row.workers, description: row.description });
  for (const id of entityIds) data.payFactsByEntity[id] = payFactsOf(data.payRunsByEntity[id] ?? [], data.employeesByEntity[id] ?? []);
  data.payrollLedgerByEntity = ledger;
  return data;
}
