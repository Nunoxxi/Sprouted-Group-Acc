/**
 * The donor report as a workbook. It is laid out for the donor, not for us:
 * their currency first, their reporting periods, their budget lines, and
 * separate sheets for the in-kind contributions and staff time they usually
 * ask about.
 *
 * Amounts are ordinary decimals in the sheet, never minor units.
 */

import ExcelJS from 'exceljs';

import type { DonorReport } from '../../app/actions/grants';
import type { Currency } from '../fx';
import { elapsedFraction, incomePolicyLabels, inKindKindLabels, reportingFrequencyLabels } from '../grants';

const money = (minor: number) => Math.round(minor) / 100;

const statusWords: Record<string, string> = {
  'on-track': 'On track',
  over: 'Overspent',
  under: 'Significantly underspent',
  unbudgeted: 'Not budgeted',
};

function header(sheet: ExcelJS.Worksheet, columns: { header: string; key: string; width: number }[]) {
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1EC' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

/** The donor report workbook: summary, budget against actual, periods, in-kind, staff time. */
export async function buildDonorWorkbook(report: DonorReport, entityName: string, functionalCurrency: Currency): Promise<Buffer> {
  const { grant, comparison, periods, inKind, staffTime } = report;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sprouted Accounting';
  const donor = grant.currency;

  // --- summary -------------------------------------------------------------
  const summary = wb.addWorksheet('Summary');
  summary.getColumn(1).width = 38;
  summary.getColumn(2).width = 46;
  const rows: [string, string | number][] = [
    ['Grant', `${grant.code} — ${grant.name}`],
    ['Donor', grant.donorName],
    ['Reported by', entityName],
    ['Period covered', comparison.lines.length ? `${grant.startDate} to ${grant.endDate}` : ''],
    ['Reporting', reportingFrequencyLabels[grant.reportingFrequency]],
    ['Funds', grant.restricted ? 'Restricted' : 'Unrestricted'],
    ['Income recognition', incomePolicyLabels[grant.incomePolicy]],
    [`Award (${donor})`, money(grant.amountMinor)],
    [`Exchange rate (${functionalCurrency} per 1 ${donor})`, grant.rate],
    [`Award (${functionalCurrency})`, money(Math.round(grant.amountMinor * Number(grant.rate)))],
    [`Received to date (${functionalCurrency})`, money(grant.receivedMinor)],
    [`Recognised as income (${functionalCurrency})`, money(grant.incomePolicy === 'deferred' ? grant.releasedMinor : grant.receivedMinor)],
    [`Held as deferred income (${functionalCurrency})`, money(grant.incomePolicy === 'deferred' ? grant.receivedMinor - grant.releasedMinor : 0)],
    [`Spent to date (${functionalCurrency})`, money(comparison.totals.actualFunctionalMinor)],
    [`Spent to date (${donor})`, money(comparison.totals.actualDonorMinor)],
    ['Share of the grant period elapsed', `${Math.round(elapsedFraction(grant, new Date().toISOString().slice(0, 10)) * 100)}%`],
    [`In-kind contributions (${functionalCurrency})`, money(inKind.reduce((total, row) => total + row.valueMinor, 0))],
    [`Staff time charged (${functionalCurrency})`, money(staffTime.reduce((total, row) => total + row.valueMinor, 0))],
  ];
  for (const [label, value] of rows) {
    const row = summary.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    if (typeof value === 'number') row.getCell(2).numFmt = '#,##0.00';
  }

  // --- budget against actual -------------------------------------------------
  const budget = wb.addWorksheet('Budget vs actual');
  header(budget, [
    { header: 'Line', key: 'code', width: 12 },
    { header: 'Description', key: 'name', width: 38 },
    { header: `Budget (${donor})`, key: 'budgetDonor', width: 16 },
    { header: `Actual (${donor})`, key: 'actualDonor', width: 16 },
    { header: `Variance (${donor})`, key: 'varianceDonor', width: 16 },
    { header: '% spent', key: 'spent', width: 10 },
    { header: `Budget (${functionalCurrency})`, key: 'budgetFunctional', width: 18 },
    { header: `Actual (${functionalCurrency})`, key: 'actualFunctional', width: 18 },
    { header: `Variance (${functionalCurrency})`, key: 'varianceFunctional', width: 18 },
    { header: 'Status', key: 'status', width: 26 },
  ]);
  for (const line of comparison.lines) {
    const row = budget.addRow({
      code: line.code,
      name: line.name,
      budgetDonor: money(line.budgetDonorMinor),
      actualDonor: money(line.actualDonorMinor),
      varianceDonor: money(line.varianceDonorMinor),
      spent: line.spentFraction,
      budgetFunctional: money(line.budgetFunctionalMinor),
      actualFunctional: money(line.actualFunctionalMinor),
      varianceFunctional: money(line.varianceFunctionalMinor),
      status: statusWords[line.status] ?? line.status,
    });
    for (const key of ['budgetDonor', 'actualDonor', 'varianceDonor', 'budgetFunctional', 'actualFunctional', 'varianceFunctional']) row.getCell(key).numFmt = '#,##0.00';
    row.getCell('spent').numFmt = '0%';
    if (line.status === 'over' || line.status === 'unbudgeted') row.getCell('status').font = { color: { argb: 'FFB91C1C' }, bold: true };
    if (line.status === 'under') row.getCell('status').font = { color: { argb: 'FFB45309' } };
  }
  const totals = budget.addRow({
    code: '',
    name: 'Total',
    budgetDonor: money(comparison.totals.budgetDonorMinor),
    actualDonor: money(comparison.totals.actualDonorMinor),
    varianceDonor: money(comparison.totals.varianceDonorMinor),
    spent: comparison.totals.spentFraction,
    budgetFunctional: money(comparison.totals.budgetFunctionalMinor),
    actualFunctional: money(comparison.totals.actualFunctionalMinor),
    varianceFunctional: money(comparison.totals.varianceFunctionalMinor),
    status: statusWords[comparison.totals.status] ?? '',
  });
  totals.font = { bold: true };
  for (const key of ['budgetDonor', 'actualDonor', 'varianceDonor', 'budgetFunctional', 'actualFunctional', 'varianceFunctional']) totals.getCell(key).numFmt = '#,##0.00';
  totals.getCell('spent').numFmt = '0%';

  // --- the donor's own periods ------------------------------------------------
  const periodSheet = wb.addWorksheet('Reporting periods');
  header(periodSheet, [
    { header: '#', key: 'index', width: 6 },
    { header: 'From', key: 'start', width: 14 },
    { header: 'To', key: 'end', width: 14 },
    { header: 'Report due', key: 'due', width: 14 },
    { header: `Spent (${donor})`, key: 'donor', width: 16 },
    { header: `Spent (${functionalCurrency})`, key: 'functional', width: 18 },
  ]);
  for (const period of periods) {
    const row = periodSheet.addRow({
      index: period.index,
      start: period.start,
      end: period.end,
      due: period.dueDate,
      donor: money(period.actualDonorMinor),
      functional: money(period.actualFunctionalMinor),
    });
    row.getCell('donor').numFmt = '#,##0.00';
    row.getCell('functional').numFmt = '#,##0.00';
  }

  // --- conditions ---------------------------------------------------------------
  if (grant.conditions.length) {
    const conditions = wb.addWorksheet('Conditions');
    header(conditions, [
      { header: 'Condition', key: 'description', width: 60 },
      { header: 'Due', key: 'due', width: 14 },
      { header: 'Met', key: 'met', width: 14 },
      { header: `Income released (${functionalCurrency})`, key: 'released', width: 22 },
    ]);
    for (const condition of grant.conditions) {
      const row = conditions.addRow({
        description: condition.description,
        due: condition.dueDate ?? '',
        met: condition.metAt ? condition.metAt.slice(0, 10) : 'Outstanding',
        released: money(condition.releasedMinor),
      });
      row.getCell('released').numFmt = '#,##0.00';
    }
  }

  // --- in-kind -------------------------------------------------------------------
  const inKindSheet = wb.addWorksheet('In-kind contributions');
  header(inKindSheet, [
    { header: 'Date', key: 'date', width: 14 },
    { header: 'What was given', key: 'description', width: 46 },
    { header: 'Kind', key: 'kind', width: 26 },
    { header: 'Given by', key: 'donor', width: 28 },
    { header: 'How it was valued', key: 'basis', width: 34 },
    { header: `Value (${functionalCurrency})`, key: 'value', width: 18 },
  ]);
  for (const contribution of inKind) {
    const row = inKindSheet.addRow({
      date: contribution.date,
      description: contribution.description,
      kind: inKindKindLabels[contribution.kind],
      donor: contribution.donorName,
      basis: contribution.basis,
      value: money(contribution.valueMinor),
    });
    row.getCell('value').numFmt = '#,##0.00';
  }
  if (!inKind.length) inKindSheet.addRow({ description: 'None recorded for this period.' });

  // --- staff time -------------------------------------------------------------------
  const staffSheet = wb.addWorksheet('Staff time');
  header(staffSheet, [
    { header: 'Person', key: 'person', width: 28 },
    { header: 'Role', key: 'role', width: 26 },
    { header: 'From', key: 'start', width: 14 },
    { header: 'To', key: 'end', width: 14 },
    { header: 'Hours', key: 'hours', width: 10 },
    { header: `Rate per hour (${functionalCurrency})`, key: 'rate', width: 22 },
    { header: `Value (${functionalCurrency})`, key: 'value', width: 18 },
    { header: 'In the accounts', key: 'posted', width: 18 },
  ]);
  for (const allocation of staffTime) {
    const row = staffSheet.addRow({
      person: allocation.personName,
      role: allocation.role,
      start: allocation.periodStart,
      end: allocation.periodEnd,
      hours: allocation.hours,
      rate: money(allocation.rateMinorPerHour),
      value: money(allocation.valueMinor),
      posted: allocation.posted ? 'Charged to the grant' : 'Reported only',
    });
    row.getCell('hours').numFmt = '#,##0.00';
    row.getCell('rate').numFmt = '#,##0.00';
    row.getCell('value').numFmt = '#,##0.00';
  }
  if (!staffTime.length) staffSheet.addRow({ person: 'None recorded for this period.' });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
