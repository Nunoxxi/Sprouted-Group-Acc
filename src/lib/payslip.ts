/**
 * What a payslip says: earnings, deductions, employer contributions, net
 * pay, year-to-date totals and what is left on any loan. One model, used by
 * the screen, the PDF and the email, so the three cannot disagree.
 *
 * Pure: no I/O, no Prisma, no clock.
 */

import type { PayResult } from './payroll-engine';
import type { PayLineFact } from './payroll-reports';

export type PayslipRow = { label: string; amountMinor: number; note?: string };

export type Payslip = {
  entityName: string;
  period: string;
  payDate: string;
  employee: { name: string; staffNumber: string; department: string; tin: string; ssnitNumber: string };
  /** Shown only when the employee was paid for part of the month. */
  daysNote: string | null;
  earnings: PayslipRow[];
  grossMinor: number;
  deductions: PayslipRow[];
  totalDeductionsMinor: number;
  netMinor: number;
  employer: PayslipRow[];
  yearToDate: PayslipRow[];
  loans: { description: string; instalmentMinor: number; outstandingMinor: number }[];
  /** True while the run is not posted: the figures may still change. */
  provisional: boolean;
};

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function periodLabel(period: string): string {
  const [year, month] = period.split('-').map(Number);
  return `${monthNames[month - 1]} ${year}`;
}

export function buildPayslip(args: {
  entityName: string;
  period: string;
  payDate: string;
  posted: boolean;
  employee: Payslip['employee'];
  result: PayResult;
  /** Allowances as paid this period (prorated), in the order the working lists them. */
  deductions: { loanId: string | null; name: string; amountMinor: number }[];
  /** Every loan the employee has, with what was outstanding before this run, from posted runs. */
  loans: { id: string; description: string; outstandingBeforeMinor: number }[];
  /** Posted lines for this employee earlier in the same calendar year. */
  earlierThisYear: Pick<PayLineFact, 'grossMinor' | 'employeeSsnitMinor' | 'tier3Minor' | 'payeMinor' | 'netMinor'>[];
}): Payslip {
  const r = args.result;
  const grossLines = r.working.filter((line) => line.step === 'Gross pay' && !line.total);
  const earnings: PayslipRow[] = grossLines.map((line) => ({ label: line.label, amountMinor: line.amountMinor, note: line.detail && line.detail !== 'taxable' ? line.detail : undefined }));

  const deductions: PayslipRow[] = [
    { label: 'Employee SSNIT (tier 1)', amountMinor: r.employeeSsnitMinor },
    ...(r.tier3Minor ? [{ label: 'Tier 3 pension', amountMinor: r.tier3Minor }] : []),
    { label: 'PAYE income tax', amountMinor: r.payeMinor },
    ...args.deductions.map((d) => ({ label: d.name, amountMinor: d.amountMinor })),
  ];

  const ytd = [...args.earlierThisYear, { grossMinor: r.grossMinor, employeeSsnitMinor: r.employeeSsnitMinor, tier3Minor: r.tier3Minor, payeMinor: r.payeMinor, netMinor: r.netMinor }];
  const total = (pick: (row: (typeof ytd)[number]) => number) => ytd.reduce((sum, row) => sum + pick(row), 0);

  const thisMonth = new Map(args.deductions.filter((d) => d.loanId).map((d) => [d.loanId!, d.amountMinor]));
  const loans = args.loans
    .map((loan) => ({ description: loan.description, instalmentMinor: thisMonth.get(loan.id) ?? 0, outstandingMinor: loan.outstandingBeforeMinor - (thisMonth.get(loan.id) ?? 0) }))
    .filter((loan) => loan.instalmentMinor > 0 || loan.outstandingMinor > 0);

  return {
    entityName: args.entityName,
    period: args.period,
    payDate: args.payDate,
    employee: args.employee,
    daysNote: r.daysEmployed < r.daysInPeriod ? `Paid for ${r.daysEmployed} of ${r.daysInPeriod} ${r.prorationBasis === 'working-days' ? 'working days' : 'days'} this month.` : null,
    earnings,
    grossMinor: r.grossMinor,
    deductions,
    totalDeductionsMinor: deductions.reduce((sum, d) => sum + d.amountMinor, 0),
    netMinor: r.netMinor,
    employer: [
      { label: 'Employer SSNIT (tier 1)', amountMinor: r.employerSsnitMinor },
      { label: 'Tier 2', amountMinor: r.employerTier2Minor },
    ],
    yearToDate: [
      { label: 'Gross pay', amountMinor: total((row) => row.grossMinor) },
      { label: 'Employee SSNIT', amountMinor: total((row) => row.employeeSsnitMinor) },
      { label: 'Tier 3', amountMinor: total((row) => row.tier3Minor) },
      { label: 'PAYE', amountMinor: total((row) => row.payeMinor) },
      { label: 'Net pay', amountMinor: total((row) => row.netMinor) },
    ].filter((row) => row.label !== 'Tier 3' || row.amountMinor > 0),
    loans,
    provisional: !args.posted,
  };
}

/** "GHS 1,234.56", for the PDF and the email, which have no Money component. */
export function ghsText(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}GHS ${Math.floor(abs / 100).toLocaleString('en-GH')}.${String(abs % 100).padStart(2, '0')}`;
}

/** The payslip as plain text: the body of the email the PDF is attached to. */
export function payslipText(slip: Payslip): string {
  const row = (r: PayslipRow) => `  ${r.label.padEnd(34)} ${ghsText(r.amountMinor).padStart(16)}`;
  return [
    `${slip.entityName} — payslip for ${periodLabel(slip.period)}${slip.provisional ? ' (provisional)' : ''}`,
    `${slip.employee.name} · ${slip.employee.staffNumber}`,
    `Paid on ${slip.payDate}`,
    ...(slip.daysNote ? [slip.daysNote] : []),
    '',
    'Earnings',
    ...slip.earnings.map(row),
    row({ label: 'Gross pay', amountMinor: slip.grossMinor }),
    '',
    'Deductions',
    ...slip.deductions.map(row),
    '',
    row({ label: 'Net pay', amountMinor: slip.netMinor }),
    '',
    'Paid by your employer on top of your pay',
    ...slip.employer.map(row),
    '',
    'Year to date',
    ...slip.yearToDate.map(row),
    ...(slip.loans.length ? ['', 'Loans and advances', ...slip.loans.map((l) => `  ${l.description.padEnd(34)} ${ghsText(l.outstandingMinor).padStart(16)} left`)] : []),
  ].join('\n');
}
