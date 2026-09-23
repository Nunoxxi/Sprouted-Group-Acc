/**
 * Payroll import. There is no payroll engine here and there should not be:
 * payroll is run in a Ghanaian payroll system or a spreadsheet, and this
 * takes the summary it produces and posts it.
 *
 * What the app does is read the file against a mapping it remembers, check
 * each row adds up, split each person's cost across grants where that has
 * been set, and post one journal a month: gross pay by department or grant
 * and the employer's SSNIT as costs, PAYE, the SSNIT tiers and net pay as
 * liabilities until they are paid.
 *
 * Casual and seasonal labour paid by a buying agent is not payroll. It goes
 * through the agent float, where the money actually left.
 *
 * Pure: no I/O, no Prisma. Money is integer minor units throughout.
 */

import { parseAmountMinor, splitCsvLine } from './momo';
import type { TradingJournalLine } from './trading';

// --- accounts -------------------------------------------------------------------------------

export const payrollAccounts = {
  paye: '2040',
  ssnitTier1: '2045',
  ssnitTier2: '2046',
  netPay: '2047',
  employerSsnit: '6065',
} as const;

// --- the mapping ------------------------------------------------------------------------------

/**
 * Which column of the payroll file holds what. Named and saved per entity, so
 * the columns are matched once and the same file shape imports every month.
 */
export type PayrollMapping = {
  name: string;
  employeeRefColumn: string | null;
  employeeNameColumn: string;
  departmentColumn: string | null;
  grossColumn: string;
  payeColumn: string | null;
  employeeSsnitColumn: string | null;
  employerSsnitColumn: string | null;
  ssnitTier2Column: string | null;
  otherDeductionsColumn: string | null;
  netColumn: string | null;
};

export const emptyMapping: PayrollMapping = {
  name: '',
  employeeRefColumn: null,
  employeeNameColumn: '',
  departmentColumn: null,
  grossColumn: '',
  payeColumn: null,
  employeeSsnitColumn: null,
  employerSsnitColumn: null,
  ssnitTier2Column: null,
  otherDeductionsColumn: null,
  netColumn: null,
};

export type PayrollRow = {
  row: number;
  employeeRef: string;
  employeeName: string;
  department: string;
  grossMinor: number;
  payeMinor: number;
  employeeSsnitMinor: number;
  employerSsnitMinor: number;
  ssnitTier2Minor: number;
  otherDeductionsMinor: number;
  netMinor: number;
};

export type PayrollParse = {
  rows: PayrollRow[];
  errors: { row: number; message: string }[];
  /** Summary rows the file carries, passed over rather than treated as people. */
  skipped: { row: number; label: string }[];
  /** Rows whose net pay does not equal gross less the deductions listed. */
  unbalanced: { row: number; employeeName: string; expectedMinor: number; statedMinor: number }[];
  totals: PayrollTotals;
};

export type PayrollTotals = {
  grossMinor: number;
  payeMinor: number;
  employeeSsnitMinor: number;
  employerSsnitMinor: number;
  ssnitTier2Minor: number;
  otherDeductionsMinor: number;
  netMinor: number;
  /** Gross plus what the employer pays on top: what the month actually cost. */
  employerCostMinor: number;
};

const emptyTotals = (): PayrollTotals => ({
  grossMinor: 0,
  payeMinor: 0,
  employeeSsnitMinor: 0,
  employerSsnitMinor: 0,
  ssnitTier2Minor: 0,
  otherDeductionsMinor: 0,
  netMinor: 0,
  employerCostMinor: 0,
});

export function totalsOf(rows: PayrollRow[]): PayrollTotals {
  const totals = rows.reduce((total, row) => {
    total.grossMinor += row.grossMinor;
    total.payeMinor += row.payeMinor;
    total.employeeSsnitMinor += row.employeeSsnitMinor;
    total.employerSsnitMinor += row.employerSsnitMinor;
    total.ssnitTier2Minor += row.ssnitTier2Minor;
    total.otherDeductionsMinor += row.otherDeductionsMinor;
    total.netMinor += row.netMinor;
    return total;
  }, emptyTotals());
  totals.employerCostMinor = totals.grossMinor + totals.employerSsnitMinor + totals.ssnitTier2Minor;
  return totals;
}

/**
 * Read a payroll summary against its mapping. Every row is checked: net pay
 * has to equal gross less the deductions the file itself lists, or the row is
 * reported. The app does not recompute anybody's tax — it only checks that
 * what the payroll system produced adds up before it goes near the ledger.
 *
 * Where a file has no net column, net is taken as gross less the deductions.
 */
export function parsePayroll(csv: string, mapping: PayrollMapping): PayrollParse {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return { rows: [], errors: [{ row: 0, message: 'The file is empty.' }], skipped: [], unbalanced: [], totals: emptyTotals() };
  const headers = splitCsvLine(lines[0]).map((header) => header.trim());
  const indexOf = (name: string | null) => (name ? headers.findIndex((header) => header.toLowerCase() === name.toLowerCase()) : -1);
  const columns = {
    ref: indexOf(mapping.employeeRefColumn),
    name: indexOf(mapping.employeeNameColumn),
    department: indexOf(mapping.departmentColumn),
    gross: indexOf(mapping.grossColumn),
    paye: indexOf(mapping.payeColumn),
    employeeSsnit: indexOf(mapping.employeeSsnitColumn),
    employerSsnit: indexOf(mapping.employerSsnitColumn),
    tier2: indexOf(mapping.ssnitTier2Column),
    other: indexOf(mapping.otherDeductionsColumn),
    net: indexOf(mapping.netColumn),
  };
  const errors: { row: number; message: string }[] = [];
  if (columns.name < 0) errors.push({ row: 1, message: `No "${mapping.employeeNameColumn}" column in the file.` });
  if (columns.gross < 0) errors.push({ row: 1, message: `No "${mapping.grossColumn}" column in the file.` });
  if (errors.length) return { rows: [], errors, skipped: [], unbalanced: [], totals: emptyTotals() };

  const rows: PayrollRow[] = [];
  const skipped: PayrollParse['skipped'] = [];
  const unbalanced: PayrollParse['unbalanced'] = [];
  for (let index = 1; index < lines.length; index++) {
    const cells = splitCsvLine(lines[index]);
    const row = index + 1;
    const employeeName = (cells[columns.name] ?? '').trim();
    const amount = (column: number) => (column >= 0 ? parseAmountMinor(cells[column] ?? '') : 0);

    const grossRaw = amount(columns.gross);
    if (!employeeName && (grossRaw === 0 || grossRaw === null)) continue; // a blank row
    // Most payroll exports carry their own totals line. It is passed over and
    // said so, rather than silently becoming an extra member of staff.
    if (isSummaryRow(employeeName)) {
      skipped.push({ row, label: employeeName });
      continue;
    }
    if (!employeeName) {
      errors.push({ row, message: 'No name on this row.' });
      continue;
    }
    if (grossRaw === null) {
      errors.push({ row, message: `Could not read the gross pay for ${employeeName}.` });
      continue;
    }
    const readings = {
      paye: amount(columns.paye),
      employeeSsnit: amount(columns.employeeSsnit),
      employerSsnit: amount(columns.employerSsnit),
      tier2: amount(columns.tier2),
      other: amount(columns.other),
      net: columns.net >= 0 ? amount(columns.net) : null,
    };
    const unreadable = Object.entries(readings).find(([, value]) => value === null && columns.net >= 0);
    if (unreadable) {
      errors.push({ row, message: `Could not read the ${unreadable[0]} figure for ${employeeName}.` });
      continue;
    }

    const grossMinor = Math.abs(grossRaw);
    const payeMinor = Math.abs(readings.paye ?? 0);
    const employeeSsnitMinor = Math.abs(readings.employeeSsnit ?? 0);
    const employerSsnitMinor = Math.abs(readings.employerSsnit ?? 0);
    const ssnitTier2Minor = Math.abs(readings.tier2 ?? 0);
    const otherDeductionsMinor = Math.abs(readings.other ?? 0);
    const expectedMinor = grossMinor - payeMinor - employeeSsnitMinor - otherDeductionsMinor;
    const netMinor = readings.net === null ? expectedMinor : Math.abs(readings.net);
    if (readings.net !== null && netMinor !== expectedMinor) {
      unbalanced.push({ row, employeeName, expectedMinor, statedMinor: netMinor });
    }

    rows.push({
      row,
      employeeRef: columns.ref >= 0 ? (cells[columns.ref] ?? '').trim() : '',
      employeeName,
      department: columns.department >= 0 ? (cells[columns.department] ?? '').trim() : '',
      grossMinor,
      payeMinor,
      employeeSsnitMinor,
      employerSsnitMinor,
      ssnitTier2Minor,
      otherDeductionsMinor,
      netMinor,
    });
  }
  return { rows, errors, skipped, unbalanced, totals: totalsOf(rows) };
}

const summaryWords = ['total', 'totals', 'grand total', 'subtotal', 'sub-total', 'sum'];

/** A row that is the file's own total rather than a person. */
export function isSummaryRow(name: string): boolean {
  const text = name.trim().toLowerCase().replace(/[:s]+$/, '');
  return summaryWords.includes(text);
}

/**
 * Casual and seasonal labour is paid by a buying agent out of a float, not
 * through payroll. A department that looks like it is warns rather than
 * blocks: the person knows their own payroll better than a word match does.
 */
const casualWords = ['casual', 'seasonal', 'daily', 'by-day', 'temporary labour'];
export function looksLikeCasualLabour(department: string): boolean {
  const text = department.toLowerCase();
  return casualWords.some((word) => text.includes(word));
}

// --- splitting a person's cost across grants -----------------------------------------------------

export type Allocation = { employeeRef: string; grantId: string; budgetLineId: string | null; pct: string };

/** What one person's percentages come to. Anything under 100 is core-funded. */
export function allocationTotal(allocations: Pick<Allocation, 'pct'>[]): number {
  return allocations.reduce((total, allocation) => total + Number(allocation.pct), 0);
}

export type AllocatedAmount = { grantId: string | null; budgetLineId: string | null; amountMinor: number };

/**
 * Split an amount across a person's grants by percentage, the remainder left
 * uncoded. The largest share carries the rounding, so the parts always add
 * back to the whole — a donor report that is a pesewa out is a donor report
 * somebody has to explain.
 */
export function allocate(amountMinor: number, allocations: Allocation[]): AllocatedAmount[] {
  if (amountMinor === 0) return [];
  const coded = allocations.filter((allocation) => Number(allocation.pct) > 0);
  if (coded.length === 0) return [{ grantId: null, budgetLineId: null, amountMinor }];

  const parts: AllocatedAmount[] = coded.map((allocation) => ({
    grantId: allocation.grantId,
    budgetLineId: allocation.budgetLineId,
    amountMinor: Math.round((amountMinor * Number(allocation.pct)) / 100),
  }));
  const codedTotal = parts.reduce((total, part) => total + part.amountMinor, 0);
  const pctTotal = allocationTotal(coded);
  const remainder = amountMinor - codedTotal;

  if (pctTotal >= 100) {
    // Fully allocated: the rounding goes on the largest share.
    if (remainder !== 0) {
      const largest = parts.reduce((best, part) => (Math.abs(part.amountMinor) > Math.abs(best.amountMinor) ? part : best), parts[0]);
      largest.amountMinor += remainder;
    }
    return parts.filter((part) => part.amountMinor !== 0);
  }
  return [...parts, { grantId: null, budgetLineId: null, amountMinor: remainder }].filter((part) => part.amountMinor !== 0);
}

/** A line of the journal, with the grant coding it carries. */
export type PayrollJournalLine = TradingJournalLine & { grantId?: string | null; budgetLineId?: string | null };

export type CostLine = {
  /** The account this department's gross pay goes to. */
  accountCode: string;
  accountName: string;
  grossMinor: number;
  employerSsnitMinor: number;
  ssnitTier2Minor: number;
  allocations: Allocation[];
};

const nameOf = (names: Record<string, string>, code: string, fallback: string) => names[code] ?? fallback;

/**
 * The month's journal: what it cost on one side, what is owed on the other.
 * Gross pay goes to each department's own account, the employer's SSNIT to
 * its own expense, and both are split across grants where that has been set —
 * so staff costs reach the donor reports the same way a bill does.
 *
 * Net pay is a liability, not a payment. The money leaves when it leaves, and
 * that is recorded against the liability afterwards.
 */
export function payrollJournal(costs: CostLine[], totals: PayrollTotals, names: Record<string, string>): PayrollJournalLine[] {
  const lines: PayrollJournalLine[] = [];
  const push = (accountCode: string, fallback: string, amount: number, type: 'debit' | 'credit', coding?: { grantId: string | null; budgetLineId: string | null }) => {
    if (amount === 0) return;
    lines.push({ accountCode, accountName: nameOf(names, accountCode, fallback), amount, type, grantId: coding?.grantId ?? null, budgetLineId: coding?.budgetLineId ?? null });
  };

  for (const cost of costs) {
    for (const part of allocate(cost.grossMinor, cost.allocations)) {
      push(cost.accountCode, cost.accountName, part.amountMinor, 'debit', part);
    }
    for (const part of allocate(cost.employerSsnitMinor + cost.ssnitTier2Minor, cost.allocations)) {
      push(payrollAccounts.employerSsnit, 'Employer SSNIT Contributions', part.amountMinor, 'debit', part);
    }
  }

  push(payrollAccounts.paye, 'PAYE Payable', totals.payeMinor, 'credit');
  push(payrollAccounts.ssnitTier1, 'SSNIT Payable', totals.employeeSsnitMinor + totals.employerSsnitMinor, 'credit');
  push(payrollAccounts.ssnitTier2, 'SSNIT Tier 2 Payable', totals.ssnitTier2Minor, 'credit');
  push(payrollAccounts.netPay, 'Net Pay Payable', totals.netMinor + totals.otherDeductionsMinor, 'credit');
  return lines;
}

// --- what is owed, and when --------------------------------------------------------------------

export type LiabilityKind = 'paye' | 'ssnit-tier-1' | 'ssnit-tier-2' | 'net-pay' | 'other-deductions';
export const liabilityKinds: LiabilityKind[] = ['paye', 'ssnit-tier-1', 'ssnit-tier-2', 'net-pay', 'other-deductions'];
export const liabilityKindLabels: Record<LiabilityKind, string> = {
  paye: 'PAYE',
  'ssnit-tier-1': 'SSNIT tier 1',
  'ssnit-tier-2': 'SSNIT tier 2',
  'net-pay': 'Net pay to staff',
  'other-deductions': 'Other deductions',
};
export const liabilityAccounts: Record<LiabilityKind, string> = {
  paye: payrollAccounts.paye,
  'ssnit-tier-1': payrollAccounts.ssnitTier1,
  'ssnit-tier-2': payrollAccounts.ssnitTier2,
  'net-pay': payrollAccounts.netPay,
  'other-deductions': payrollAccounts.netPay,
};

/**
 * When each liability falls due. The days are settings, because filing dates
 * move and a date written into code is a date nobody can correct. Net pay is
 * due on the pay date itself: the staff are waiting.
 */
export type DueDaySettings = { payeDueDay: number; ssnitDueDay: number };

export function dueDateFor(kind: LiabilityKind, period: string, payDate: string, settings: DueDaySettings): string {
  if (kind === 'net-pay' || kind === 'other-deductions') return payDate;
  const day = kind === 'paye' ? settings.payeDueDay : settings.ssnitDueDay;
  const [year, month] = period.split('-').map(Number);
  // The month after the one the payroll is for.
  const target = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(Math.max(day, 1), lastDay));
  return target.toISOString().slice(0, 10);
}

export type Liability = {
  id: string;
  period: string;
  kind: LiabilityKind;
  amountMinor: number;
  settledMinor: number;
  dueDate: string;
};

export type LiabilityRow = Liability & { outstandingMinor: number; overdue: boolean };

export type LiabilityPosition = {
  rows: LiabilityRow[];
  outstandingMinor: number;
  overdueMinor: number;
  /** The next one to fall due, or null when nothing is outstanding. */
  next: LiabilityRow | null;
};

/** What is still owed on payroll, what is late, and what falls due next. */
export function liabilityPosition(liabilities: Liability[], asOf: string): LiabilityPosition {
  const rows: LiabilityRow[] = liabilities
    .map((liability) => {
      const outstandingMinor = Math.max(liability.amountMinor - liability.settledMinor, 0);
      return { ...liability, outstandingMinor, overdue: outstandingMinor > 0 && liability.dueDate < asOf };
    })
    .filter((row) => row.outstandingMinor > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.kind.localeCompare(b.kind));
  return {
    rows,
    outstandingMinor: rows.reduce((total, row) => total + row.outstandingMinor, 0),
    overdueMinor: rows.filter((row) => row.overdue).reduce((total, row) => total + row.outstandingMinor, 0),
    next: rows.find((row) => !row.overdue) ?? null,
  };
}

/** Paying a payroll liability: off what is owed, out of the bank. */
export function liabilityPaymentJournal(kind: LiabilityKind, amountMinor: number, bankCode: string, names: Record<string, string>): TradingJournalLine[] {
  if (amountMinor <= 0) return [];
  const code = liabilityAccounts[kind];
  return [
    { accountCode: code, accountName: nameOf(names, code, liabilityKindLabels[kind]), amount: amountMinor, type: 'debit' },
    { accountCode: bankCode, accountName: nameOf(names, bankCode, 'Bank'), amount: amountMinor, type: 'credit' },
  ];
}

/** The liabilities a month's payroll creates, in the order they fall due. */
export function liabilitiesFor(period: string, payDate: string, totals: PayrollTotals, settings: DueDaySettings): { kind: LiabilityKind; amountMinor: number; dueDate: string }[] {
  const amounts: Record<LiabilityKind, number> = {
    paye: totals.payeMinor,
    'ssnit-tier-1': totals.employeeSsnitMinor + totals.employerSsnitMinor,
    'ssnit-tier-2': totals.ssnitTier2Minor,
    'net-pay': totals.netMinor,
    'other-deductions': totals.otherDeductionsMinor,
  };
  return liabilityKinds
    .map((kind) => ({ kind, amountMinor: amounts[kind], dueDate: dueDateFor(kind, period, payDate, settings) }))
    .filter((row) => row.amountMinor > 0);
}
