/**
 * Every payroll report as a table — title, columns, rows, totals and notes —
 * defined once. The screen renders it and the Excel export writes it, so a
 * schedule cannot say one thing on screen and another in the file.
 *
 * Pure: no I/O, no Prisma, no clock.
 */

import {
  costByDepartment,
  costByEntity,
  costByProject,
  employerCostPerEmployee,
  labourCost,
  monthOnMonth,
  payeSchedule,
  reconcilePayroll,
  ssnitSchedule,
  tier3Schedule,
  yearToDate,
  type CostRow,
  type PayLineFact,
} from './payroll-reports';
import { periodLabel } from './payslip';
import type { RemittanceKind } from './payroll-run';

export type ReportColumn = { header: string; key: string; kind: 'text' | 'money' | 'number' };
export type ReportTable = {
  title: string;
  /** What the table is, what it covers, anything to put right before filing. */
  notes: string[];
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, number>;
  /** Lines to draw attention to: a TIN missing, a difference on reconciliation. */
  warnings: string[];
};

export const entityReports = ['paye', 'ssnit', 'tier3', 'cost-by-department', 'cost-by-project', 'employer-cost', 'month-on-month', 'year-to-date', 'reconciliation'] as const;
export type EntityReport = (typeof entityReports)[number];
export const groupReports = ['cost-by-entity', 'labour-cost'] as const;
export type GroupReport = (typeof groupReports)[number];

export const reportLabels: Record<EntityReport | GroupReport, string> = {
  paye: 'PAYE schedule',
  ssnit: 'SSNIT contributions',
  tier3: 'Tier 3 schedule',
  'cost-by-department': 'Cost by department',
  'cost-by-project': 'Cost by project',
  'employer-cost': 'Employer cost per employee',
  'month-on-month': 'Month on month',
  'year-to-date': 'Year to date per employee',
  reconciliation: 'Control account reconciliation',
  'cost-by-entity': 'Payroll cost by company',
  'labour-cost': 'Total labour cost',
};

const money = (header: string, key: string): ReportColumn => ({ header, key, kind: 'money' });
const text = (header: string, key: string): ReportColumn => ({ header, key, kind: 'text' });
const number = (header: string, key: string): ReportColumn => ({ header, key, kind: 'number' });

function costTable(title: string, notes: string[], first: string, rows: CostRow[]): ReportTable {
  return {
    title,
    notes,
    columns: [text(first, 'label'), number('Staff', 'headcount'), money('Gross pay', 'grossMinor'), money('Employer SSNIT and tier 2', 'employerContributionsMinor'), money('Total cost', 'totalCostMinor')],
    rows,
    totals: { grossMinor: rows.reduce((s, r) => s + r.grossMinor, 0), employerContributionsMinor: rows.reduce((s, r) => s + r.employerContributionsMinor, 0), totalCostMinor: rows.reduce((s, r) => s + r.totalCostMinor, 0) },
    warnings: [],
  };
}

const previousPeriod = (period: string) => {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export type EntityReportInput = {
  entityName: string;
  period: string;
  /** Every posted line this entity has. */
  facts: PayLineFact[];
  projectNames: Record<string, string>;
  openRemittances: { kind: RemittanceKind; amountMinor: number }[];
  ledgerBalances: Record<string, number>;
  loansOutstandingMinor: number;
};

/** One entity's report for one period (or, for year to date, the year that period is in). */
export function entityReportTable(kind: EntityReport, input: EntityReportInput): ReportTable {
  const inPeriod = input.facts.filter((f) => f.period === input.period);
  const when = `${input.entityName} — ${periodLabel(input.period)}`;
  const posted = 'From posted pay runs only.';

  switch (kind) {
    case 'paye': {
      const s = payeSchedule(inPeriod);
      return {
        title: `PAYE schedule — ${when}`,
        notes: [posted, 'Laid out after the GRA monthly PAYE return. Check the column order against the current GRA template before filing.'],
        columns: [
          text('Staff number', 'staffNumber'),
          text('Name', 'name'),
          text('TIN', 'tin'),
          text('Residency', 'residency'),
          money('Basic salary', 'basicMinor'),
          money('Taxable cash allowances', 'allowancesMinor'),
          money('Bonus', 'bonusMinor'),
          money('Overtime', 'overtimeMinor'),
          money('Benefits in kind', 'benefitsMinor'),
          money('Employee SSNIT', 'employeeSsnitMinor'),
          money('Deductible tier 3', 'tier3DeductibleMinor'),
          money('Reliefs', 'reliefsMinor'),
          money('Chargeable income', 'chargeableMinor'),
          money('Tax on chargeable income', 'incomeTaxMinor'),
          money('Tax on bonus', 'bonusTaxMinor'),
          money('Tax on overtime', 'overtimeTaxMinor'),
          money('Total PAYE deducted', 'payeMinor'),
        ],
        rows: s.rows,
        totals: s.totals,
        warnings: s.missingTin.length ? [`No TIN held for ${s.missingTin.join(', ')}. Add it before filing.`] : [],
      };
    }
    case 'ssnit': {
      const s = ssnitSchedule(inPeriod);
      return {
        title: `SSNIT contributions — ${when}`,
        notes: [posted, 'Tier 1 is the employee’s and the employer’s contributions together; tier 2 goes to the trustee. The contribution base is basic salary plus any allowance marked pensionable, capped at maximum insurable earnings.'],
        columns: [
          text('SSNIT number', 'ssnitNumber'),
          text('Name', 'name'),
          text('Staff number', 'staffNumber'),
          money('Basic salary', 'basicMinor'),
          money('Contribution base', 'contributionBaseMinor'),
          money('Employee tier 1', 'employeeTier1Minor'),
          money('Employer tier 1', 'employerTier1Minor'),
          money('Tier 1 total', 'tier1Minor'),
          money('Tier 2', 'tier2Minor'),
        ],
        rows: s.rows,
        totals: s.totals,
        warnings: s.missingSsnitNumber.length ? [`No SSNIT number held for ${s.missingSsnitNumber.join(', ')}. Add it before submitting.`] : [],
      };
    }
    case 'tier3': {
      const s = tier3Schedule(inPeriod);
      return {
        title: `Tier 3 schedule — ${when}`,
        notes: [posted, s.rows.length ? 'Voluntary contributions taken from pay, for the tier 3 provider.' : 'Nobody contributed to tier 3 this month.'],
        columns: [text('SSNIT number', 'ssnitNumber'), text('Name', 'name'), text('Staff number', 'staffNumber'), money('Basic salary', 'basicMinor'), money('Tier 3 contribution', 'tier3Minor'), money('Of which deductible for tax', 'deductibleMinor')],
        rows: s.rows,
        totals: s.totals,
        warnings: [],
      };
    }
    case 'cost-by-department':
      return costTable(`Payroll cost by department — ${when}`, [posted], 'Department', costByDepartment(inPeriod));
    case 'cost-by-project':
      return costTable(`Payroll cost by project — ${when}`, [posted, 'Split exactly as the journal charged it, so it agrees with each project’s budget against actual.'], 'Project', costByProject(inPeriod, input.projectNames));
    case 'employer-cost': {
      const rows = employerCostPerEmployee(inPeriod);
      return {
        title: `Employer cost per employee — ${when}`,
        notes: [posted, 'Gross pay plus everything the employer pays on top of it.'],
        columns: [text('Staff number', 'staffNumber'), text('Name', 'name'), text('Department', 'department'), money('Gross pay', 'grossMinor'), money('Employer SSNIT', 'employerSsnitMinor'), money('Tier 2', 'employerTier2Minor'), money('Total cost', 'totalCostMinor')],
        rows,
        totals: { grossMinor: rows.reduce((s, r) => s + r.grossMinor, 0), employerSsnitMinor: rows.reduce((s, r) => s + r.employerSsnitMinor, 0), employerTier2Minor: rows.reduce((s, r) => s + r.employerTier2Minor, 0), totalCostMinor: rows.reduce((s, r) => s + r.totalCostMinor, 0) },
        warnings: [],
      };
    }
    case 'month-on-month': {
      const before = previousPeriod(input.period);
      const m = monthOnMonth(input.facts.filter((f) => f.period === before), inPeriod);
      const rows = [
        ...m.joiners.map((j) => ({ change: 'Joined', name: j.name, staffNumber: j.staffNumber, detail: `Started ${j.startDate}`, beforeMinor: null, afterMinor: j.grossMinor })),
        ...m.leavers.map((l) => ({ change: 'Left', name: l.name, staffNumber: l.staffNumber, detail: l.endDate ? `Left ${l.endDate}` : 'Not paid this month', beforeMinor: l.lastGrossMinor, afterMinor: null })),
        ...m.payChanges.map((p) => ({
          change: 'Pay changed',
          name: p.name,
          staffNumber: p.staffNumber,
          detail: p.basicBeforeMinor !== p.basicAfterMinor ? `Basic ${(p.basicBeforeMinor / 100).toFixed(2)} → ${(p.basicAfterMinor / 100).toFixed(2)}` : 'Allowances or variable pay',
          beforeMinor: p.grossBeforeMinor,
          afterMinor: p.grossAfterMinor,
        })),
      ];
      return {
        title: `Month on month — ${periodLabel(before)} to ${periodLabel(input.period)} — ${input.entityName}`,
        notes: [
          posted,
          `${periodLabel(before)}: ${m.before.headcount} paid, gross ${(m.before.grossMinor / 100).toFixed(2)}, cost ${(m.before.employerCostMinor / 100).toFixed(2)}.`,
          `${periodLabel(input.period)}: ${m.after.headcount} paid, gross ${(m.after.grossMinor / 100).toFixed(2)}, cost ${(m.after.employerCostMinor / 100).toFixed(2)}.`,
        ],
        columns: [text('Change', 'change'), text('Name', 'name'), text('Staff number', 'staffNumber'), text('Detail', 'detail'), money('Gross before', 'beforeMinor'), money('Gross after', 'afterMinor')],
        rows,
        warnings: [],
      };
    }
    case 'year-to-date': {
      const year = input.period.slice(0, 4);
      const rows = yearToDate(input.facts, year, input.period);
      const fields = ['basicMinor', 'allowancesMinor', 'bonusMinor', 'overtimeMinor', 'benefitsMinor', 'grossMinor', 'employeeSsnitMinor', 'tier3Minor', 'reliefsMinor', 'chargeableMinor', 'payeMinor', 'netMinor', 'employerSsnitMinor', 'employerTier2Minor'] as const;
      return {
        title: `Year to date per employee — ${input.entityName} — January to ${periodLabel(input.period)}`,
        notes: [posted, 'For the annual employer return: every posted month of the year, per employee.'],
        columns: [
          text('Staff number', 'staffNumber'),
          text('Name', 'name'),
          text('TIN', 'tin'),
          text('SSNIT number', 'ssnitNumber'),
          number('Months paid', 'monthsPaid'),
          money('Basic salary', 'basicMinor'),
          money('Cash allowances', 'allowancesMinor'),
          money('Bonus', 'bonusMinor'),
          money('Overtime', 'overtimeMinor'),
          money('Benefits in kind', 'benefitsMinor'),
          money('Gross pay', 'grossMinor'),
          money('Employee SSNIT', 'employeeSsnitMinor'),
          money('Tier 3', 'tier3Minor'),
          money('Reliefs', 'reliefsMinor'),
          money('Chargeable income', 'chargeableMinor'),
          money('PAYE', 'payeMinor'),
          money('Net pay', 'netMinor'),
          money('Employer SSNIT', 'employerSsnitMinor'),
          money('Tier 2', 'employerTier2Minor'),
        ],
        rows,
        totals: Object.fromEntries(fields.map((f) => [f, rows.reduce((s, r) => s + r[f], 0)])),
        warnings: rows.filter((r) => !r.tin).length ? [`No TIN held for ${rows.filter((r) => !r.tin).map((r) => r.name).join(', ')}.`] : [],
      };
    }
    case 'reconciliation': {
      const rows = reconcilePayroll(input.ledgerBalances, input.openRemittances, input.loansOutstandingMinor);
      const off = rows.filter((r) => !r.agrees);
      return {
        title: `Payroll control accounts — ${input.entityName} — as the ledger stands`,
        notes: [
          'Each payroll account in the general ledger against what the payroll records say is owed: posted runs less remittances paid, and for staff loans what was lent less instalments taken.',
          'A difference means something reached one side and not the other — a journal entered by hand against a payroll account, or a payment made at the bank but not recorded against the remittance.',
        ],
        columns: [text('Account', 'accountCode'), text('', 'label'), money('Ledger', 'ledgerMinor'), money('Payroll records', 'recordsMinor'), money('Difference', 'differenceMinor'), text('', 'status')],
        rows: rows.map(({ agrees, ...r }) => ({ ...r, status: agrees ? 'Agrees' : 'DIFFERENCE' })),
        warnings: off.map((r) => `${r.accountCode} ${r.label}: the ledger shows ${(r.ledgerMinor / 100).toFixed(2)}, the payroll records ${(r.recordsMinor / 100).toFixed(2)} — a difference of ${(r.differenceMinor / 100).toFixed(2)}.`),
      };
    }
  }
}

export type GroupReportInput = {
  from: string;
  to: string;
  entityNames: Record<string, string>;
  facts: PayLineFact[];
  casual: { entityId: string; date: string; amountMinor: number; workers: number | null }[];
};

/** Across the companies the person can see, for a span of periods. */
export function groupReportTable(kind: GroupReport, input: GroupReportInput): ReportTable {
  const facts = input.facts.filter((f) => f.period >= input.from && f.period <= input.to);
  const span = input.from === input.to ? periodLabel(input.from) : `${periodLabel(input.from)} to ${periodLabel(input.to)}`;
  if (kind === 'cost-by-entity') {
    return costTable(`Payroll cost by company — ${span}`, ['From posted pay runs only. A management view, not a consolidation.'], 'Company', costByEntity(facts, input.entityNames));
  }
  const casual = input.casual.filter((c) => c.date.slice(0, 7) >= input.from && c.date.slice(0, 7) <= input.to);
  const result = labourCost(facts, casual, input.entityNames);
  return {
    title: `Total labour cost — ${span}`,
    notes: [
      'Payroll (gross pay and the employer’s contributions, from posted pay runs) beside casual and seasonal labour paid by buying agents out of their floats.',
      'The two are kept apart in the books — casual labour is not payroll — and brought together only here.',
    ],
    columns: [
      text('Company', 'entityName'),
      money('Payroll gross', 'payrollGrossMinor'),
      money('Employer contributions', 'payrollEmployerMinor'),
      money('Payroll total', 'payrollTotalMinor'),
      money('Casual labour (agent floats)', 'casualLabourMinor'),
      number('Casual workers paid', 'casualWorkers'),
      money('Total labour cost', 'totalLabourMinor'),
    ],
    rows: result.rows,
    totals: result.totals,
    warnings: [],
  };
}
