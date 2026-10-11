/**
 * Payroll reports, all read from what pay runs actually posted.
 *
 * Statutory schedules (per entity, per period): PAYE for GRA, SSNIT tiers 1
 * and 2, tier 3. Management: cost by entity, department and project; month on
 * month with joiners, leavers and pay changes; employer cost per employee;
 * year to date per employee for the annual employer return. Control: the
 * payroll accounts in the ledger reconciled to the payroll records. Labour:
 * payroll and casual labour paid from agents' floats, side by side.
 *
 * Only POSTED runs count. A draft has not happened, an approved run has not
 * reached the ledger, and a reversed run was undone — it stays on record but
 * out of every figure here.
 *
 * Pure: no I/O, no Prisma, no clock.
 */

import type { PayInput, PayResult } from './payroll-engine';
import { payrollAccounts } from './payroll-accounts';
import { remittanceAccounts, remittanceLabels, splitByShares, type RemittanceKind } from './payroll-run';

/** One employee's posted pay for one period, as the reports need it. */
export type PayLineFact = {
  entityId: string;
  runId: string;
  period: string;
  employeeId: string;
  staffNumber: string;
  name: string;
  department: string | null;
  tin: string | null;
  ssnitNumber: string | null;
  residency: 'resident' | 'non-resident';
  startDate: string;
  endDate: string | null;
  daysEmployed: number;
  /** Paid for every day of the period: not a joiner's or a leaver's part month. */
  fullPeriod: boolean;
  /** The monthly basic on the contract, before any proration. */
  contractualBasicMinor: number;
  /** Basic actually paid this period. */
  basicMinor: number;
  /** Cash allowances, taxable and not. */
  allowancesMinor: number;
  nonTaxableMinor: number;
  bonusMinor: number;
  overtimeMinor: number;
  grossMinor: number;
  benefitsMinor: number;
  ssnitBaseMinor: number;
  employeeSsnitMinor: number;
  tier3Minor: number;
  tier3DeductibleMinor: number;
  reliefsMinor: number;
  chargeableMinor: number;
  incomeTaxMinor: number;
  bonusTaxMinor: number;
  overtimeTaxMinor: number;
  payeMinor: number;
  deductionsMinor: number;
  netMinor: number;
  employerSsnitMinor: number;
  employerTier2Minor: number;
  /** The project split the run used. */
  allocations: { projectId: string; shareBasisPoints: number }[];
};

/** A calculated pay line as the reports see it. The one place the conversion is written. */
export function factOf(args: {
  entityId: string;
  runId: string;
  employee: { id: string; staffNumber: string; name: string; department: string | null; tin: string | null; ssnitNumber: string | null; startDate: string; endDate: string | null };
  input: PayInput;
  result: PayResult;
  allocations: { projectId: string; shareBasisPoints: number }[];
}): PayLineFact {
  const { result, employee } = args;
  return {
    entityId: args.entityId,
    runId: args.runId,
    period: result.period,
    employeeId: employee.id,
    staffNumber: employee.staffNumber,
    name: employee.name,
    department: employee.department,
    tin: employee.tin,
    ssnitNumber: employee.ssnitNumber,
    residency: args.input.employee.residency,
    startDate: employee.startDate,
    endDate: employee.endDate,
    daysEmployed: result.daysEmployed,
    fullPeriod: result.daysEmployed === result.daysInPeriod,
    contractualBasicMinor: args.input.basicMinor,
    basicMinor: result.basicMinor,
    allowancesMinor: result.allowancesMinor,
    nonTaxableMinor: result.nonTaxableAllowancesMinor,
    bonusMinor: result.bonusMinor,
    overtimeMinor: result.overtimeMinor,
    grossMinor: result.grossMinor,
    benefitsMinor: result.benefitsInKindMinor,
    ssnitBaseMinor: result.ssnitBaseMinor,
    employeeSsnitMinor: result.employeeSsnitMinor,
    tier3Minor: result.tier3Minor,
    tier3DeductibleMinor: result.tier3DeductibleMinor,
    reliefsMinor: result.reliefsMinor,
    chargeableMinor: result.chargeableMinor,
    incomeTaxMinor: result.incomeTaxMinor,
    bonusTaxMinor: result.bonusTaxMinor,
    overtimeTaxMinor: result.overtimeTaxMinor,
    payeMinor: result.payeMinor,
    deductionsMinor: result.deductionsMinor,
    netMinor: result.netMinor,
    employerSsnitMinor: result.employerSsnitMinor,
    employerTier2Minor: result.employerTier2Minor,
    allocations: args.allocations,
  };
}

const sum = <T>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);
const employerContributions = (line: PayLineFact) => line.employerSsnitMinor + line.employerTier2Minor;
const employerCost = (line: PayLineFact) => line.grossMinor + employerContributions(line);

// --- statutory schedules ------------------------------------------------------------------------

export type PayeScheduleRow = {
  staffNumber: string;
  name: string;
  tin: string;
  residency: string;
  basicMinor: number;
  /** Taxable cash allowances. */
  allowancesMinor: number;
  bonusMinor: number;
  overtimeMinor: number;
  benefitsMinor: number;
  employeeSsnitMinor: number;
  tier3DeductibleMinor: number;
  reliefsMinor: number;
  chargeableMinor: number;
  incomeTaxMinor: number;
  bonusTaxMinor: number;
  overtimeTaxMinor: number;
  payeMinor: number;
};

/**
 * The monthly PAYE schedule for GRA: every employee with their TIN, what made
 * up their chargeable income and the tax deducted. Anyone without a TIN is
 * listed with it blank and named in `missingTin`, to be put right before filing.
 */
export function payeSchedule(lines: PayLineFact[]): { rows: PayeScheduleRow[]; totals: Omit<PayeScheduleRow, 'staffNumber' | 'name' | 'tin' | 'residency'>; missingTin: string[] } {
  const rows = [...lines]
    .sort((a, b) => a.staffNumber.localeCompare(b.staffNumber))
    .map((line) => ({
      staffNumber: line.staffNumber,
      name: line.name,
      tin: line.tin ?? '',
      residency: line.residency === 'resident' ? 'Resident' : 'Non-resident',
      basicMinor: line.basicMinor,
      allowancesMinor: line.allowancesMinor - line.nonTaxableMinor,
      bonusMinor: line.bonusMinor,
      overtimeMinor: line.overtimeMinor,
      benefitsMinor: line.benefitsMinor,
      employeeSsnitMinor: line.employeeSsnitMinor,
      tier3DeductibleMinor: line.tier3DeductibleMinor,
      reliefsMinor: line.reliefsMinor,
      chargeableMinor: line.chargeableMinor,
      incomeTaxMinor: line.incomeTaxMinor,
      bonusTaxMinor: line.bonusTaxMinor,
      overtimeTaxMinor: line.overtimeTaxMinor,
      payeMinor: line.payeMinor,
    }));
  const fields = ['basicMinor', 'allowancesMinor', 'bonusMinor', 'overtimeMinor', 'benefitsMinor', 'employeeSsnitMinor', 'tier3DeductibleMinor', 'reliefsMinor', 'chargeableMinor', 'incomeTaxMinor', 'bonusTaxMinor', 'overtimeTaxMinor', 'payeMinor'] as const;
  const totals = Object.fromEntries(fields.map((field) => [field, sum(rows, (row) => row[field])])) as Record<(typeof fields)[number], number>;
  return { rows, totals, missingTin: rows.filter((row) => !row.tin).map((row) => row.name) };
}

export type SsnitScheduleRow = {
  ssnitNumber: string;
  name: string;
  staffNumber: string;
  /** Basic salary paid this period. */
  basicMinor: number;
  /** What contributions were charged on: basic plus pensionable allowances, capped. */
  contributionBaseMinor: number;
  employeeTier1Minor: number;
  employerTier1Minor: number;
  tier1Minor: number;
  tier2Minor: number;
};

/** SSNIT tier 1 and tier 2 for the period, one row per employee, with anyone missing an SSNIT number named. */
export function ssnitSchedule(lines: PayLineFact[]) {
  const rows: SsnitScheduleRow[] = [...lines]
    .sort((a, b) => a.staffNumber.localeCompare(b.staffNumber))
    .map((line) => ({
      ssnitNumber: line.ssnitNumber ?? '',
      name: line.name,
      staffNumber: line.staffNumber,
      basicMinor: line.basicMinor,
      contributionBaseMinor: line.ssnitBaseMinor,
      employeeTier1Minor: line.employeeSsnitMinor,
      employerTier1Minor: line.employerSsnitMinor,
      tier1Minor: line.employeeSsnitMinor + line.employerSsnitMinor,
      tier2Minor: line.employerTier2Minor,
    }));
  return {
    rows,
    totals: {
      basicMinor: sum(rows, (r) => r.basicMinor),
      contributionBaseMinor: sum(rows, (r) => r.contributionBaseMinor),
      employeeTier1Minor: sum(rows, (r) => r.employeeTier1Minor),
      employerTier1Minor: sum(rows, (r) => r.employerTier1Minor),
      tier1Minor: sum(rows, (r) => r.tier1Minor),
      tier2Minor: sum(rows, (r) => r.tier2Minor),
    },
    missingSsnitNumber: rows.filter((row) => !row.ssnitNumber).map((row) => row.name),
  };
}

/** Tier 3: only the employees who contributed. Empty where nobody did. */
export function tier3Schedule(lines: PayLineFact[]) {
  const rows = lines
    .filter((line) => line.tier3Minor > 0)
    .sort((a, b) => a.staffNumber.localeCompare(b.staffNumber))
    .map((line) => ({ ssnitNumber: line.ssnitNumber ?? '', name: line.name, staffNumber: line.staffNumber, basicMinor: line.basicMinor, tier3Minor: line.tier3Minor, deductibleMinor: line.tier3DeductibleMinor }));
  return { rows, totals: { tier3Minor: sum(rows, (r) => r.tier3Minor), deductibleMinor: sum(rows, (r) => r.deductibleMinor) } };
}

// --- cost ----------------------------------------------------------------------------------------

export type CostRow = { key: string; label: string; headcount: number; grossMinor: number; employerContributionsMinor: number; totalCostMinor: number };

function costRows(groups: Map<string, { label: string; employees: Set<string>; gross: number; employer: number }>): CostRow[] {
  return [...groups.entries()]
    .map(([key, g]) => ({ key, label: g.label, headcount: g.employees.size, grossMinor: g.gross, employerContributionsMinor: g.employer, totalCostMinor: g.gross + g.employer }))
    .sort((a, b) => b.totalCostMinor - a.totalCostMinor || a.label.localeCompare(b.label));
}

function group(lines: PayLineFact[], keyOf: (line: PayLineFact) => { key: string; label: string }) {
  const groups = new Map<string, { label: string; employees: Set<string>; gross: number; employer: number }>();
  for (const line of lines) {
    const { key, label } = keyOf(line);
    const g = groups.get(key) ?? { label, employees: new Set<string>(), gross: 0, employer: 0 };
    g.employees.add(line.employeeId);
    g.gross += line.grossMinor;
    g.employer += employerContributions(line);
    groups.set(key, g);
  }
  return costRows(groups);
}

/** Payroll cost per entity, for the group view. */
export function costByEntity(lines: PayLineFact[], entityNames: Record<string, string>): CostRow[] {
  return group(lines, (line) => ({ key: line.entityId, label: entityNames[line.entityId] ?? line.entityId }));
}

export function costByDepartment(lines: PayLineFact[]): CostRow[] {
  return group(lines, (line) => ({ key: line.department ?? '', label: line.department || 'No department' }));
}

/**
 * Cost per project, split exactly as the journal split it — gross and the
 * employer's contributions, the parts adding back to the whole. A person with
 * no split is "Not charged to a project".
 */
export function costByProject(lines: PayLineFact[], projectNames: Record<string, string>): CostRow[] {
  const groups = new Map<string, { label: string; employees: Set<string>; gross: number; employer: number }>();
  const add = (key: string, employeeId: string, gross: number, employer: number) => {
    const g = groups.get(key) ?? { label: key ? (projectNames[key] ?? key) : 'Not charged to a project', employees: new Set<string>(), gross: 0, employer: 0 };
    g.employees.add(employeeId);
    g.gross += gross;
    g.employer += employer;
    groups.set(key, g);
  };
  for (const line of lines) {
    if (line.allocations.length === 0) {
      add('', line.employeeId, line.grossMinor, employerContributions(line));
      continue;
    }
    const shares = line.allocations.map((a) => ({ key: a.projectId, shareBasisPoints: a.shareBasisPoints }));
    const gross = new Map(splitByShares(line.grossMinor, shares).map((p) => [p.key, p.amountMinor]));
    const employer = new Map(splitByShares(employerContributions(line), shares).map((p) => [p.key, p.amountMinor]));
    for (const share of shares) add(share.key, line.employeeId, gross.get(share.key) ?? 0, employer.get(share.key) ?? 0);
  }
  return costRows(groups);
}

/** Every employee's cost to the employer for the period, contributions and all. */
export function employerCostPerEmployee(lines: PayLineFact[]) {
  return [...lines]
    .sort((a, b) => employerCost(b) - employerCost(a) || a.staffNumber.localeCompare(b.staffNumber))
    .map((line) => ({
      staffNumber: line.staffNumber,
      name: line.name,
      department: line.department ?? '',
      grossMinor: line.grossMinor,
      employerSsnitMinor: line.employerSsnitMinor,
      employerTier2Minor: line.employerTier2Minor,
      totalCostMinor: employerCost(line),
    }));
}

// --- month on month ------------------------------------------------------------------------------

export type MonthOnMonth = {
  joiners: { name: string; staffNumber: string; startDate: string; grossMinor: number }[];
  leavers: { name: string; staffNumber: string; endDate: string | null; lastGrossMinor: number }[];
  payChanges: { name: string; staffNumber: string; basicBeforeMinor: number; basicAfterMinor: number; grossBeforeMinor: number; grossAfterMinor: number }[];
  before: { headcount: number; grossMinor: number; employerCostMinor: number };
  after: { headcount: number; grossMinor: number; employerCostMinor: number };
};

/**
 * Two consecutive posted periods side by side. A joiner is paid this month
 * and was not last month; a leaver was paid last month and is not this month,
 * or leaves part way through this one. A pay change is a different contractual
 * basic, or a different gross for someone paid a full month both times — a
 * part month is not a pay change, it is a joiner or a leaver.
 */
export function monthOnMonth(previous: PayLineFact[], current: PayLineFact[]): MonthOnMonth {
  const before = new Map(previous.map((line) => [line.employeeId, line]));
  const after = new Map(current.map((line) => [line.employeeId, line]));
  const period = current[0]?.period ?? '';
  const joiners = current.filter((line) => !before.has(line.employeeId)).map((line) => ({ name: line.name, staffNumber: line.staffNumber, startDate: line.startDate, grossMinor: line.grossMinor }));
  const leftMidMonth = current.filter((line) => line.endDate !== null && line.endDate.startsWith(period));
  const gone = previous.filter((line) => !after.has(line.employeeId));
  const leavers = [...gone.map((line) => ({ name: line.name, staffNumber: line.staffNumber, endDate: line.endDate, lastGrossMinor: line.grossMinor })), ...leftMidMonth.map((line) => ({ name: line.name, staffNumber: line.staffNumber, endDate: line.endDate, lastGrossMinor: line.grossMinor }))];
  // A different contractual basic is always a pay change. A different gross
  // is one only when both months were paid in full — otherwise it is a part
  // month, already shown as a joiner or a leaver.
  const payChanges = current
    .filter((line) => before.has(line.employeeId) && !leftMidMonth.includes(line))
    .map((line) => ({ line, prior: before.get(line.employeeId)! }))
    .filter(({ line, prior }) => line.contractualBasicMinor !== prior.contractualBasicMinor || (line.fullPeriod && prior.fullPeriod && line.grossMinor !== prior.grossMinor))
    .map(({ line, prior }) => ({
      name: line.name,
      staffNumber: line.staffNumber,
      basicBeforeMinor: prior.contractualBasicMinor,
      basicAfterMinor: line.contractualBasicMinor,
      grossBeforeMinor: prior.grossMinor,
      grossAfterMinor: line.grossMinor,
    }));
  const summary = (lines: PayLineFact[]) => ({ headcount: lines.length, grossMinor: sum(lines, (l) => l.grossMinor), employerCostMinor: sum(lines, employerCost) });
  return { joiners, leavers, payChanges, before: summary(previous), after: summary(current) };
}

// --- year to date --------------------------------------------------------------------------------

export type YearToDateRow = {
  staffNumber: string;
  name: string;
  tin: string;
  ssnitNumber: string;
  monthsPaid: number;
  basicMinor: number;
  allowancesMinor: number;
  bonusMinor: number;
  overtimeMinor: number;
  benefitsMinor: number;
  grossMinor: number;
  employeeSsnitMinor: number;
  tier3Minor: number;
  reliefsMinor: number;
  chargeableMinor: number;
  payeMinor: number;
  netMinor: number;
  employerSsnitMinor: number;
  employerTier2Minor: number;
};

/** Per employee, everything posted in the year to date: what the annual employer return needs. */
export function yearToDate(lines: PayLineFact[], year: string, throughPeriod: string): YearToDateRow[] {
  const inYear = lines.filter((line) => line.period.startsWith(`${year}-`) && line.period <= throughPeriod);
  const byEmployee = new Map<string, PayLineFact[]>();
  for (const line of inYear) byEmployee.set(line.employeeId, [...(byEmployee.get(line.employeeId) ?? []), line]);
  return [...byEmployee.values()]
    .map((rows) => {
      const latest = rows.reduce((a, b) => (a.period > b.period ? a : b));
      return {
        staffNumber: latest.staffNumber,
        name: latest.name,
        tin: latest.tin ?? '',
        ssnitNumber: latest.ssnitNumber ?? '',
        monthsPaid: new Set(rows.map((r) => r.period)).size,
        basicMinor: sum(rows, (r) => r.basicMinor),
        allowancesMinor: sum(rows, (r) => r.allowancesMinor),
        bonusMinor: sum(rows, (r) => r.bonusMinor),
        overtimeMinor: sum(rows, (r) => r.overtimeMinor),
        benefitsMinor: sum(rows, (r) => r.benefitsMinor),
        grossMinor: sum(rows, (r) => r.grossMinor),
        employeeSsnitMinor: sum(rows, (r) => r.employeeSsnitMinor),
        tier3Minor: sum(rows, (r) => r.tier3Minor),
        reliefsMinor: sum(rows, (r) => r.reliefsMinor),
        chargeableMinor: sum(rows, (r) => r.chargeableMinor),
        payeMinor: sum(rows, (r) => r.payeMinor),
        netMinor: sum(rows, (r) => r.netMinor),
        employerSsnitMinor: sum(rows, (r) => r.employerSsnitMinor),
        employerTier2Minor: sum(rows, (r) => r.employerTier2Minor),
      };
    })
    .sort((a, b) => a.staffNumber.localeCompare(b.staffNumber));
}

// --- reconciliation ------------------------------------------------------------------------------

export type ReconciliationRow = {
  accountCode: string;
  label: string;
  /** What the ledger says is owed (or, for staff loans, owed to us). */
  ledgerMinor: number;
  /** What the payroll records say. */
  recordsMinor: number;
  differenceMinor: number;
  agrees: boolean;
};

/**
 * The payroll control accounts in the general ledger against the payroll
 * records. For each liability, the records' figure is what posted runs left
 * owing less what has been paid — the remittances still open. For staff loans
 * it is the principal lent less instalments taken on posted runs. Any
 * difference means something reached one side and not the other: a journal
 * entered by hand against a payroll account, say, or a payment recorded at
 * the bank but not against the remittance.
 *
 * `ledgerBalances` is the balance of each account as of the date, positive
 * for the normal side: credit for a liability, debit for staff loans.
 */
export function reconcilePayroll(
  ledgerBalances: Record<string, number>,
  openRemittances: { kind: RemittanceKind; amountMinor: number }[],
  loansOutstandingMinor: number,
): ReconciliationRow[] {
  const owed = (kinds: RemittanceKind[]) => sum(openRemittances.filter((r) => kinds.includes(r.kind)), (r) => r.amountMinor);
  const rows: { accountCode: string; label: string; recordsMinor: number }[] = [
    { accountCode: remittanceAccounts['net-pay'], label: 'Net pay payable', recordsMinor: owed(['net-pay']) },
    { accountCode: remittanceAccounts.paye, label: 'PAYE payable', recordsMinor: owed(['paye']) },
    { accountCode: remittanceAccounts['ssnit-tier1'], label: 'SSNIT tier 1 payable', recordsMinor: owed(['ssnit-tier1']) },
    { accountCode: remittanceAccounts['ssnit-tier2'], label: 'SSNIT tier 2 payable', recordsMinor: owed(['ssnit-tier2']) },
    { accountCode: remittanceAccounts.tier3, label: 'Tier 3 payable', recordsMinor: owed(['tier3']) },
    { accountCode: payrollAccounts.staffLoans, label: 'Staff loans and advances', recordsMinor: loansOutstandingMinor },
  ];
  return rows.map((row) => {
    const ledgerMinor = ledgerBalances[row.accountCode] ?? 0;
    const differenceMinor = ledgerMinor - row.recordsMinor;
    return { ...row, ledgerMinor, differenceMinor, agrees: differenceMinor === 0 };
  });
}

// --- total labour cost ---------------------------------------------------------------------------

export type LabourCostRow = {
  entityId: string;
  entityName: string;
  payrollGrossMinor: number;
  payrollEmployerMinor: number;
  payrollTotalMinor: number;
  casualLabourMinor: number;
  casualWorkers: number;
  totalLabourMinor: number;
};

/**
 * Everything each entity spent on labour over a span: payroll (gross and the
 * employer's contributions, from posted runs) and casual and seasonal labour
 * paid by buying agents out of their floats. Two sources, never mixed in the
 * ledger, brought together here only.
 */
export function labourCost(
  payLines: PayLineFact[],
  casual: { entityId: string; amountMinor: number; workers: number | null }[],
  entityNames: Record<string, string>,
): { rows: LabourCostRow[]; totals: Omit<LabourCostRow, 'entityId' | 'entityName'> } {
  const ids = [...new Set([...payLines.map((l) => l.entityId), ...casual.map((c) => c.entityId)])].sort((a, b) => (entityNames[a] ?? a).localeCompare(entityNames[b] ?? b));
  const rows = ids.map((entityId) => {
    const lines = payLines.filter((l) => l.entityId === entityId);
    const paid = casual.filter((c) => c.entityId === entityId);
    const payrollGrossMinor = sum(lines, (l) => l.grossMinor);
    const payrollEmployerMinor = sum(lines, employerContributions);
    const casualLabourMinor = sum(paid, (c) => c.amountMinor);
    return {
      entityId,
      entityName: entityNames[entityId] ?? entityId,
      payrollGrossMinor,
      payrollEmployerMinor,
      payrollTotalMinor: payrollGrossMinor + payrollEmployerMinor,
      casualLabourMinor,
      casualWorkers: sum(paid, (c) => c.workers ?? 0),
      totalLabourMinor: payrollGrossMinor + payrollEmployerMinor + casualLabourMinor,
    };
  });
  return {
    rows,
    totals: {
      payrollGrossMinor: sum(rows, (r) => r.payrollGrossMinor),
      payrollEmployerMinor: sum(rows, (r) => r.payrollEmployerMinor),
      payrollTotalMinor: sum(rows, (r) => r.payrollTotalMinor),
      casualLabourMinor: sum(rows, (r) => r.casualLabourMinor),
      casualWorkers: sum(rows, (r) => r.casualWorkers),
      totalLabourMinor: sum(rows, (r) => r.totalLabourMinor),
    },
  };
}

export { remittanceLabels };
