/**
 * A pay run: one entity, one period. Everyone employed in the period is
 * worked through calculatePay, and the results become one journal and the
 * amounts the run leaves owing — to GRA, to SSNIT, to the tier 2 trustee and
 * the tier 3 provider, and to the staff themselves.
 *
 * The journal:
 *   money out of the company (debits)
 *     gross pay to each employee's expense account, split by project where
 *       they are allocated
 *     employer SSNIT and tier 2 to the employer contributions account, split
 *       the same way, so a project carries the whole cost of its people
 *   money owed (credits)
 *     PAYE, employee SSNIT, employer SSNIT (tier 1), tier 2, tier 3 and net
 *       pay, each its own liability line; loan instalments back to staff loans
 *
 * It balances by construction — gross = net + SSNIT + tier 3 + PAYE +
 * deductions, which calculatePay guarantees — and payRunJournal checks it
 * anyway before anything is posted.
 *
 * Pure: no I/O, no Prisma, no clock.
 */

import { calculatePay, type BenefitKind, type EmploymentType, type EntityPayrollSettings, type PayInput, type PayResult, type ReliefKind, type Residency } from './payroll-engine';
import { payrollAccounts } from './payroll-accounts';
import { lastDayOf, PayrollRefusal, RateBook, type StatutoryRateRow } from './payroll-rates';

// --- who is paid --------------------------------------------------------------------------------

export type EmployeeForPay = {
  id: string;
  staffNumber: string;
  name: string;
  employmentType: EmploymentType;
  residency: Residency;
  startDate: string;
  endDate: string | null;
  department: string | null;
  expenseAccountCode: string;
  basicMinor: number;
  juniorStaffOvertime: boolean;
  tier3Minor: number;
  benefitsInKind: BenefitKind[];
  reliefs: { marriage: boolean; childrenInEducation: number; agedDependants: number; disability: boolean; oldAge: boolean };
  /** The live allowances. */
  allowances: { name: string; amountMinor: number; taxable: boolean; pensionable: boolean }[];
  /** The live project split; empty for none. */
  allocations: { projectId: string; fundId: string | null; shareBasisPoints: number }[];
};

export type LoanForPay = {
  id: string;
  employeeId: string;
  description: string;
  instalmentMinor: number;
  firstPeriod: string;
  /** Principal less instalments on posted, unreversed runs. */
  outstandingMinor: number;
};

/** Employed on at least one day of the period. */
export function employedIn(employee: { startDate: string; endDate: string | null }, period: string): boolean {
  return employee.startDate <= lastDayOf(period) && (employee.endDate === null || employee.endDate >= `${period}-01`);
}

/** What each loan takes this period: its instalment, or what is left if that is less. */
export function loanInstalments(loans: LoanForPay[], employeeId: string, period: string): { loanId: string; name: string; amountMinor: number }[] {
  return loans
    .filter((loan) => loan.employeeId === employeeId && loan.firstPeriod <= period && loan.outstandingMinor > 0)
    .map((loan) => ({ loanId: loan.id, name: loan.description, amountMinor: Math.min(loan.instalmentMinor, loan.outstandingMinor) }));
}

export function reliefsOf(employee: EmployeeForPay): { kind: ReliefKind; count?: number }[] {
  const reliefs: { kind: ReliefKind; count?: number }[] = [];
  if (employee.reliefs.marriage) reliefs.push({ kind: 'marriage' });
  if (employee.reliefs.childrenInEducation > 0) reliefs.push({ kind: 'child-education', count: employee.reliefs.childrenInEducation });
  if (employee.reliefs.agedDependants > 0) reliefs.push({ kind: 'aged-dependant', count: employee.reliefs.agedDependants });
  if (employee.reliefs.disability) reliefs.push({ kind: 'disability' });
  if (employee.reliefs.oldAge) reliefs.push({ kind: 'old-age' });
  return reliefs;
}

/** The project split must cover all of a person's cost, or none of it. */
export function allocationProblem(shares: { shareBasisPoints: number }[]): string | null {
  if (shares.length === 0) return null;
  if (shares.some((share) => !Number.isInteger(share.shareBasisPoints) || share.shareBasisPoints <= 0)) return 'Each share is more than 0%, to two decimal places.';
  const total = shares.reduce((sum, share) => sum + share.shareBasisPoints, 0);
  return total === 10000 ? null : `The shares add up to ${(total / 100).toFixed(2).replace(/\.?0+$/, '')}%. They must add up to 100%.`;
}

// --- the run ------------------------------------------------------------------------------------

export type RunVariables = Record<string, { bonusMinor: number; overtimeMinor: number }>;

export type CalculatedLine = {
  employeeId: string;
  input: PayInput | null;
  deductions: { loanId: string | null; name: string; amountMinor: number }[];
  allocations: EmployeeForPay['allocations'];
  expenseAccountCode: string;
  result: PayResult | null;
  /** Why this person could not be paid; blocks approval. */
  error: string | null;
};

/**
 * Everyone employed in the period, worked out against the rates in force for
 * it. A person who cannot be calculated — a casual worker, a missing rate —
 * is kept with the reason, rather than leaving them silently unpaid.
 */
export function calculateRun(args: {
  period: string;
  settings: EntityPayrollSettings;
  employees: EmployeeForPay[];
  loans: LoanForPay[];
  variables: RunVariables;
  /** This calendar year's bonus concession already used, per employee, by earlier posted runs. */
  bonusConcessionUsed: Record<string, number>;
  rates: readonly StatutoryRateRow[];
}): CalculatedLine[] {
  return args.employees
    .filter((employee) => employedIn(employee, args.period))
    .sort((a, b) => a.staffNumber.localeCompare(b.staffNumber))
    .map((employee) => {
      const deductions = loanInstalments(args.loans, employee.id, args.period);
      const variable = args.variables[employee.id] ?? { bonusMinor: 0, overtimeMinor: 0 };
      const input: PayInput = {
        period: args.period,
        settings: args.settings,
        employee: {
          name: employee.name,
          employmentType: employee.employmentType,
          residency: employee.residency,
          startDate: employee.startDate,
          endDate: employee.endDate,
          juniorStaffOvertime: employee.juniorStaffOvertime,
        },
        basicMinor: employee.basicMinor,
        allowances: employee.allowances,
        bonusMinor: variable.bonusMinor,
        bonusConcessionUsedMinor: args.bonusConcessionUsed[employee.id] ?? 0,
        overtimeMinor: variable.overtimeMinor,
        tier3Minor: args.settings.tier3Offered ? employee.tier3Minor : 0,
        reliefs: reliefsOf(employee),
        benefitsInKind: employee.benefitsInKind,
        deductions: deductions.map((d) => ({ name: d.name, amountMinor: d.amountMinor })),
      };
      const base = { employeeId: employee.id, input, deductions, allocations: employee.allocations, expenseAccountCode: employee.expenseAccountCode };
      const split = allocationProblem(employee.allocations);
      if (split) return { ...base, result: null, error: `${employee.name}: the project split is wrong. ${split}` };
      try {
        return { ...base, result: calculatePay(input, new RateBook(args.rates, args.period)), error: null };
      } catch (error) {
        if (error instanceof PayrollRefusal) return { ...base, result: null, error: error.message };
        throw error;
      }
    });
}

export type RunTotals = {
  employees: number;
  grossMinor: number;
  payeMinor: number;
  employeeSsnitMinor: number;
  employerSsnitMinor: number;
  employerTier2Minor: number;
  tier3Minor: number;
  deductionsMinor: number;
  netMinor: number;
  employerCostMinor: number;
};

export function runTotals(results: PayResult[]): RunTotals {
  const totals: RunTotals = { employees: results.length, grossMinor: 0, payeMinor: 0, employeeSsnitMinor: 0, employerSsnitMinor: 0, employerTier2Minor: 0, tier3Minor: 0, deductionsMinor: 0, netMinor: 0, employerCostMinor: 0 };
  for (const r of results) {
    totals.grossMinor += r.grossMinor;
    totals.payeMinor += r.payeMinor;
    totals.employeeSsnitMinor += r.employeeSsnitMinor;
    totals.employerSsnitMinor += r.employerSsnitMinor;
    totals.employerTier2Minor += r.employerTier2Minor;
    totals.tier3Minor += r.tier3Minor;
    totals.deductionsMinor += r.deductionsMinor;
    totals.netMinor += r.netMinor;
    totals.employerCostMinor += r.employerCostMinor;
  }
  return totals;
}

/**
 * Why a run cannot be approved yet, in plain words. Nothing to pay, anyone
 * who could not be calculated, and any figure that is still a placeholder.
 */
export function approvalProblems(lines: { error: string | null; result: PayResult | null }[]): string[] {
  const problems: string[] = [];
  if (lines.length === 0) problems.push('Nobody is on this run.');
  for (const line of lines) if (line.error) problems.push(line.error);
  const placeholders = new Set(lines.flatMap((line) => line.result?.ratesUsed.filter((used) => used.isPlaceholder).map((used) => used.label) ?? []));
  if (placeholders.size) {
    problems.push(`These statutory figures are still placeholders and must be checked and marked verified first: ${[...placeholders].join(', ')}.`);
  }
  return problems;
}

// --- the journal --------------------------------------------------------------------------------

export type PayJournalLine = {
  accountCode: string;
  projectId: string | null;
  fundId: string | null;
  amount: number;
  type: 'debit' | 'credit';
  /** What this line is, for the preview: "Gross pay", "Employee SSNIT". */
  memo: string;
};

/**
 * Split an amount by shares in hundredths of a percent that add up to 10000.
 * Every part is a whole pesewa and the parts add back to the whole: the
 * leftover pesewas go to the largest remainders.
 */
export function splitByShares<K extends string>(amountMinor: number, shares: { key: K; shareBasisPoints: number }[]): { key: K; amountMinor: number }[] {
  const exact = shares.map((share) => ({ key: share.key, numerator: amountMinor * share.shareBasisPoints }));
  const parts = exact.map((part) => ({ key: part.key, amountMinor: Math.floor(part.numerator / 10000), remainder: part.numerator % 10000 }));
  let left = amountMinor - parts.reduce((sum, part) => sum + part.amountMinor, 0);
  const byRemainder = [...parts].sort((a, b) => b.remainder - a.remainder);
  for (const part of byRemainder) {
    if (left <= 0) break;
    part.amountMinor += 1;
    left -= 1;
  }
  return parts.map(({ key, amountMinor: amount }) => ({ key, amountMinor: amount }));
}

/** A cost charged to the projects a person is split across, or uncoded if they are not. */
function costLines(accountCode: string, amountMinor: number, allocations: EmployeeForPay['allocations'], memo: string): PayJournalLine[] {
  if (amountMinor === 0) return [];
  if (allocations.length === 0) return [{ accountCode, projectId: null, fundId: null, amount: amountMinor, type: 'debit', memo }];
  const fundOf = new Map(allocations.map((a) => [a.projectId, a.fundId]));
  return splitByShares(amountMinor, allocations.map((a) => ({ key: a.projectId, shareBasisPoints: a.shareBasisPoints })))
    .filter((part) => part.amountMinor > 0)
    .map((part) => ({ accountCode, projectId: part.key, fundId: fundOf.get(part.key) ?? null, amount: part.amountMinor, type: 'debit' as const, memo }));
}

export function isBalanced(lines: { amount: number; type: 'debit' | 'credit' }[]): boolean {
  const debits = lines.filter((l) => l.type === 'debit').reduce((sum, l) => sum + l.amount, 0);
  const credits = lines.filter((l) => l.type === 'credit').reduce((sum, l) => sum + l.amount, 0);
  return debits === credits;
}

/** The run's journal, lines with the same account, project and memo added together. Throws if it does not balance. */
export function payRunJournal(lines: { expenseAccountCode: string; allocations: EmployeeForPay['allocations']; result: PayResult }[]): PayJournalLine[] {
  const raw: PayJournalLine[] = [];
  for (const line of lines) {
    raw.push(...costLines(line.expenseAccountCode, line.result.grossMinor, line.allocations, 'Gross pay'));
    raw.push(...costLines(payrollAccounts.employerContributions, line.result.employerSsnitMinor + line.result.employerTier2Minor, line.allocations, 'Employer SSNIT and tier 2'));
  }
  const totals = runTotals(lines.map((line) => line.result));
  const credit = (accountCode: string, amount: number, memo: string): PayJournalLine => ({ accountCode, projectId: null, fundId: null, amount, type: 'credit', memo });
  raw.push(
    credit(payrollAccounts.paye, totals.payeMinor, 'PAYE'),
    credit(payrollAccounts.ssnitTier1, totals.employeeSsnitMinor, 'Employee SSNIT (tier 1)'),
    credit(payrollAccounts.ssnitTier1, totals.employerSsnitMinor, 'Employer SSNIT (tier 1)'),
    credit(payrollAccounts.ssnitTier2, totals.employerTier2Minor, 'Tier 2'),
    credit(payrollAccounts.tier3, totals.tier3Minor, 'Tier 3'),
    credit(payrollAccounts.staffLoans, totals.deductionsMinor, 'Loan and advance instalments'),
    credit(payrollAccounts.netPay, totals.netMinor, 'Net pay'),
  );

  const merged = new Map<string, PayJournalLine>();
  for (const line of raw) {
    if (line.amount === 0) continue;
    const key = [line.accountCode, line.projectId ?? '', line.type, line.memo].join('|');
    const existing = merged.get(key);
    if (existing) existing.amount += line.amount;
    else merged.set(key, { ...line });
  }
  const journal = [...merged.values()];
  if (!isBalanced(journal)) throw new Error('The pay run journal does not balance; refusing to post it');
  return journal;
}

// --- what is owed, and when ---------------------------------------------------------------------

export type RemittanceKind = 'paye' | 'ssnit-tier1' | 'ssnit-tier2' | 'tier3' | 'net-pay';

export const remittanceLabels: Record<RemittanceKind, string> = {
  paye: 'PAYE to GRA',
  'ssnit-tier1': 'SSNIT tier 1',
  'ssnit-tier2': 'Tier 2 to the trustee',
  tier3: 'Tier 3 to the provider',
  'net-pay': 'Net pay to staff',
};

export const remittanceAccounts: Record<RemittanceKind, string> = {
  paye: payrollAccounts.paye,
  'ssnit-tier1': payrollAccounts.ssnitTier1,
  'ssnit-tier2': payrollAccounts.ssnitTier2,
  tier3: payrollAccounts.tier3,
  'net-pay': payrollAccounts.netPay,
};

const deadlineKeys: Record<Exclude<RemittanceKind, 'net-pay'>, string> = {
  paye: 'deadline.paye',
  'ssnit-tier1': 'deadline.ssnit-tier1',
  'ssnit-tier2': 'deadline.ssnit-tier2',
  tier3: 'deadline.tier3',
};

const iso = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The day of the month after the period, clamped to that month's length, moved off a weekend if the rule says so. */
export function dueDateFor(period: string, rule: { dayOfMonth: number; weekend: string }): string {
  const [year, month] = period.split('-').map(Number);
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  const daysInNext = new Date(Date.UTC(next.y, next.m, 0)).getUTCDate();
  let time = Date.UTC(next.y, next.m - 1, Math.min(rule.dayOfMonth, daysInNext));
  const step = rule.weekend === 'next-working-day' ? 1 : rule.weekend === 'previous-working-day' ? -1 : 0;
  while (step !== 0 && [0, 6].includes(new Date(time).getUTCDay())) time += step * 86_400_000;
  return iso(time);
}

/** The pay day in the period: the entity's day, or the month's last day when the month is shorter. */
export function payDateFor(period: string, payDay: number): string {
  const last = lastDayOf(period);
  return Number(last.slice(8)) < payDay ? last : `${period}-${String(payDay).padStart(2, '0')}`;
}

export type RemittanceDue = { kind: RemittanceKind; amountMinor: number; dueDate: string };

/**
 * What a posted run leaves owing and the date each falls due, from the
 * deadline rules in force for the period. Net pay is due on the pay date.
 * Nothing owed, nothing listed.
 */
export function remittancesFor(totals: RunTotals, rates: RateBook, payDate: string): RemittanceDue[] {
  const amounts: Record<RemittanceKind, number> = {
    paye: totals.payeMinor,
    'ssnit-tier1': totals.employeeSsnitMinor + totals.employerSsnitMinor,
    'ssnit-tier2': totals.employerTier2Minor,
    tier3: totals.tier3Minor,
    'net-pay': totals.netMinor,
  };
  return (Object.keys(amounts) as RemittanceKind[])
    .filter((kind) => amounts[kind] > 0)
    .map((kind) => ({
      kind,
      amountMinor: amounts[kind],
      dueDate: kind === 'net-pay' ? payDate : dueDateFor(rates.period, rates.deadline(deadlineKeys[kind])),
    }));
}

/** Paying what payroll owes: the liability goes, the bank pays it. */
export function remittancePaymentJournal(kind: RemittanceKind, amountMinor: number, bankCode: string): PayJournalLine[] {
  return [
    { accountCode: remittanceAccounts[kind], projectId: null, fundId: null, amount: amountMinor, type: 'debit', memo: remittanceLabels[kind] },
    { accountCode: bankCode, projectId: null, fundId: null, amount: amountMinor, type: 'credit', memo: 'Paid from the bank' },
  ];
}

export type RemittanceRow = { id: string; period: string; kind: RemittanceKind; amountMinor: number; dueDate: string; paidOn: string | null; cancelled: boolean };

/** Everything still owed, what is past its date, and what falls due next. */
export function remittancePosition(rows: RemittanceRow[], today: string) {
  const open = rows.filter((row) => !row.paidOn && !row.cancelled).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const overdue = open.filter((row) => row.dueDate < today);
  return {
    open,
    overdue,
    outstandingMinor: open.reduce((sum, row) => sum + row.amountMinor, 0),
    overdueMinor: overdue.reduce((sum, row) => sum + row.amountMinor, 0),
    next: open.find((row) => row.dueDate >= today) ?? null,
  };
}

// --- loans --------------------------------------------------------------------------------------

/** A loan or advance paid out: the member of staff owes it back. */
export function loanIssueJournal(principalMinor: number, bankCode: string): PayJournalLine[] {
  return [
    { accountCode: payrollAccounts.staffLoans, projectId: null, fundId: null, amount: principalMinor, type: 'debit', memo: 'Staff loan or advance' },
    { accountCode: bankCode, projectId: null, fundId: null, amount: principalMinor, type: 'credit', memo: 'Paid from the bank' },
  ];
}

export function loanProblems(input: { principalMinor: number; instalmentMinor: number; firstPeriod: string; issuedOn: string }): string[] {
  const problems: string[] = [];
  if (!Number.isSafeInteger(input.principalMinor) || input.principalMinor <= 0) problems.push('Enter the amount lent.');
  if (!Number.isSafeInteger(input.instalmentMinor) || input.instalmentMinor <= 0) problems.push('Enter the monthly instalment.');
  else if (input.instalmentMinor > input.principalMinor) problems.push('The instalment cannot be more than the loan.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.firstPeriod)) problems.push('Choose the first month an instalment is taken.');
  else if (input.firstPeriod < input.issuedOn.slice(0, 7)) problems.push('Repayments cannot start before the loan is made.');
  return problems;
}

/** The repayment schedule from here: one instalment a month until it is cleared. */
export function loanSchedule(outstandingMinor: number, instalmentMinor: number, fromPeriod: string): { period: string; amountMinor: number; leftMinor: number }[] {
  const rows: { period: string; amountMinor: number; leftMinor: number }[] = [];
  let left = outstandingMinor;
  let [year, month] = fromPeriod.split('-').map(Number);
  while (left > 0 && rows.length < 600) {
    const amount = Math.min(instalmentMinor, left);
    left -= amount;
    rows.push({ period: `${year}-${String(month).padStart(2, '0')}`, amountMinor: amount, leftMinor: left });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return rows;
}
