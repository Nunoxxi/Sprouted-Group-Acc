/**
 * A pay run end to end, without a database: everyone worked out, the journal,
 * what is left owing and when, loans and the project split.
 *
 * Every scenario the brief names — an employee in each PAYE band, one below
 * the tax-free threshold, a mid-month joiner and leaver, a bonus month,
 * reliefs, and a rate change part way through the year re-run to the
 * original figures — and every one proves its journal balances.
 */

import { describe, expect, it } from 'vitest';

import type { EntityPayrollSettings } from '@/lib/payroll-engine';
import {
  allocationProblem,
  approvalProblems,
  calculateRun,
  dueDateFor,
  employedIn,
  isBalanced,
  loanInstalments,
  loanIssueJournal,
  loanProblems,
  loanSchedule,
  payDateFor,
  payRunJournal,
  remittancePaymentJournal,
  remittancePosition,
  remittancesFor,
  runTotals,
  splitByShares,
  type CalculatedLine,
  type EmployeeForPay,
  type LoanForPay,
  type PayJournalLine,
} from '@/lib/payroll-run';
import { RateBook, type StatutoryRateRow } from '@/lib/payroll-rates';

import { employee, ghs, rateSet } from './payroll-fixtures';

const settings: EntityPayrollSettings = { prorationBasis: 'calendar-days', tier3Offered: true };
const rates = rateSet('2026-01-01', null);

function run(period: string, employees: EmployeeForPay[], extra: { loans?: LoanForPay[]; rows?: StatutoryRateRow[]; variables?: Record<string, { bonusMinor: number; overtimeMinor: number }> } = {}) {
  const lines = calculateRun({ period, settings, employees, loans: extra.loans ?? [], variables: extra.variables ?? {}, bonusConcessionUsed: {}, rates: extra.rows ?? rates });
  return { lines, journal: journalOf(lines) };
}

function journalOf(lines: CalculatedLine[]): PayJournalLine[] {
  const ok = lines.filter((line) => line.result);
  const journal = payRunJournal(ok.map((line) => ({ expenseAccountCode: line.expenseAccountCode, allocations: line.allocations, result: line.result! })));
  expect(isBalanced(journal)).toBe(true);
  return journal;
}

/** Credits (or debits) on one account, optionally only those with a given memo. */
const on = (journal: PayJournalLine[], code: string, type: 'debit' | 'credit', memo?: string) =>
  journal.filter((l) => l.accountCode === code && l.type === type && (!memo || l.memo === memo)).reduce((sum, l) => sum + l.amount, 0);

describe('an employee in each PAYE band, and one below the threshold', () => {
  // Basic only: chargeable = basic − 5.5%. PAYE as worked in the engine's tests.
  const bands: [number, number][] = [
    [400, 0], // below the tax-free threshold
    [600, 3.85],
    [700, 11.65],
    [2000, 221.5],
    [10000, 1961],
    [30000, 7108.67],
    [60000, 15927.83],
  ];
  const staff = bands.map(([basic]) => employee({ basicMinor: ghs(basic) }));
  const { lines, journal } = run('2026-10', staff);

  it('pays each person the PAYE their band gives', () => {
    expect(lines.map((line) => line.result!.payeMinor)).toEqual(bands.map(([, paye]) => ghs(paye)));
  });

  it('posts one balanced journal for all of them', () => {
    // Gross 103,700. Employee SSNIT 5,703.50. PAYE 25,234.50. Net 72,762.
    // Employer SSNIT 8% = 8,296; tier 2 5% = 5,185.
    expect(on(journal, '6001', 'debit')).toBe(ghs(103700));
    expect(on(journal, '6065', 'debit')).toBe(ghs(8296 + 5185));
    expect(on(journal, '2040', 'credit')).toBe(ghs(25234.5));
    expect(on(journal, '2045', 'credit', 'Employee SSNIT (tier 1)')).toBe(ghs(5703.5));
    expect(on(journal, '2045', 'credit', 'Employer SSNIT (tier 1)')).toBe(ghs(8296));
    expect(on(journal, '2046', 'credit')).toBe(ghs(5185));
    expect(on(journal, '2047', 'credit')).toBe(ghs(72762));
    expect(isBalanced(journal)).toBe(true);
  });

  it('keeps PAYE, employee SSNIT, employer SSNIT, tier 2 and net pay as separate liability lines', () => {
    expect(journal.filter((l) => l.type === 'credit').map((l) => l.memo)).toEqual(['PAYE', 'Employee SSNIT (tier 1)', 'Employer SSNIT (tier 1)', 'Tier 2', 'Net pay']);
  });

  it('leaves out a line with nothing on it: no tier 3, no loans', () => {
    expect(journal.some((l) => l.amount === 0)).toBe(false);
    expect(on(journal, '2049', 'credit')).toBe(0);
  });
});

describe('a mid-month joiner and a mid-month leaver', () => {
  const joiner = employee({ basicMinor: ghs(3100), startDate: '2026-03-16', allowances: [{ name: 'Transport', amountMinor: ghs(310), taxable: true, pensionable: false }] });
  const leaver = employee({ basicMinor: ghs(3100), endDate: '2026-03-10' });
  const gone = employee({ basicMinor: ghs(3100), endDate: '2026-02-28' });
  const { lines, journal } = run('2026-03', [joiner, leaver, gone]);

  it('pays each for the days they were employed, and leaves out someone already gone', () => {
    expect(lines.map((line) => line.employeeId)).toEqual([joiner.id, leaver.id]);
    expect(lines[0].result!.grossMinor).toBe(ghs(1760)); // 16/31 of 3,100 + 16/31 of 310
    expect(lines[1].result!.grossMinor).toBe(ghs(1000)); // 10/31 of 3,100
  });

  it('balances', () => {
    expect(on(journal, '6001', 'debit')).toBe(ghs(2760));
    expect(isBalanced(journal)).toBe(true);
  });

  it('knows who was employed in the period', () => {
    expect(employedIn(gone, '2026-03')).toBe(false);
    expect(employedIn(leaver, '2026-03')).toBe(true);
    expect(employedIn({ startDate: '2026-04-01', endDate: null }, '2026-03')).toBe(false);
  });
});

describe('a bonus month', () => {
  const person = employee({ basicMinor: ghs(4000) });
  const { lines, journal } = run('2026-12', [person], { variables: { [person.id]: { bonusMinor: ghs(10000), overtimeMinor: 0 } } });

  it('taxes the bonus within the concession at the final rate, the rest through the bands', () => {
    expect(lines[0].result!.bonusTaxMinor).toBe(ghs(360));
    expect(lines[0].result!.payeMinor).toBe(ghs(1603.5));
  });

  it('balances, with the bonus tax inside the one PAYE liability', () => {
    expect(on(journal, '6001', 'debit')).toBe(ghs(14000));
    expect(on(journal, '2040', 'credit')).toBe(ghs(1603.5));
    expect(isBalanced(journal)).toBe(true);
  });

  it('shares the concession with earlier bonuses that year', () => {
    const used = calculateRun({ period: '2026-12', settings, employees: [person], loans: [], variables: { [person.id]: { bonusMinor: ghs(1000), overtimeMinor: 0 } }, bonusConcessionUsed: { [person.id]: ghs(7200) }, rates });
    expect(used[0].result!.bonusConcessionMinor).toBe(0);
    journalOf(used);
  });
});

describe('an employee with reliefs', () => {
  const person = employee({ basicMinor: ghs(4000), reliefs: { marriage: true, childrenInEducation: 4, agedDependants: 1, disability: false, oldAge: true } });
  const { lines, journal } = run('2026-03', [person]);

  it('takes the registered reliefs off chargeable income', () => {
    expect(lines[0].result!.reliefsMinor).toBe(ghs(458.33)); // 100 + 3 × 50 + 83.33 + 125
    expect(lines[0].result!.payeMinor).toBe(ghs(472.04));
  });

  it('balances', () => {
    expect(on(journal, '2040', 'credit')).toBe(ghs(472.04));
    expect(isBalanced(journal)).toBe(true);
  });
});

describe('a rate change part way through the year', () => {
  const before = rateSet('2026-01-01', null);
  const after = [
    ...rateSet('2026-01-01', '2026-06-30'),
    ...rateSet('2026-07-01', null, { bands: [[600, 0], [200, 5], [3200, 17.5], [null, 30]], employeeSsnit: 6, employerSsnit: 9 }),
  ];
  const staff = [
    employee({ basicMinor: ghs(4000), allowances: [{ name: 'Transport', amountMinor: ghs(500), taxable: true, pensionable: false }], reliefs: { marriage: true, childrenInEducation: 0, agedDependants: 0, disability: false, oldAge: false } }),
    employee({ basicMinor: ghs(30000) }),
  ];

  it('re-runs an earlier month to the original figures and the same journal', () => {
    const original = run('2026-03', staff, { rows: before });
    const rerun = run('2026-03', staff, { rows: after });
    expect(rerun.journal).toEqual(original.journal);
    expect(rerun.lines.map((l) => l.result!.payeMinor)).toEqual(original.lines.map((l) => l.result!.payeMinor));
    expect(rerun.lines.map((l) => l.result!.netMinor)).toEqual(original.lines.map((l) => l.result!.netMinor));
    expect(isBalanced(rerun.journal)).toBe(true);
  });

  it('uses the new rates from the month they start, and still balances', () => {
    const july = run('2026-07', staff, { rows: after });
    expect(july.lines[0].result!.employeeSsnitMinor).toBe(ghs(240)); // 6%
    expect(july.lines[0].result!.payeMinor).toBe(ghs(618));
    expect(isBalanced(july.journal)).toBe(true);
  });
});

describe('the project split', () => {
  const person = employee({
    basicMinor: ghs(4000),
    allocations: [
      { projectId: 'p1', fundId: 'f1', shareBasisPoints: 6000 },
      { projectId: 'p2', fundId: null, shareBasisPoints: 4000 },
    ],
  });
  const { journal } = run('2026-03', [person]);

  it('charges gross pay and the employer contributions to each project by its share', () => {
    const debit = (code: string, project: string) => journal.find((l) => l.accountCode === code && l.projectId === project)!.amount;
    expect(debit('6001', 'p1')).toBe(ghs(2400));
    expect(debit('6001', 'p2')).toBe(ghs(1600));
    expect(debit('6065', 'p1')).toBe(ghs(312)); // 60% of 320 + 200
    expect(debit('6065', 'p2')).toBe(ghs(208));
    expect(journal.find((l) => l.projectId === 'p1')!.fundId).toBe('f1');
    expect(isBalanced(journal)).toBe(true);
  });

  it('splits to the pesewa with the parts adding back to the whole', () => {
    const parts = splitByShares(100001, [
      { key: 'a', shareBasisPoints: 3333 },
      { key: 'b', shareBasisPoints: 3333 },
      { key: 'c', shareBasisPoints: 3334 },
    ]);
    expect(parts.reduce((sum, p) => sum + p.amountMinor, 0)).toBe(100001);
    expect(parts.map((p) => p.amountMinor)).toEqual([33330, 33330, 33341]);
  });

  it('must add up to 100%, or there is no split at all', () => {
    expect(allocationProblem([])).toBeNull();
    expect(allocationProblem([{ shareBasisPoints: 6000 }, { shareBasisPoints: 3000 }])).toMatch(/add up to 90%/);
    const wrong = employee({ basicMinor: ghs(1000), allocations: [{ projectId: 'p1', fundId: null, shareBasisPoints: 9000 }] });
    expect(run('2026-03', [wrong]).lines[0].error).toMatch(/project split is wrong/);
  });
});

describe('staff loans', () => {
  const person = employee({ basicMinor: ghs(4000) });
  const loans: LoanForPay[] = [
    { id: 'loan-1', employeeId: person.id, description: 'Staff loan', instalmentMinor: ghs(200), firstPeriod: '2026-03', outstandingMinor: ghs(500) },
    { id: 'loan-2', employeeId: person.id, description: 'Salary advance', instalmentMinor: ghs(300), firstPeriod: '2026-03', outstandingMinor: ghs(150) },
    { id: 'loan-3', employeeId: person.id, description: 'Not yet', instalmentMinor: ghs(100), firstPeriod: '2026-04', outstandingMinor: ghs(100) },
  ];

  it('takes each instalment due, never more than is left', () => {
    expect(loanInstalments(loans, person.id, '2026-03').map((d) => d.amountMinor)).toEqual([ghs(200), ghs(150)]);
  });

  it('deducts them from net pay and credits staff loans, and balances', () => {
    const { lines, journal } = run('2026-03', [person], { loans });
    expect(lines[0].result!.deductionsMinor).toBe(ghs(350));
    expect(on(journal, '1080', 'credit')).toBe(ghs(350));
    expect(on(journal, '2047', 'credit')).toBe(lines[0].result!.netMinor);
    expect(isBalanced(journal)).toBe(true);
  });

  it('posts the loan itself as money owed to us, paid from the bank', () => {
    const journal = loanIssueJournal(ghs(1000), '1001');
    expect(isBalanced(journal)).toBe(true);
    expect(on(journal, '1080', 'debit')).toBe(ghs(1000));
  });

  it('lays out the repayments month by month to nil', () => {
    expect(loanSchedule(ghs(500), ghs(200), '2026-11')).toEqual([
      { period: '2026-11', amountMinor: ghs(200), leftMinor: ghs(300) },
      { period: '2026-12', amountMinor: ghs(200), leftMinor: ghs(100) },
      { period: '2027-01', amountMinor: ghs(100), leftMinor: 0 },
    ]);
  });

  it('refuses a loan that makes no sense', () => {
    expect(loanProblems({ principalMinor: ghs(100), instalmentMinor: ghs(200), firstPeriod: '2026-03', issuedOn: '2026-03-01' })).toContain('The instalment cannot be more than the loan.');
    expect(loanProblems({ principalMinor: ghs(100), instalmentMinor: ghs(50), firstPeriod: '2026-02', issuedOn: '2026-03-01' })).toContain('Repayments cannot start before the loan is made.');
  });
});

describe('approval', () => {
  it('is refused while anyone could not be calculated', () => {
    const casual = employee({ basicMinor: ghs(1000), employmentType: 'casual', name: 'Kwesi' });
    const { lines } = run('2026-03', [casual, employee({ basicMinor: ghs(1000) })]);
    expect(lines[0].error).toMatch(/casual worker/);
    expect(approvalProblems(lines)).toEqual([expect.stringMatching(/casual worker/)]);
    journalOf(lines); // the people who could be calculated still balance
  });

  it('is refused while any figure used is a placeholder, naming them', () => {
    const { lines } = run('2026-03', [employee({ basicMinor: ghs(1000) })], { rows: rateSet('2026-01-01', null, { placeholder: true }) });
    expect(approvalProblems(lines)[0]).toMatch(/still placeholders.*Employee SSNIT \(tier 1\)/);
  });

  it('is refused for an empty run', () => {
    expect(approvalProblems([])).toEqual(['Nobody is on this run.']);
  });
});

describe('what a posted run leaves owing, and when', () => {
  const staff = [employee({ basicMinor: ghs(4000), tier3Minor: ghs(100) }), employee({ basicMinor: ghs(2000) })];
  const { lines, journal } = run('2026-10', staff);
  const totals = runTotals(lines.map((l) => l.result!));

  it('lists each remittance with its deadline from the rules in force', () => {
    // November 2026: the 14th is a Saturday and the 15th a Sunday.
    const due = remittancesFor(totals, new RateBook(rates, '2026-10'), '2026-10-28');
    expect(due.map((r) => [r.kind, r.dueDate])).toEqual([
      ['paye', '2026-11-15'],
      ['ssnit-tier1', '2026-11-14'],
      ['ssnit-tier2', '2026-11-14'],
      ['tier3', '2026-11-14'],
      ['net-pay', '2026-10-28'],
    ]);
  });

  it('owes exactly what the journal credited to each liability', () => {
    const due = Object.fromEntries(remittancesFor(totals, new RateBook(rates, '2026-10'), '2026-10-28').map((r) => [r.kind, r.amountMinor]));
    expect(due.paye).toBe(on(journal, '2040', 'credit'));
    expect(due['ssnit-tier1']).toBe(on(journal, '2045', 'credit'));
    expect(due['ssnit-tier2']).toBe(on(journal, '2046', 'credit'));
    expect(due.tier3).toBe(on(journal, '2049', 'credit'));
    expect(due['net-pay']).toBe(on(journal, '2047', 'credit'));
  });

  it('moves a deadline off a weekend when the rule says so', () => {
    expect(dueDateFor('2026-10', { dayOfMonth: 14, weekend: 'next-working-day' })).toBe('2026-11-16');
    expect(dueDateFor('2026-10', { dayOfMonth: 15, weekend: 'previous-working-day' })).toBe('2026-11-13');
    expect(dueDateFor('2026-10', { dayOfMonth: 15, weekend: 'as-is' })).toBe('2026-11-15');
  });

  it('keeps a deadline inside a short month, and crosses the year', () => {
    expect(dueDateFor('2027-01', { dayOfMonth: 31, weekend: 'as-is' })).toBe('2027-02-28');
    expect(dueDateFor('2026-12', { dayOfMonth: 15, weekend: 'as-is' })).toBe('2027-01-15');
    expect(payDateFor('2026-02', 30)).toBe('2026-02-28');
  });

  it('pays a remittance out of the bank against its liability, balanced', () => {
    const payment = remittancePaymentJournal('paye', ghs(500), '1001');
    expect(isBalanced(payment)).toBe(true);
    expect(on(payment, '2040', 'debit')).toBe(ghs(500));
  });

  it('shows what is overdue and what is next', () => {
    const position = remittancePosition(
      [
        { id: 'a', period: '2026-09', kind: 'paye', amountMinor: 100, dueDate: '2026-10-15', paidOn: null, cancelled: false },
        { id: 'b', period: '2026-09', kind: 'ssnit-tier1', amountMinor: 200, dueDate: '2026-10-14', paidOn: '2026-10-14', cancelled: false },
        { id: 'c', period: '2026-10', kind: 'paye', amountMinor: 300, dueDate: '2026-11-15', paidOn: null, cancelled: false },
        { id: 'd', period: '2026-08', kind: 'paye', amountMinor: 999, dueDate: '2026-09-15', paidOn: null, cancelled: true },
      ],
      '2026-10-20',
    );
    expect(position.overdueMinor).toBe(100);
    expect(position.outstandingMinor).toBe(400);
    expect(position.next?.id).toBe('c');
  });
});
