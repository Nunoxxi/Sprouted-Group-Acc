/**
 * The payslip, and casual labour paid from an agent's float.
 *
 * A payslip shows earnings, deductions, the employer's contributions, net
 * pay, year-to-date totals and what is left on each loan — from the same
 * figures the journal posted. Casual labour relieves the float like a
 * purchase does, is a labour cost, and is not payroll.
 */

import { describe, expect, it } from 'vitest';

import type { EntityPayrollSettings } from '@/lib/payroll-engine';
import { calculateRun, isBalanced, type LoanForPay } from '@/lib/payroll-run';
import { buildPayslip, payslipText } from '@/lib/payslip';
import { floatLabourJournal, floatPosition } from '@/lib/trading';

import { employee, ghs, rateSet } from './payroll-fixtures';

const settings: EntityPayrollSettings = { prorationBasis: 'calendar-days', tier3Offered: true };
const rates = rateSet('2026-01-01', null);

describe('the payslip', () => {
  const person = employee({
    basicMinor: ghs(4000),
    name: 'Ama Owusu',
    allowances: [
      { name: 'Transport allowance', amountMinor: ghs(500), taxable: true, pensionable: false },
      { name: 'Field per diem', amountMinor: ghs(200), taxable: false, pensionable: false },
    ],
    tier3Minor: ghs(200),
    reliefs: { marriage: true, childrenInEducation: 0, agedDependants: 0, disability: false, oldAge: false },
  });
  const loans: LoanForPay[] = [{ id: 'loan-1', employeeId: person.id, description: 'Staff loan', instalmentMinor: ghs(150), firstPeriod: '2026-01', outstandingMinor: ghs(600) }];
  const [line] = calculateRun({ period: '2026-10', settings, employees: [person], loans, variables: {}, bonusConcessionUsed: {}, rates });
  const slip = buildPayslip({
    entityName: 'Sprouted Roots',
    period: '2026-10',
    payDate: '2026-10-28',
    posted: false,
    employee: { name: person.name, staffNumber: person.staffNumber, department: 'Programmes', tin: 'P001', ssnitNumber: 'C001' },
    result: line.result!,
    deductions: line.deductions,
    loans: [{ id: 'loan-1', description: 'Staff loan', outstandingBeforeMinor: ghs(600) }],
    earlierThisYear: [{ grossMinor: ghs(4700), employeeSsnitMinor: ghs(220), tier3Minor: ghs(200), payeMinor: ghs(593.5), netMinor: ghs(3536.5) }],
  });

  it('shows earnings adding to gross, and deductions taking gross to net', () => {
    expect(slip.earnings.map((e) => e.label)).toEqual(['Basic salary', 'Transport allowance', 'Field per diem']);
    expect(slip.earnings.reduce((s, e) => s + e.amountMinor, 0)).toBe(slip.grossMinor);
    expect(slip.grossMinor - slip.totalDeductionsMinor).toBe(slip.netMinor);
    expect(slip.netMinor).toBe(ghs(3536.5)); // the worked example
  });

  it('shows the employer’s contributions apart from the deductions', () => {
    expect(slip.employer).toEqual([
      { label: 'Employer SSNIT (tier 1)', amountMinor: ghs(320) },
      { label: 'Tier 2', amountMinor: ghs(200) },
    ]);
    expect(slip.deductions.map((d) => d.label)).not.toContain('Tier 2');
  });

  it('adds this month to the year to date', () => {
    expect(slip.yearToDate.find((r) => r.label === 'Gross pay')!.amountMinor).toBe(ghs(9400));
    expect(slip.yearToDate.find((r) => r.label === 'PAYE')!.amountMinor).toBe(ghs(1187));
  });

  it('shows what is left on the loan after this month', () => {
    expect(slip.loans).toEqual([{ description: 'Staff loan', instalmentMinor: ghs(150), outstandingMinor: ghs(450) }]);
  });

  it('says it is provisional until the run is posted', () => {
    expect(slip.provisional).toBe(true);
    expect(payslipText(slip)).toContain('(provisional)');
    expect(payslipText(slip)).toContain('GHS 3,536.50');
  });

  it('notes a part month', () => {
    const joiner = employee({ basicMinor: ghs(3100), startDate: '2026-10-16' });
    const [part] = calculateRun({ period: '2026-10', settings, employees: [joiner], loans: [], variables: {}, bonusConcessionUsed: {}, rates });
    const partSlip = buildPayslip({ entityName: 'X', period: '2026-10', payDate: '2026-10-28', posted: true, employee: { name: 'J', staffNumber: 'S', department: '', tin: '', ssnitNumber: '' }, result: part.result!, deductions: [], loans: [], earlierThisYear: [] });
    expect(partSlip.daysNote).toBe('Paid for 16 of 31 days this month.');
  });
});

describe('casual labour paid from a float', () => {
  it('is a labour cost that relieves the float, balanced', () => {
    const journal = floatLabourJournal(ghs(1200), '6070', {});
    expect(isBalanced(journal)).toBe(true);
    expect(journal).toEqual([
      { accountCode: '6070', accountName: 'Casual Labour', amount: ghs(1200), type: 'debit' },
      { accountCode: '1060', accountName: 'Agent Float Advances', amount: ghs(1200), type: 'credit' },
    ]);
  });

  it('counts towards the float reconciling: advanced = purchases + labour + cash back', () => {
    const position = floatPosition({ amountMinor: ghs(10000), date: '2026-10-01' }, ghs(7000), ghs(1800), '2026-10-05', 14, ghs(1200));
    expect(position.labourMinor).toBe(ghs(1200));
    expect(position.outstandingMinor).toBe(0);
    expect(position.reconciles).toBe(true);
  });

  it('leaves a float without labour as it was', () => {
    expect(floatPosition({ amountMinor: ghs(100), date: '2026-10-01' }, ghs(60), ghs(40), '2026-10-05', 14).outstandingMinor).toBe(0);
  });
});
