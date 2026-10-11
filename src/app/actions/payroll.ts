'use server';

/**
 * Server Functions for payroll: employees and their pay, project splits,
 * staff loans, the pay run from draft to posted, paying what it leaves owing,
 * payslips and the reports.
 *
 * A pay run is a period object with a status:
 *   draft     everything recalculable; bonus and overtime entered per line
 *   approved  figures locked — approval recalculates and refuses if anything
 *             has moved since, so what is approved is what was looked at
 *   posted    the journal is written, the remittances are due. Undone only by
 *             a reversal, itself recorded, after which the period can run again
 *
 * Same contract as every other actions module: authorize first through
 * src/lib/dal.ts, scope every query by entity, write each change with its
 * journal and audit event in one transaction.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess, requirePermission } from '@/lib/dal';
import { ensureAccounts } from '@/lib/data/chart.ts';
import { entityTypeOf } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import {
  employeeInclude,
  employeeRecord,
  employmentTypeOf,
  employmentTypeToPrisma,
  loanInclude,
  payFactsOf,
  payRunInclude,
  payRunRecord,
  remittanceKindOf,
  remittanceKindToPrisma,
  residencyToPrisma,
  staffLoanRecord,
  ledgerBalances,
  type StoredLineInputs,
} from '@/lib/data/payroll';
import { payslipPdf, tableWorkbook } from '@/lib/data/payroll-files';
import { payrollSettingRecord } from '@/lib/data/payroll-rates';
import { statutoryRateRecord } from '@/lib/data/payroll-rates';
import { periodOf } from '@/lib/documents';
import { sendEmail } from '@/lib/email';
import { payrollAccounts } from '@/lib/payroll-accounts';
import type { BenefitKind, EmploymentType, PayResult, Residency } from '@/lib/payroll-engine';
import { PayrollRefusal, RateBook, isDate } from '@/lib/payroll-rates';
import { entityReportTable, entityReports, groupReportTable, groupReports, reportLabels, type EntityReport, type GroupReport, type ReportTable } from '@/lib/payroll-report-tables';
import {
  allocationProblem,
  approvalProblems,
  calculateRun,
  isBalanced,
  loanIssueJournal,
  loanProblems,
  payDateFor,
  payRunJournal,
  remittanceLabels,
  remittancePaymentJournal,
  remittancesFor,
  runTotals,
  type CalculatedLine,
  type EmployeeForPay,
  type LoanForPay,
  type PayJournalLine,
} from '@/lib/payroll-run';
import { buildPayslip, payslipText, periodLabel } from '@/lib/payslip';
import { decryptField, encryptField } from '@/lib/pii-crypto';
import { prisma } from '@/lib/prisma';

import type { ActionResult } from './documents';

type Tx = Prisma.TransactionClient;

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

async function withEntityAccess<T>(entityId: string, permission: Permission, run: (principal: Principal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let principal: Principal;
  try {
    principal = await requireEntityAccess(entityId, permission);
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  try {
    return await run(principal);
  } catch (error) {
    if (error instanceof PayrollRefusal) return fail(error.message);
    throw error;
  }
}

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);
const cedis = (minor: number) => (minor / 100).toFixed(2);
const todayIso = () => new Date().toISOString().slice(0, 10);

async function audit(tx: Tx, entityId: string, principal: Principal, action: 'EDIT' | 'POST' | 'VOID', resourceType: string, resourceRef: string, summary: string, metadata?: Record<string, unknown>) {
  await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action, resourceType, resourceRef, summary, metadata }, tx);
}

async function requireOpenPeriod(tx: Tx, entityId: string, date: string) {
  const period = periodOf(date);
  if (await tx.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } })) {
    throw new PayrollRefusal(`Period ${period} has been filed. Date this in an open period.`);
  }
}

async function settingsOf(tx: Tx, entityId: string) {
  return payrollSettingRecord(entityId, await tx.payrollSetting.findUnique({ where: { entityId } }));
}

/**
 * Write a journal from payroll lines in the functional currency. Each line
 * carries its project, and the project's fund, so staff cost reaches the
 * project's budget against actual the same way a bill does.
 */
async function postJournal(tx: Tx, entityId: string, lines: PayJournalLine[], date: string, reference: string, description: string, principal: Principal): Promise<string> {
  if (!isBalanced(lines)) throw new Error('Payroll journal does not balance; refusing to post');
  const accounts = await tx.account.findMany({ where: { entityId, code: { in: [...new Set(lines.map((l) => l.accountCode))] } }, select: { id: true, code: true } });
  const idOf = new Map(accounts.map((a) => [a.code, a.id]));
  for (const line of lines) if (!idOf.has(line.accountCode)) throw new PayrollRefusal(`Account ${line.accountCode} is not in this entity's chart.`);
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const entry = await tx.journalEntry.create({
    data: {
      entityId,
      kind: 'MANUAL',
      reference,
      description,
      postedAt: day(date),
      postedById: principal.userId,
      lines: {
        create: lines.map((line) => ({
          entityId,
          accountId: idOf.get(line.accountCode)!,
          projectId: line.projectId,
          fundId: line.fundId,
          txnCurrency: entity.functionalCurrency,
          txnAmountMinor: fromMinor(line.amount),
          rate: new Prisma.Decimal(1),
          amountMinor: fromMinor(line.amount),
          direction: line.type === 'debit' ? ('MONEY_IN' as const) : ('MONEY_OUT' as const),
        })),
      },
    },
    select: { id: true },
  });
  return entry.id;
}

/** The payroll accounts every payroll journal needs, added to an older chart that lacks them. */
async function ensurePayrollAccounts(tx: Tx, entityId: string) {
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { type: true } });
  await ensureAccounts(tx, entityId, entityTypeOf(entity.type), Object.values(payrollAccounts));
}

// --- employees --------------------------------------------------------------------------------

/**
 * For an existing employee, a number left undefined is kept as held: the
 * screen only ever has them masked, so it sends one only when re-entered.
 * null clears it.
 */
export type EmployeeInput = {
  id?: string;
  staffNumber: string;
  name: string;
  email?: string | null;
  tin?: string | null;
  ssnitNumber?: string | null;
  startDate: string;
  endDate?: string | null;
  employmentType: EmploymentType;
  residency: Residency;
  department?: string | null;
  expenseAccountCode: string;
  payMethod: 'bank' | 'mobile-money';
  bankName?: string | null;
  bankAccountNumber?: string | null;
  momoNumber?: string | null;
  basicMinor: number;
  juniorStaffOvertime: boolean;
  tier3Minor: number;
  benefitsInKind: BenefitKind[];
  reliefs: { marriage: boolean; childrenInEducation: number; agedDependants: number; disability: boolean; oldAge: boolean };
};

const benefitKinds: BenefitKind[] = ['vehicle', 'vehicle-fuel', 'accommodation', 'accommodation-furnished'];
const trimmed = (value: string | null | undefined) => value?.trim() || null;

export async function saveEmployee(entityId: string, input: EmployeeInput) {
  return withEntityAccess(entityId, 'payroll:prepare', async (principal) => {
    const problems: string[] = [];
    if (!input.staffNumber.trim()) problems.push('Give the staff number.');
    if (!input.name.trim()) problems.push('Give the name.');
    if (!isDate(input.startDate)) problems.push('Give the start date.');
    if (input.endDate && (!isDate(input.endDate) || input.endDate < input.startDate)) problems.push('The end date has to be a date on or after the start.');
    if (!Number.isSafeInteger(input.basicMinor) || input.basicMinor <= 0) problems.push('Enter the monthly basic salary.');
    if (!Number.isSafeInteger(input.tier3Minor) || input.tier3Minor < 0) problems.push('Tier 3 is an amount, nil or more.');
    if (!(input.employmentType in employmentTypeToPrisma)) problems.push('Choose permanent, contract or casual.');
    if (!(input.residency in residencyToPrisma)) problems.push('Choose resident or non-resident.');
    if (input.benefitsInKind.some((kind) => !benefitKinds.includes(kind))) problems.push('That is not a benefit in kind the rates know.');
    if (input.benefitsInKind.includes('vehicle') && input.benefitsInKind.includes('vehicle-fuel')) problems.push('Choose a vehicle or a vehicle with fuel, not both.');
    if (input.benefitsInKind.includes('accommodation') && input.benefitsInKind.includes('accommodation-furnished')) problems.push('Choose accommodation or furnished accommodation, not both.');
    for (const count of [input.reliefs.childrenInEducation, input.reliefs.agedDependants]) if (!Number.isInteger(count) || count < 0) problems.push('Dependants are counted in whole numbers.');
    if (problems.length) return fail(problems.join(' '));

    return prisma.$transaction(async (tx: Tx) => {
      const held = input.id ? await tx.employee.findFirst({ where: { id: input.id, entityId } }) : null;
      if (input.id && !held) return fail('That employee is not on this entity.');
      const keeps = (value: string | null | undefined, current: string | null | undefined) => (value === undefined && held ? Boolean(current) : Boolean(trimmed(value)));
      if (input.payMethod === 'bank' && !keeps(input.bankAccountNumber, held?.payMethod === 'BANK' ? held.bankAccountNumber : null)) return fail('Give the bank account number pay goes to.');
      if (input.payMethod === 'mobile-money' && !keeps(input.momoNumber, held?.payMethod === 'MOBILE_MONEY' ? held.momoNumber : null)) return fail('Give the mobile money number pay goes to.');
      const account = await tx.account.findFirst({ where: { entityId, code: input.expenseAccountCode, isActive: true } });
      if (!account || (account.type !== 'EXPENSE' && account.type !== 'COST_OF_SALES')) return fail('Charge pay to an expense or direct-cost account.');
      const clash = await tx.employee.findFirst({ where: { entityId, staffNumber: input.staffNumber.trim(), ...(input.id ? { NOT: { id: input.id } } : {}) } });
      if (clash) return fail(`Staff number ${input.staffNumber.trim()} is already ${clash.name}'s.`);
      // undefined: keep what is held. Prisma leaves a field alone when it is undefined.
      const unlessKept = <T>(value: string | null | undefined, convert: (v: string | null) => T): T | undefined => (value === undefined && held ? undefined : convert(trimmed(value)));
      const data = {
        staffNumber: input.staffNumber.trim(),
        name: input.name.trim(),
        email: unlessKept(input.email, (v) => encryptField('Employee.email', v)),
        tin: unlessKept(input.tin, (v) => v),
        ssnitNumber: unlessKept(input.ssnitNumber, (v) => v),
        startDate: day(input.startDate),
        endDate: input.endDate ? day(input.endDate) : null,
        employmentType: employmentTypeToPrisma[input.employmentType],
        residency: residencyToPrisma[input.residency],
        department: trimmed(input.department),
        expenseAccountId: account.id,
        payMethod: input.payMethod === 'mobile-money' ? ('MOBILE_MONEY' as const) : ('BANK' as const),
        bankName: input.payMethod === 'bank' ? trimmed(input.bankName) : null,
        bankAccountNumber: input.payMethod === 'bank' ? unlessKept(input.bankAccountNumber, (v) => encryptField('Employee.bankAccountNumber', v)) : null,
        momoNumber: input.payMethod === 'mobile-money' ? unlessKept(input.momoNumber, (v) => encryptField('Employee.momoNumber', v)) : null,
        basicMinor: fromMinor(input.basicMinor),
        juniorStaffOvertime: input.juniorStaffOvertime,
        tier3Minor: fromMinor(input.tier3Minor),
        benefitsInKind: input.benefitsInKind,
        marriageRelief: input.reliefs.marriage,
        childrenInEducation: input.reliefs.childrenInEducation,
        agedDependants: input.reliefs.agedDependants,
        disabilityRelief: input.reliefs.disability,
        oldAgeRelief: input.reliefs.oldAge,
      };
      let id = input.id;
      if (id) {
        await tx.employee.update({ where: { id }, data });
      } else {
        id = (await tx.employee.create({ data: { entityId, ...data, email: data.email ?? null, tin: data.tin ?? null, ssnitNumber: data.ssnitNumber ?? null, bankAccountNumber: data.bankAccountNumber ?? null, momoNumber: data.momoNumber ?? null }, select: { id: true } })).id;
      }
      // Names and figures only: the contact numbers stay out of the trail.
      await audit(tx, entityId, principal, 'EDIT', 'employee', input.staffNumber.trim(), `${input.id ? 'Updated' : 'Added'} ${input.name.trim()} (${input.staffNumber.trim()}): basic ${cedis(input.basicMinor)} a month${input.endDate ? `, leaving ${input.endDate}` : ''}`);
      refresh();
      return { ok: true as const, value: employeeRecord(await tx.employee.findUniqueOrThrow({ where: { id }, include: employeeInclude })) };
    });
  });
}

export type AllowanceInput = { employeeId: string; id?: string; name: string; amountMinor: number; taxable: boolean; pensionable: boolean };

export async function saveAllowance(entityId: string, input: AllowanceInput) {
  return withEntityAccess(entityId, 'payroll:prepare', async (principal) => {
    if (!input.name.trim()) return fail('Name the allowance.');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) return fail('Enter the monthly amount.');
    return prisma.$transaction(async (tx: Tx) => {
      const employee = await tx.employee.findFirst({ where: { id: input.employeeId, entityId } });
      if (!employee) return fail('That employee is not on this entity.');
      const data = { name: input.name.trim(), amountMinor: fromMinor(input.amountMinor), taxable: input.taxable, pensionable: input.pensionable };
      if (input.id) {
        const existing = await tx.employeeAllowance.findFirst({ where: { id: input.id, entityId, employeeId: employee.id, endedAt: null } });
        if (!existing) return fail('That allowance is no longer on their pay.');
        await tx.employeeAllowance.update({ where: { id: existing.id }, data });
      } else {
        await tx.employeeAllowance.create({ data: { entityId, employeeId: employee.id, ...data } });
      }
      await audit(tx, entityId, principal, 'EDIT', 'employee', employee.staffNumber, `${employee.name}: ${data.name} ${cedis(input.amountMinor)} a month, ${input.taxable ? 'taxable' : 'not taxable'}, ${input.pensionable ? 'pensionable' : 'not pensionable'}`);
      refresh();
      return { ok: true as const, value: { ok: true as const } };
    });
  });
}

/** Take an allowance off someone's pay from now on. Kept, never deleted: past runs used it. */
export async function endAllowance(entityId: string, allowanceId: string) {
  return withEntityAccess(entityId, 'payroll:prepare', async (principal) => {
    return prisma.$transaction(async (tx: Tx) => {
      const allowance = await tx.employeeAllowance.findFirst({ where: { id: allowanceId, entityId, endedAt: null }, include: { employee: true } });
      if (!allowance) return fail('That allowance is no longer on their pay.');
      await tx.employeeAllowance.update({ where: { id: allowance.id }, data: { endedAt: new Date() } });
      await audit(tx, entityId, principal, 'EDIT', 'employee', allowance.employee.staffNumber, `${allowance.employee.name}: ${allowance.name} taken off their pay`);
      refresh();
      return { ok: true as const, value: { ok: true as const } };
    });
  });
}

/**
 * Split an employee's cost across projects. The shares add to 100%, or the
 * split is cleared. The old split is ended, not deleted; runs already posted
 * keep the split they were posted with.
 */
export async function setAllocations(entityId: string, employeeId: string, shares: { projectId: string; shareBasisPoints: number }[]) {
  return withEntityAccess(entityId, 'payroll:prepare', async (principal) => {
    const problem = allocationProblem(shares);
    if (problem) return fail(problem);
    if (new Set(shares.map((s) => s.projectId)).size !== shares.length) return fail('Each project once.');
    return prisma.$transaction(async (tx: Tx) => {
      const employee = await tx.employee.findFirst({ where: { id: employeeId, entityId } });
      if (!employee) return fail('That employee is not on this entity.');
      const projects = await tx.project.findMany({ where: { entityId, id: { in: shares.map((s) => s.projectId) }, closedAt: null } });
      if (projects.length !== shares.length) return fail('Choose open projects of this entity.');
      await tx.employeeAllocation.updateMany({ where: { entityId, employeeId, endedAt: null }, data: { endedAt: new Date() } });
      if (shares.length) await tx.employeeAllocation.createMany({ data: shares.map((s) => ({ entityId, employeeId, projectId: s.projectId, shareBasisPoints: s.shareBasisPoints })) });
      const names = new Map(projects.map((p) => [p.id, p.code]));
      await audit(tx, entityId, principal, 'EDIT', 'employee', employee.staffNumber, shares.length ? `${employee.name}'s cost split: ${shares.map((s) => `${names.get(s.projectId)} ${(s.shareBasisPoints / 100).toFixed(2)}%`).join(', ')}` : `${employee.name} no longer split across projects`);
      refresh();
      return { ok: true as const, value: { ok: true as const } };
    });
  });
}

// --- staff loans --------------------------------------------------------------------------------

export type StaffLoanInput = { employeeId: string; kind: 'loan' | 'advance'; description: string; principalMinor: number; instalmentMinor: number; issuedOn: string; firstPeriod: string; bankAccountId: string };

/** Lend to a member of staff: the money leaves the bank now and comes back an instalment at a time from pay. */
export async function issueStaffLoan(entityId: string, input: StaffLoanInput) {
  return withEntityAccess(entityId, 'payroll:post', async (principal) => {
    const problems = loanProblems(input);
    if (!isDate(input.issuedOn)) problems.push('Give the date the money was paid out.');
    if (!input.description.trim()) problems.push('Say what it is for.');
    if (problems.length) return fail(problems.join(' '));
    return prisma.$transaction(async (tx: Tx) => {
      await requireOpenPeriod(tx, entityId, input.issuedOn);
      const employee = await tx.employee.findFirst({ where: { id: input.employeeId, entityId } });
      if (!employee) return fail('That employee is not on this entity.');
      const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId, isActive: true }, include: { account: true } });
      if (!bank) return fail('Choose a bank account of this entity.');
      await ensurePayrollAccounts(tx, entityId);
      const journalId = await postJournal(tx, entityId, loanIssueJournal(input.principalMinor, bank.account.code), input.issuedOn, `LOAN ${employee.staffNumber}`, `${input.kind === 'advance' ? 'Salary advance' : 'Staff loan'} to ${employee.name}: ${input.description.trim()}`, principal);
      const loan = await tx.staffLoan.create({
        data: {
          entityId,
          employeeId: employee.id,
          kind: input.kind,
          description: input.description.trim(),
          principalMinor: fromMinor(input.principalMinor),
          instalmentMinor: fromMinor(input.instalmentMinor),
          issuedOn: day(input.issuedOn),
          firstPeriod: input.firstPeriod,
          bankAccountId: bank.id,
          journalEntryId: journalId,
          createdById: principal.userId,
        },
        include: loanInclude,
      });
      await audit(tx, entityId, principal, 'POST', 'staff-loan', loan.id, `${input.kind === 'advance' ? 'Advance' : 'Loan'} of ${cedis(input.principalMinor)} to ${employee.name}, ${cedis(input.instalmentMinor)} a month from ${input.firstPeriod}`, { journalEntryId: journalId });
      refresh();
      return { ok: true as const, value: staffLoanRecord(loan) };
    });
  });
}

// --- the pay run --------------------------------------------------------------------------------

/** Everything calculateRun needs for one entity and period, read inside the transaction. */
async function runInputs(tx: Tx, entityId: string, period: string, excludeRunId?: string) {
  const year = period.slice(0, 4);
  const [settings, employees, loans, rates, earlierLines] = await Promise.all([
    settingsOf(tx, entityId),
    tx.employee.findMany({
      where: { entityId },
      include: { expenseAccount: { select: { code: true } }, allowances: { where: { endedAt: null } }, allocations: { where: { endedAt: null }, include: { project: { select: { fundId: true } } } } },
    }),
    tx.staffLoan.findMany({ where: { entityId }, include: loanInclude }),
    tx.statutoryRate.findMany({ where: { withdrawnAt: null } }),
    // Bonus concession already used this calendar year, from posted runs before this period.
    tx.payRunLine.findMany({ where: { entityId, run: { status: 'POSTED', period: { gte: `${year}-01`, lt: period }, ...(excludeRunId ? { NOT: { id: excludeRunId } } : {}) } }, select: { employeeId: true, bonusConcessionMinor: true } }),
  ]);
  const forPay: EmployeeForPay[] = employees.map((e) => ({
    id: e.id,
    staffNumber: e.staffNumber,
    name: e.name,
    employmentType: employmentTypeOf[e.employmentType],
    residency: e.residency === 'NON_RESIDENT' ? 'non-resident' : 'resident',
    startDate: iso(e.startDate),
    endDate: e.endDate ? iso(e.endDate) : null,
    department: e.department,
    expenseAccountCode: e.expenseAccount.code,
    basicMinor: toMinor(e.basicMinor),
    juniorStaffOvertime: e.juniorStaffOvertime,
    tier3Minor: toMinor(e.tier3Minor),
    benefitsInKind: e.benefitsInKind as BenefitKind[],
    reliefs: { marriage: e.marriageRelief, childrenInEducation: e.childrenInEducation, agedDependants: e.agedDependants, disability: e.disabilityRelief, oldAge: e.oldAgeRelief },
    allowances: e.allowances.map((a) => ({ name: a.name, amountMinor: toMinor(a.amountMinor), taxable: a.taxable, pensionable: a.pensionable })),
    allocations: e.allocations.map((a) => ({ projectId: a.projectId, fundId: a.project.fundId, shareBasisPoints: a.shareBasisPoints })),
  }));
  const forLoans: LoanForPay[] = loans.map((row) => {
    const record = staffLoanRecord(row);
    return { id: record.id, employeeId: record.employeeId, description: record.description, instalmentMinor: record.instalmentMinor, firstPeriod: record.firstPeriod, outstandingMinor: record.outstandingMinor };
  });
  const bonusConcessionUsed: Record<string, number> = {};
  for (const line of earlierLines) bonusConcessionUsed[line.employeeId] = (bonusConcessionUsed[line.employeeId] ?? 0) + toMinor(line.bonusConcessionMinor);
  return { settings, employees: forPay, loans: forLoans, rates: rates.map(statutoryRateRecord), bonusConcessionUsed };
}

function lineColumns(line: CalculatedLine) {
  const r = line.result;
  const stored: StoredLineInputs | null = line.input ? { input: line.input, allocations: line.allocations, expenseAccountCode: line.expenseAccountCode, deductions: line.deductions } : null;
  const m = (value: number | undefined) => fromMinor(value ?? 0);
  return {
    error: line.error,
    inputsJson: stored ? JSON.stringify(stored) : null,
    resultJson: r ? JSON.stringify(r) : null,
    daysEmployed: r?.daysEmployed ?? 0,
    basicMinor: m(r?.basicMinor),
    allowancesMinor: m(r?.allowancesMinor),
    nonTaxableMinor: m(r?.nonTaxableAllowancesMinor),
    bonusMinor: m(r?.bonusMinor),
    overtimeMinor: m(r?.overtimeMinor),
    grossMinor: m(r?.grossMinor),
    ssnitBaseMinor: m(r?.ssnitBaseMinor),
    employeeSsnitMinor: m(r?.employeeSsnitMinor),
    tier3Minor: m(r?.tier3Minor),
    benefitsMinor: m(r?.benefitsInKindMinor),
    reliefsMinor: m(r?.reliefsMinor),
    chargeableMinor: m(r?.chargeableMinor),
    payeMinor: m(r?.payeMinor),
    bonusTaxMinor: m(r?.bonusTaxMinor),
    overtimeTaxMinor: m(r?.overtimeTaxMinor),
    bonusConcessionMinor: m(r?.bonusConcessionMinor),
    deductionsMinor: m(r?.deductionsMinor),
    netMinor: m(r?.netMinor),
    employerSsnitMinor: m(r?.employerSsnitMinor),
    employerTier2Minor: m(r?.employerTier2Minor),
  };
}

/**
 * Work the run out again from the employees, loans and rates as they stand,
 * keeping each line's bonus and overtime. Draft only. A line for someone no
 * longer employed in the period is removed — a draft line is a working
 * figure, not a record; nothing has reached the ledger.
 */
async function calculateInto(tx: Tx, entityId: string, runId: string, period: string) {
  const inputs = await runInputs(tx, entityId, period, runId);
  const existing = await tx.payRunLine.findMany({ where: { runId } });
  const variables = Object.fromEntries(existing.map((line) => [line.employeeId, { bonusMinor: toMinor(line.bonusInputMinor), overtimeMinor: toMinor(line.overtimeInputMinor) }]));
  const lines = calculateRun({ period, settings: inputs.settings, employees: inputs.employees, loans: inputs.loans, variables, bonusConcessionUsed: inputs.bonusConcessionUsed, rates: inputs.rates });
  const keep = new Set(lines.map((l) => l.employeeId));
  const stale = existing.filter((line) => !keep.has(line.employeeId)).map((line) => line.id);
  await tx.payRunDeduction.deleteMany({ where: { line: { runId } } });
  if (stale.length) await tx.payRunLine.deleteMany({ where: { id: { in: stale } } });
  for (const line of lines) {
    const columns = lineColumns(line);
    const saved = await tx.payRunLine.upsert({
      where: { runId_employeeId: { runId, employeeId: line.employeeId } },
      create: { entityId, runId, employeeId: line.employeeId, ...columns },
      update: columns,
      select: { id: true },
    });
    if (line.result && line.deductions.length) {
      await tx.payRunDeduction.createMany({ data: line.deductions.map((d) => ({ entityId, lineId: saved.id, loanId: d.loanId, name: d.name, amountMinor: fromMinor(d.amountMinor) })) });
    }
  }
  await tx.payRun.update({ where: { id: runId }, data: { calculatedAt: new Date() } });
  return lines;
}

async function runResult(tx: Tx, runId: string) {
  const row = await tx.payRun.findUniqueOrThrow({ where: { id: runId }, include: payRunInclude });
  return payRunRecord(row, {});
}

/** Open a pay run for a period and work everyone out. */
export async function createPayRun(entityId: string, period: string) {
  return withEntityAccess(entityId, 'payroll:prepare', async (principal) => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return fail('Choose the month.');
    return prisma.$transaction(
      async (tx: Tx) => {
        const settings = await settingsOf(tx, entityId);
        if (!settings.payrollEnabled) return fail('Payroll is switched off for this entity. Switch it on in the payroll settings first.');
        const runs = await tx.payRun.findMany({ where: { entityId, period }, orderBy: { sequence: 'desc' } });
        const live = runs.find((run) => run.status !== 'REVERSED');
        if (live) return fail(`${periodLabel(period)} already has a pay run (${live.status.toLowerCase()}).`);
        const run = await tx.payRun.create({ data: { entityId, period, sequence: (runs[0]?.sequence ?? 0) + 1, payDate: day(payDateFor(period, settings.payDay)), createdById: principal.userId } });
        const lines = await calculateInto(tx, entityId, run.id, period);
        await audit(tx, entityId, principal, 'EDIT', 'pay-run', run.id, `Opened the ${periodLabel(period)} pay run${run.sequence > 1 ? ` (run ${run.sequence}, after a reversal)` : ''}: ${lines.length} people`);
        refresh();
        return { ok: true as const, value: await runResult(tx, run.id) };
      },
      { timeout: 60_000 },
    );
  });
}

export async function recalculatePayRun(entityId: string, runId: string) {
  return withEntityAccess(entityId, 'payroll:prepare', async (principal) => {
    return prisma.$transaction(
      async (tx: Tx) => {
        const run = await tx.payRun.findFirst({ where: { id: runId, entityId } });
        if (!run) return fail('Pay run not found.');
        if (run.status !== 'DRAFT') return fail('Only a draft is recalculated. Send an approved run back to draft first.');
        const lines = await calculateInto(tx, entityId, run.id, run.period);
        await audit(tx, entityId, principal, 'EDIT', 'pay-run', run.id, `Recalculated the ${periodLabel(run.period)} pay run: ${lines.length} people`);
        refresh();
        return { ok: true as const, value: await runResult(tx, run.id) };
      },
      { timeout: 60_000 },
    );
  });
}

/** This period's bonus and overtime for one person, then the run worked out again. */
export async function setPayLineInputs(entityId: string, lineId: string, input: { bonusMinor: number; overtimeMinor: number }) {
  return withEntityAccess(entityId, 'payroll:prepare', async (principal) => {
    for (const value of [input.bonusMinor, input.overtimeMinor]) if (!Number.isSafeInteger(value) || value < 0) return fail('Bonus and overtime are amounts, nil or more.');
    return prisma.$transaction(
      async (tx: Tx) => {
        const line = await tx.payRunLine.findFirst({ where: { id: lineId, entityId }, include: { run: true, employee: true } });
        if (!line) return fail('That line is not on a pay run of this entity.');
        if (line.run.status !== 'DRAFT') return fail('The run is no longer a draft.');
        await tx.payRunLine.update({ where: { id: line.id }, data: { bonusInputMinor: fromMinor(input.bonusMinor), overtimeInputMinor: fromMinor(input.overtimeMinor) } });
        await calculateInto(tx, entityId, line.runId, line.run.period);
        await audit(tx, entityId, principal, 'EDIT', 'pay-run', line.runId, `${line.employee.name}, ${periodLabel(line.run.period)}: bonus ${cedis(input.bonusMinor)}, overtime ${cedis(input.overtimeMinor)}`);
        refresh();
        return { ok: true as const, value: await runResult(tx, line.runId) };
      },
      { timeout: 60_000 },
    );
  });
}

/** The figures a stored line holds, compared with a fresh calculation. */
function sameFigures(stored: { employeeId: string; resultJson: string | null; error: string | null }[], fresh: CalculatedLine[]): boolean {
  if (stored.length !== fresh.length) return false;
  const byEmployee = new Map(stored.map((line) => [line.employeeId, line]));
  return fresh.every((line) => {
    const was = byEmployee.get(line.employeeId);
    if (!was) return false;
    if ((was.error ?? null) !== (line.error ?? null)) return false;
    const before = was.resultJson ? (JSON.parse(was.resultJson) as PayResult) : null;
    return JSON.stringify(before?.working ?? null) === JSON.stringify(line.result?.working ?? null);
  });
}

/**
 * Lock the figures. Refused while anyone could not be calculated, while any
 * statutory figure used is still a placeholder, and if anything — an
 * employee, a loan, a rate — has changed since the run was last worked out,
 * so that what is approved is exactly what was looked at.
 */
export async function approvePayRun(entityId: string, runId: string) {
  return withEntityAccess(entityId, 'payroll:approve', async (principal) => {
    return prisma.$transaction(
      async (tx: Tx) => {
        const run = await tx.payRun.findFirst({ where: { id: runId, entityId }, include: { lines: true } });
        if (!run) return fail('Pay run not found.');
        if (run.status !== 'DRAFT') return fail(`The run is ${run.status.toLowerCase()}, not a draft.`);
        const inputs = await runInputs(tx, entityId, run.period, run.id);
        const variables = Object.fromEntries(run.lines.map((line) => [line.employeeId, { bonusMinor: toMinor(line.bonusInputMinor), overtimeMinor: toMinor(line.overtimeInputMinor) }]));
        const fresh = calculateRun({ period: run.period, settings: inputs.settings, employees: inputs.employees, loans: inputs.loans, variables, bonusConcessionUsed: inputs.bonusConcessionUsed, rates: inputs.rates });
        if (!sameFigures(run.lines, fresh)) return fail('Something has changed since this run was worked out — an employee, a loan or a rate. Recalculate it, check it, then approve.');
        const problems = approvalProblems(fresh);
        // The deadlines the remittances will be given must be in force and
        // checked too, or a run could be approved and then fail at posting,
        // or be given due dates nobody has verified.
        if (problems.length === 0) {
          const book = new RateBook(inputs.rates, run.period);
          try {
            remittancesFor(runTotals(fresh.map((l) => l.result!)), book, iso(run.payDate));
          } catch (error) {
            if (error instanceof PayrollRefusal) problems.push(error.message);
            else throw error;
          }
          const placeholders = book.used().filter((used) => used.isPlaceholder).map((used) => used.label);
          if (placeholders.length) problems.push(`These payment deadlines are still placeholders and must be checked and marked verified first: ${[...new Set(placeholders)].join(', ')}.`);
        }
        if (problems.length) return fail(problems.join(' '));
        await tx.payRun.update({ where: { id: run.id }, data: { status: 'APPROVED', approvedById: principal.userId, approvedAt: new Date() } });
        const totals = runTotals(fresh.map((l) => l.result!));
        await audit(tx, entityId, principal, 'EDIT', 'pay-run', run.id, `Approved the ${periodLabel(run.period)} pay run: ${totals.employees} people, gross ${cedis(totals.grossMinor)}, net ${cedis(totals.netMinor)}`, { totals });
        refresh();
        return { ok: true as const, value: await runResult(tx, run.id) };
      },
      { timeout: 60_000 },
    );
  });
}

/** Unlock an approved run that has not been posted, so it can be corrected. */
export async function reopenPayRun(entityId: string, runId: string) {
  return withEntityAccess(entityId, 'payroll:approve', async (principal) => {
    return prisma.$transaction(async (tx: Tx) => {
      const claimed = await tx.payRun.updateMany({ where: { id: runId, entityId, status: 'APPROVED' }, data: { status: 'DRAFT', approvedById: null, approvedAt: null } });
      if (claimed.count !== 1) return fail('Only an approved run that has not been posted can go back to draft.');
      const run = await tx.payRun.findUniqueOrThrow({ where: { id: runId } });
      await audit(tx, entityId, principal, 'EDIT', 'pay-run', runId, `Sent the ${periodLabel(run.period)} pay run back to draft`);
      refresh();
      return { ok: true as const, value: await runResult(tx, runId) };
    });
  });
}

/**
 * Post an approved run: one journal dated the pay date, built from the
 * approved figures (not recalculated), and a remittance for each amount it
 * leaves owing, due on the date the rules in force for the period give.
 */
export async function postPayRun(entityId: string, runId: string) {
  return withEntityAccess(entityId, 'payroll:post', async (principal) => {
    return prisma.$transaction(
      async (tx: Tx) => {
        const run = await tx.payRun.findFirst({ where: { id: runId, entityId }, include: { lines: { include: { employee: true } } } });
        if (!run) return fail('Pay run not found.');
        const claimed = await tx.payRun.updateMany({ where: { id: run.id, status: 'APPROVED' }, data: { status: 'POSTED', postedById: principal.userId, postedAt: new Date() } });
        if (claimed.count !== 1) return fail('Only an approved run is posted.');
        const payDate = iso(run.payDate);
        await requireOpenPeriod(tx, entityId, payDate);
        await ensurePayrollAccounts(tx, entityId);

        const lines = run.lines.map((line) => {
          const stored = JSON.parse(line.inputsJson!) as StoredLineInputs;
          return { expenseAccountCode: stored.expenseAccountCode, allocations: stored.allocations, result: JSON.parse(line.resultJson!) as PayResult };
        });
        const journal = payRunJournal(lines);
        const journalId = await postJournal(tx, entityId, journal, payDate, `PAY-${run.period}${run.sequence > 1 ? `/${run.sequence}` : ''}`, `Payroll for ${periodLabel(run.period)}`, principal);

        const totals = runTotals(lines.map((l) => l.result));
        const rates = (await tx.statutoryRate.findMany({ where: { withdrawnAt: null } })).map(statutoryRateRecord);
        const due = remittancesFor(totals, new RateBook(rates, run.period), payDate);
        if (due.length) await tx.payrollRemittance.createMany({ data: due.map((d) => ({ entityId, runId: run.id, kind: remittanceKindToPrisma[d.kind], amountMinor: fromMinor(d.amountMinor), dueDate: day(d.dueDate) })) });
        await tx.payRun.update({ where: { id: run.id }, data: { journalEntryId: journalId } });
        await audit(tx, entityId, principal, 'POST', 'pay-run', run.id, `Posted the ${periodLabel(run.period)} pay run: gross ${cedis(totals.grossMinor)}, PAYE ${cedis(totals.payeMinor)}, net ${cedis(totals.netMinor)}`, { journalEntryId: journalId, due });
        refresh();
        return { ok: true as const, value: await runResult(tx, run.id) };
      },
      { timeout: 60_000 },
    );
  });
}

/**
 * Undo a posted run with a reversing entry dated today, recorded beside the
 * original. Refused once anything it left owing has been paid — reverse that
 * at the bank first. What it left owing is cancelled, and the period can then
 * be run again.
 */
export async function reversePayRun(entityId: string, runId: string, reason: string) {
  return withEntityAccess(entityId, 'payroll:post', async (principal) => {
    if (!reason.trim()) return fail('Say why the run is being reversed. It is kept with the reversal.');
    const today = todayIso();
    return prisma.$transaction(
      async (tx: Tx) => {
        await requireOpenPeriod(tx, entityId, today);
        const run = await tx.payRun.findFirst({ where: { id: runId, entityId }, include: { journalEntry: { include: { lines: true } }, remittances: true } });
        if (!run) return fail('Pay run not found.');
        if (run.status !== 'POSTED' || !run.journalEntry) return fail('Only a posted run is reversed.');
        const paid = run.remittances.filter((r) => r.paidOn);
        if (paid.length) return fail(`Already paid from this run: ${paid.map((r) => remittanceLabels[remittanceKindOf[r.kind]]).join(', ')}. A run is reversed only before anything it left owing is paid.`);
        const claimed = await tx.payRun.updateMany({ where: { id: run.id, status: 'POSTED' }, data: { status: 'REVERSED', reversedById: principal.userId, reversedAt: new Date(), reversalReason: reason.trim() } });
        if (claimed.count !== 1) return fail('The run changed while you were looking at it. Reload.');
        const original = run.journalEntry;
        const reversal = await tx.journalEntry.create({
          data: {
            entityId,
            kind: 'REVERSAL',
            reference: original.reference,
            description: `Reversal of payroll for ${periodLabel(run.period)} — ${reason.trim()}`,
            postedAt: day(today),
            reversalOfId: original.id,
            postedById: principal.userId,
            lines: {
              create: original.lines.map((line) => ({
                entityId,
                accountId: line.accountId,
                fundId: line.fundId,
                projectId: line.projectId,
                contactId: line.contactId,
                grantId: line.grantId,
                budgetLineId: line.budgetLineId,
                txnCurrency: line.txnCurrency,
                txnAmountMinor: line.txnAmountMinor,
                rate: line.rate,
                amountMinor: line.amountMinor,
                direction: line.direction === 'MONEY_IN' ? 'MONEY_OUT' : 'MONEY_IN',
              })),
            },
          },
          select: { id: true },
        });
        await tx.payRun.update({ where: { id: run.id }, data: { reversalJournalEntryId: reversal.id } });
        await tx.payrollRemittance.updateMany({ where: { runId: run.id, paidOn: null }, data: { cancelledAt: new Date() } });
        await audit(tx, entityId, principal, 'VOID', 'pay-run', run.id, `Reversed the ${periodLabel(run.period)} pay run: ${reason.trim()}`, { reversalJournalEntryId: reversal.id });
        refresh();
        return { ok: true as const, value: await runResult(tx, run.id) };
      },
      { timeout: 60_000 },
    );
  });
}

// --- paying what payroll owes ---------------------------------------------------------------------

/** Mark a remittance paid: the money leaves the bank against the liability, on the date given. */
export async function payRemittance(entityId: string, remittanceId: string, input: { paidOn: string; reference: string; bankAccountId: string }) {
  return withEntityAccess(entityId, 'payroll:post', async (principal) => {
    if (!isDate(input.paidOn)) return fail('Give the date it was paid.');
    if (!input.reference.trim()) return fail('Give the payment reference — the GRA or SSNIT receipt, or the bank reference.');
    return prisma.$transaction(async (tx: Tx) => {
      await requireOpenPeriod(tx, entityId, input.paidOn);
      const remittance = await tx.payrollRemittance.findFirst({ where: { id: remittanceId, entityId }, include: { run: true } });
      if (!remittance) return fail('That is not owed by this entity.');
      if (remittance.cancelledAt) return fail('Its pay run was reversed, so it is no longer owed.');
      const bank = await tx.bankAccount.findFirst({ where: { id: input.bankAccountId, entityId, isActive: true }, include: { account: true } });
      if (!bank) return fail('Choose a bank account of this entity.');
      const claimed = await tx.payrollRemittance.updateMany({ where: { id: remittance.id, paidOn: null }, data: { paidOn: day(input.paidOn), reference: input.reference.trim(), bankAccountId: bank.id, paidById: principal.userId } });
      if (claimed.count !== 1) return fail('That has already been paid.');
      const kind = remittanceKindOf[remittance.kind];
      const amount = toMinor(remittance.amountMinor);
      const journalId = await postJournal(tx, entityId, remittancePaymentJournal(kind, amount, bank.account.code), input.paidOn, input.reference.trim(), `${remittanceLabels[kind]} for ${periodLabel(remittance.run.period)}`, principal);
      await tx.payrollRemittance.update({ where: { id: remittance.id }, data: { journalEntryId: journalId } });
      await audit(tx, entityId, principal, 'POST', 'payroll-remittance', remittance.id, `Paid ${remittanceLabels[kind]} for ${periodLabel(remittance.run.period)}: ${cedis(amount)} from ${bank.name}, ref ${input.reference.trim()}${input.paidOn > iso(remittance.dueDate) ? ` — ${input.paidOn}, after the due date ${iso(remittance.dueDate)}` : ''}`, { journalEntryId: journalId });
      refresh();
      return { ok: true as const, value: { ok: true as const } };
    });
  });
}

// --- payslips -----------------------------------------------------------------------------------

async function payslipFor(entityId: string, lineId: string) {
  const line = await prisma.payRunLine.findFirst({ where: { id: lineId, entityId }, include: { run: true, employee: { include: { loans: { include: loanInclude } } }, entity: { select: { name: true } } } });
  if (!line || !line.resultJson || !line.inputsJson) return null;
  const result = JSON.parse(line.resultJson) as PayResult;
  const stored = JSON.parse(line.inputsJson) as StoredLineInputs;
  const posted = line.run.status === 'POSTED';
  const earlier = await prisma.payRunLine.findMany({
    where: { entityId, employeeId: line.employeeId, run: { status: 'POSTED', period: { gte: `${line.run.period.slice(0, 4)}-01`, lt: line.run.period } } },
    select: { grossMinor: true, employeeSsnitMinor: true, tier3Minor: true, payeMinor: true, netMinor: true },
  });
  const loans = line.employee.loans.map((loan) => {
    const record = staffLoanRecord(loan);
    // What was owed before this run: a posted run's own instalment is already counted as repaid.
    const own = posted ? loan.repayments.filter((r) => r.lineId === line.id).reduce((s, r) => s + toMinor(r.amountMinor), 0) : 0;
    return { id: record.id, description: record.description, outstandingBeforeMinor: record.outstandingMinor + own };
  });
  const slip = buildPayslip({
    entityName: line.entity.name,
    period: line.run.period,
    payDate: iso(line.run.payDate),
    posted,
    employee: { name: line.employee.name, staffNumber: line.employee.staffNumber, department: line.employee.department ?? '', tin: line.employee.tin ?? '', ssnitNumber: line.employee.ssnitNumber ?? '' },
    result,
    deductions: stored.deductions,
    loans,
    earlierThisYear: earlier.map((e) => ({ grossMinor: toMinor(e.grossMinor), employeeSsnitMinor: toMinor(e.employeeSsnitMinor), tier3Minor: toMinor(e.tier3Minor), payeMinor: toMinor(e.payeMinor), netMinor: toMinor(e.netMinor) })),
  });
  return { slip, line };
}

/** One payslip as a PDF. */
export async function downloadPayslip(entityId: string, lineId: string): Promise<ActionResult<{ fileName: string; base64: string }>> {
  return withEntityAccess(entityId, 'payroll:view', async () => {
    const found = await payslipFor(entityId, lineId);
    if (!found) return fail('That payslip is not available — the line could not be calculated.');
    const pdf = await payslipPdf(found.slip);
    return { ok: true, value: { fileName: `payslip-${found.slip.employee.staffNumber}-${found.slip.period}.pdf`, base64: pdf.toString('base64') } };
  });
}

/** Email a payslip to the employee, the PDF attached. Only once the run is posted: nobody is sent figures that may change. */
export async function emailPayslip(entityId: string, lineId: string): Promise<ActionResult<{ to: string }>> {
  return withEntityAccess(entityId, 'payroll:prepare', async (principal) => {
    const found = await payslipFor(entityId, lineId);
    if (!found) return fail('That payslip is not available — the line could not be calculated.');
    if (found.slip.provisional) return fail('Payslips are emailed once the run is posted.');
    const to = decryptField('Employee.email', found.line.employee.email);
    if (!to) return fail(`No email address is held for ${found.slip.employee.name}.`);
    const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { emailFrom: true } });
    const pdf = await payslipPdf(found.slip);
    await sendEmail({
      to,
      from: entity.emailFrom,
      subject: `Your payslip for ${periodLabel(found.slip.period)} — ${found.slip.entityName}`,
      text: payslipText(found.slip),
      attachments: [{ filename: `payslip-${found.slip.period}.pdf`, content: pdf.toString('base64') }],
    });
    await prisma.$transaction((tx) => audit(tx, entityId, principal, 'EDIT', 'payslip', found.line.id, `Emailed ${found.slip.employee.name}'s payslip for ${periodLabel(found.slip.period)}`));
    return { ok: true, value: { to: to.replace(/^(.).*(@.*)$/, '$1•••$2') } };
  });
}

// --- reports --------------------------------------------------------------------------------------

/** One entity's posted pay as report facts, the numbers unmasked — for the files, not the screen. */
async function entityReportInput(entityId: string, period: string) {
  const [entity, employees, runs, remittances, loans, projects, ledger] = await Promise.all([
    prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { name: true } }),
    prisma.employee.findMany({ where: { entityId }, include: employeeInclude }),
    prisma.payRun.findMany({ where: { entityId, status: 'POSTED' }, include: payRunInclude }),
    prisma.payrollRemittance.findMany({ where: { entityId, paidOn: null, cancelledAt: null } }),
    prisma.staffLoan.findMany({ where: { entityId }, include: loanInclude }),
    prisma.project.findMany({ where: { entityId }, select: { id: true, code: true, name: true } }),
    ledgerBalances({ entityId: { in: [entityId] } }, [entityId]),
  ]);
  const facts = payFactsOf(runs.map((run) => payRunRecord(run, {})), employees.map(employeeRecord));
  return {
    entityName: entity.name,
    period,
    facts,
    projectNames: Object.fromEntries(projects.map((p) => [p.id, `${p.code} · ${p.name}`])),
    openRemittances: remittances.map((r) => ({ kind: remittanceKindOf[r.kind], amountMinor: toMinor(r.amountMinor) })),
    ledgerBalances: ledger[entityId] ?? {},
    loansOutstandingMinor: loans.map(staffLoanRecord).reduce((sum, loan) => sum + loan.outstandingMinor, 0),
  };
}

async function workbookOf(table: ReportTable, sheetName: string) {
  return tableWorkbook({ sheetName, title: table.title, notes: [...table.notes, ...table.warnings], columns: table.columns, rows: table.rows, totals: table.totals });
}

/** One entity's report for a period, as Excel. Recorded, because the schedules carry TINs and SSNIT numbers in full. */
export async function exportPayrollReport(entityId: string, report: EntityReport, period: string): Promise<ActionResult<{ fileName: string; base64: string }>> {
  return withEntityAccess(entityId, 'payroll:view', async (principal) => {
    if (!(entityReports as readonly string[]).includes(report)) return fail('That is not a payroll report.');
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return fail('Choose the month.');
    const table = entityReportTable(report, await entityReportInput(entityId, period));
    const buffer = await workbookOf(table, reportLabels[report]);
    await prisma.$transaction((tx) => audit(tx, entityId, principal, 'EDIT', 'payroll-report', `${report}:${period}`, `Exported the ${reportLabels[report]} for ${periodLabel(period)}`));
    return { ok: true, value: { fileName: `${report}-${entityId}-${period}.xlsx`, base64: buffer.toString('base64') } };
  });
}

/** A report across every company the person may see, for a span of months, as Excel. */
export async function exportGroupPayrollReport(report: GroupReport, from: string, to: string): Promise<ActionResult<{ fileName: string; base64: string }>> {
  let principal: Principal;
  try {
    principal = await requirePermission('payroll:view');
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  if (!(groupReports as readonly string[]).includes(report)) return fail('That is not a payroll report.');
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to) || from > to) return fail('Choose the months, the first no later than the last.');
  const scope = principal.entityIds === 'all' ? {} : { entityId: { in: [...principal.entityIds] } };
  const entities = await prisma.entity.findMany({ where: principal.entityIds === 'all' ? {} : { id: { in: [...principal.entityIds] } }, select: { id: true, name: true } });
  const [employees, runs, casual] = await Promise.all([
    prisma.employee.findMany({ where: scope, include: employeeInclude }),
    prisma.payRun.findMany({ where: { ...scope, status: 'POSTED', period: { gte: from, lte: to } }, include: payRunInclude }),
    prisma.floatLabourPayment.findMany({ where: { ...scope, date: { gte: day(`${from}-01`) } } }),
  ]);
  const table = groupReportTable(report, {
    from,
    to,
    entityNames: Object.fromEntries(entities.map((e) => [e.id, e.name])),
    facts: payFactsOf(runs.map((run) => payRunRecord(run, {})), employees.map(employeeRecord)),
    casual: casual.map((c) => ({ entityId: c.entityId, date: iso(c.date), amountMinor: toMinor(c.amountMinor), workers: c.workers })),
  });
  const buffer = await workbookOf(table, reportLabels[report]);
  return { ok: true, value: { fileName: `${report}-${from}-to-${to}.xlsx`, base64: buffer.toString('base64') } };
}
