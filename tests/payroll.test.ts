/**
 * Payroll import: reading a summary against a remembered mapping, checking
 * each row adds up, splitting a person's cost across grants, the month's
 * journal, and what is left owing with its due dates. Pure.
 *
 * Nothing here computes anybody's tax. Payroll is run elsewhere; this only
 * checks what it produced and posts it.
 */

import { describe, expect, it } from 'vitest';

import {
  allocate,
  allocationTotal,
  dueDateFor,
  emptyMapping,
  liabilitiesFor,
  liabilityPaymentJournal,
  liabilityPosition,
  looksLikeCasualLabour,
  parsePayroll,
  payrollJournal,
  totalsOf,
  type Allocation,
  type CostLine,
  type PayrollMapping,
} from '@/lib/payroll';

const names: Record<string, string> = {
  '1001': 'Cash and Bank',
  '2040': 'PAYE Payable',
  '2045': 'SSNIT Payable',
  '2046': 'SSNIT Tier 2 Payable',
  '2047': 'Net Pay Payable',
  '6020': 'Staff Salaries',
  '6065': 'Employer SSNIT Contributions',
};

const balanced = (lines: { amount: number; type: 'debit' | 'credit' }[]) =>
  lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0) ===
  lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);

const mapping: PayrollMapping = {
  ...emptyMapping,
  name: 'Payroll summary',
  employeeRefColumn: 'Staff ID',
  employeeNameColumn: 'Name',
  departmentColumn: 'Department',
  grossColumn: 'Gross',
  payeColumn: 'PAYE',
  employeeSsnitColumn: 'SSNIT 5.5%',
  employerSsnitColumn: 'SSNIT 13%',
  ssnitTier2Column: 'Tier 2',
  otherDeductionsColumn: 'Other',
  netColumn: 'Net',
};

const csv = [
  'Staff ID,Name,Department,Gross,PAYE,SSNIT 5.5%,SSNIT 13%,Tier 2,Other,Net',
  'E001,Akosua Mensah,Programmes,"5,000.00",600.00,275.00,650.00,250.00,0.00,"4,125.00"',
  'E002,Kwesi Boateng,Administration,"3,000.00",250.00,165.00,390.00,150.00,100.00,"2,485.00"',
  '',
  ',TOTAL,,"8,000.00",850.00,440.00,"1,040.00",400.00,100.00,"6,610.00"',
].join('\n');

describe('reading the file', () => {
  it('reads each person against the mapping', () => {
    const parsed = parsePayroll(csv, mapping);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      employeeRef: 'E001',
      employeeName: 'Akosua Mensah',
      department: 'Programmes',
      grossMinor: 5_000_00,
      payeMinor: 600_00,
      employeeSsnitMinor: 275_00,
      employerSsnitMinor: 650_00,
      ssnitTier2Minor: 250_00,
      netMinor: 4_125_00,
    });
  });

  it('skips the blank line and the totals row rather than treating them as people', () => {
    const parsed = parsePayroll(csv, mapping);
    expect(parsed.rows.map((row) => row.employeeName)).toEqual(['Akosua Mensah', 'Kwesi Boateng']);
    // The totals line is passed over and said so, not silently swallowed.
    expect(parsed.skipped).toEqual([{ row: 4, label: 'TOTAL' }]);
  });

  it('totals the month, including what the employer pays on top', () => {
    const { totals } = parsePayroll(csv, mapping);
    expect(totals).toMatchObject({
      grossMinor: 8_000_00,
      payeMinor: 850_00,
      employeeSsnitMinor: 440_00,
      employerSsnitMinor: 1_040_00,
      ssnitTier2Minor: 400_00,
      otherDeductionsMinor: 100_00,
      netMinor: 6_610_00,
      employerCostMinor: 9_440_00,
    });
  });

  it("reports a row whose net does not equal gross less its own deductions", () => {
    const wrong = csv.replace('"4,125.00"', '"4,999.00"');
    const parsed = parsePayroll(wrong, mapping);
    expect(parsed.rows).toHaveLength(2); // still imported, but flagged
    expect(parsed.unbalanced).toEqual([{ row: 2, employeeName: 'Akosua Mensah', expectedMinor: 4_125_00, statedMinor: 4_999_00 }]);
  });

  it('works out net itself when the file has no net column', () => {
    const parsed = parsePayroll(csv, { ...mapping, netColumn: null });
    expect(parsed.rows[1].netMinor).toBe(2_485_00);
    expect(parsed.unbalanced).toEqual([]);
  });

  it('refuses a file whose columns the mapping does not name', () => {
    const parsed = parsePayroll('Who,How much\nAma,100', mapping);
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors.map((error) => error.message)).toContain('No "Name" column in the file.');
  });

  it('reports a row with no name, and one whose gross cannot be read', () => {
    const broken = ['Staff ID,Name,Department,Gross,PAYE,SSNIT 5.5%,SSNIT 13%,Tier 2,Other,Net', 'E003,,Programmes,100.00,0,0,0,0,0,100.00', 'E004,Ama,Programmes,rubbish,0,0,0,0,0,0'].join('\n');
    const parsed = parsePayroll(broken, mapping);
    expect(parsed.errors.map((error) => error.row)).toEqual([2, 3]);
    expect(parsed.rows).toEqual([]);
  });

  it('an empty file is an error, not an empty payroll', () => {
    expect(parsePayroll('', mapping).errors[0].message).toBe('The file is empty.');
  });

  it('warns on a department that sounds like casual labour, which belongs on the agent float', () => {
    expect(looksLikeCasualLabour('Casual labour')).toBe(true);
    expect(looksLikeCasualLabour('Seasonal pickers')).toBe(true);
    expect(looksLikeCasualLabour('Programmes')).toBe(false);
  });
});

describe("splitting a person's cost across grants", () => {
  const twoGrants: Allocation[] = [
    { employeeRef: 'E001', grantId: 'g1', budgetLineId: 'b1', pct: '60' },
    { employeeRef: 'E001', grantId: 'g2', budgetLineId: 'b2', pct: '40' },
  ];

  it('splits by percentage', () => {
    expect(allocate(5_000_00, twoGrants)).toEqual([
      { grantId: 'g1', budgetLineId: 'b1', amountMinor: 3_000_00 },
      { grantId: 'g2', budgetLineId: 'b2', amountMinor: 2_000_00 },
    ]);
  });

  it('always adds back to the whole, the rounding on the largest share', () => {
    const thirds: Allocation[] = [
      { employeeRef: 'E001', grantId: 'g1', budgetLineId: null, pct: '33.34' },
      { employeeRef: 'E001', grantId: 'g2', budgetLineId: null, pct: '33.33' },
      { employeeRef: 'E001', grantId: 'g3', budgetLineId: null, pct: '33.33' },
    ];
    const parts = allocate(1_000_01, thirds);
    expect(parts.reduce((sum, part) => sum + part.amountMinor, 0)).toBe(1_000_01);
  });

  it('leaves the rest uncoded when a person is only part funded', () => {
    const parts = allocate(5_000_00, [{ employeeRef: 'E001', grantId: 'g1', budgetLineId: 'b1', pct: '70' }]);
    expect(parts).toEqual([
      { grantId: 'g1', budgetLineId: 'b1', amountMinor: 3_500_00 },
      { grantId: null, budgetLineId: null, amountMinor: 1_500_00 },
    ]);
  });

  it('a person with no allocation is all uncoded', () => {
    expect(allocate(5_000_00, [])).toEqual([{ grantId: null, budgetLineId: null, amountMinor: 5_000_00 }]);
  });

  it('nothing to split produces nothing', () => {
    expect(allocate(0, twoGrants)).toEqual([]);
  });

  it('adds the percentages up so the person can see where they are', () => {
    expect(allocationTotal(twoGrants)).toBe(100);
    expect(allocationTotal([{ pct: '70' }])).toBe(70);
  });
});

describe("the month's journal", () => {
  const totals = parsePayroll(csv, mapping).totals;
  const costs: CostLine[] = [
    {
      accountCode: '6020',
      accountName: 'Staff Salaries',
      grossMinor: 5_000_00,
      employerSsnitMinor: 650_00,
      ssnitTier2Minor: 250_00,
      allocations: [
        { employeeRef: 'E001', grantId: 'g1', budgetLineId: 'b1', pct: '60' },
        { employeeRef: 'E001', grantId: 'g2', budgetLineId: 'b2', pct: '40' },
      ],
    },
    { accountCode: '6020', accountName: 'Staff Salaries', grossMinor: 3_000_00, employerSsnitMinor: 390_00, ssnitTier2Minor: 150_00, allocations: [] },
  ];

  it('balances: what it cost against what is owed', () => {
    expect(balanced(payrollJournal(costs, totals, names))).toBe(true);
  });

  it('charges gross pay and the employer SSNIT as costs', () => {
    const lines = payrollJournal(costs, totals, names);
    const gross = lines.filter((line) => line.accountCode === '6020' && line.type === 'debit');
    expect(gross.reduce((sum, line) => sum + line.amount, 0)).toBe(8_000_00);
    const employer = lines.filter((line) => line.accountCode === '6065');
    expect(employer.reduce((sum, line) => sum + line.amount, 0)).toBe(1_440_00);
  });

  it("splits the first person's cost across their grants, and leaves the second uncoded", () => {
    const lines = payrollJournal(costs, totals, names);
    const coded = lines.filter((line) => line.grantId);
    expect(coded.filter((line) => line.accountCode === '6020').map((line) => [line.grantId, line.amount])).toEqual([
      ['g1', 3_000_00],
      ['g2', 2_000_00],
    ]);
    // Their employer SSNIT follows the same split, so the donor sees the whole cost.
    expect(coded.filter((line) => line.accountCode === '6065').map((line) => [line.grantId, line.amount])).toEqual([
      ['g1', 540_00],
      ['g2', 360_00],
    ]);
    expect(lines.find((line) => line.accountCode === '6020' && !line.grantId)?.amount).toBe(3_000_00);
  });

  it('puts PAYE, both SSNIT tiers and net pay up as liabilities', () => {
    const lines = payrollJournal(costs, totals, names);
    const credit = (code: string) => lines.filter((line) => line.accountCode === code && line.type === 'credit').reduce((sum, line) => sum + line.amount, 0);
    expect(credit('2040')).toBe(850_00);
    expect(credit('2045')).toBe(1_480_00); // the employee's 440 and the employer's 1,040
    expect(credit('2046')).toBe(400_00);
    expect(credit('2047')).toBe(6_710_00); // net pay and the other deductions held back
  });

  it('nothing to post produces no lines', () => {
    expect(payrollJournal([], totalsOf([]), names)).toEqual([]);
  });
});

describe('what is owed and when', () => {
  const settings = { payeDueDay: 15, ssnitDueDay: 14 };

  it('PAYE and SSNIT fall due in the month after the payroll, on the days set', () => {
    expect(dueDateFor('paye', '2026-09', '2026-09-28', settings)).toBe('2026-10-15');
    expect(dueDateFor('ssnit-tier-1', '2026-09', '2026-09-28', settings)).toBe('2026-10-14');
    expect(dueDateFor('ssnit-tier-2', '2026-12', '2026-12-28', settings)).toBe('2027-01-14');
  });

  it('the days are settings, so a different one gives a different date', () => {
    expect(dueDateFor('paye', '2026-09', '2026-09-28', { payeDueDay: 10, ssnitDueDay: 14 })).toBe('2026-10-10');
  });

  it('a day beyond the end of the month lands on the last one', () => {
    expect(dueDateFor('paye', '2026-01', '2026-01-28', { payeDueDay: 31, ssnitDueDay: 14 })).toBe('2026-02-28');
  });

  it('net pay is due on the pay date: the staff are waiting', () => {
    expect(dueDateFor('net-pay', '2026-09', '2026-09-28', settings)).toBe('2026-09-28');
  });

  it('a month produces one liability per kind that has an amount', () => {
    const totals = parsePayroll(csv, mapping).totals;
    const rows = liabilitiesFor('2026-09', '2026-09-28', totals, settings);
    expect(rows.map((row) => [row.kind, row.amountMinor, row.dueDate])).toEqual([
      ['paye', 850_00, '2026-10-15'],
      ['ssnit-tier-1', 1_480_00, '2026-10-14'],
      ['ssnit-tier-2', 400_00, '2026-10-14'],
      ['net-pay', 6_610_00, '2026-09-28'],
      ['other-deductions', 100_00, '2026-09-28'],
    ]);
  });

  it('adds back to what the month cost, less what the employer paid on top', () => {
    const totals = parsePayroll(csv, mapping).totals;
    const rows = liabilitiesFor('2026-09', '2026-09-28', totals, settings);
    expect(rows.reduce((sum, row) => sum + row.amountMinor, 0)).toBe(totals.employerCostMinor);
  });
});

describe('the position on the dashboard', () => {
  const liabilities = [
    { id: 'l1', period: '2026-08', kind: 'paye' as const, amountMinor: 800_00, settledMinor: 0, dueDate: '2026-09-15' },
    { id: 'l2', period: '2026-09', kind: 'paye' as const, amountMinor: 850_00, settledMinor: 0, dueDate: '2026-10-15' },
    { id: 'l3', period: '2026-09', kind: 'net-pay' as const, amountMinor: 6_610_00, settledMinor: 6_610_00, dueDate: '2026-09-28' },
  ];

  it('shows what is outstanding, what is late and what falls due next', () => {
    const position = liabilityPosition(liabilities, '2026-09-22');
    expect(position.rows.map((row) => row.id)).toEqual(['l1', 'l2']); // the settled one is gone
    expect(position.outstandingMinor).toBe(1_650_00);
    expect(position.overdueMinor).toBe(800_00);
    expect(position.next?.id).toBe('l2');
  });

  it('a part payment leaves the rest outstanding', () => {
    const position = liabilityPosition([{ ...liabilities[0], settledMinor: 300_00 }], '2026-09-22');
    expect(position.rows[0].outstandingMinor).toBe(500_00);
    expect(position.rows[0].overdue).toBe(true);
  });

  it('nothing owed is nothing to show', () => {
    const position = liabilityPosition([liabilities[2]], '2026-10-01');
    expect(position.rows).toEqual([]);
    expect(position.next).toBeNull();
    expect(position.outstandingMinor).toBe(0);
  });

  it('paying one takes it off what is owed and out of the bank', () => {
    const lines = liabilityPaymentJournal('paye', 850_00, '1001', names);
    expect(balanced(lines)).toBe(true);
    expect(lines.map((line) => [line.accountCode, line.type])).toEqual([
      ['2040', 'debit'],
      ['1001', 'credit'],
    ]);
    expect(liabilityPaymentJournal('paye', 0, '1001', names)).toEqual([]);
  });
});
