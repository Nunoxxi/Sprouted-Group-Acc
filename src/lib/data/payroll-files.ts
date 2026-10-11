/**
 * Files payroll hands to people: the statutory schedules and reports as Excel
 * workbooks, and payslips as PDF. Server only — exceljs and pdf-lib stay out
 * of the browser bundle, and the numbers in the files come straight from the
 * database, unmasked, so these are built only behind payroll:view.
 */

import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

import { ghsText, periodLabel, type Payslip, type PayslipRow } from '../payslip';

// --- Excel ---------------------------------------------------------------------------------------

export type TableColumn = { header: string; key: string; kind: 'text' | 'money' | 'number' };

/**
 * One sheet: a title, a few lines saying what it is, a header row, the rows,
 * and a totals row for the money columns. Money is written in cedis with two
 * decimals, converted from pesewas exactly once, here.
 */
export async function tableWorkbook(args: {
  sheetName: string;
  title: string;
  notes: string[];
  columns: TableColumn[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, number>;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Sprouted Group accounting';
  const sheet = workbook.addWorksheet(args.sheetName.slice(0, 31));
  sheet.addRow([args.title]).font = { bold: true, size: 14 };
  for (const note of args.notes) sheet.addRow([note]).font = { italic: true, color: { argb: 'FF555555' } };
  sheet.addRow([]);
  const header = sheet.addRow(args.columns.map((c) => c.header));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    cell.border = { bottom: { style: 'thin' } };
  });
  const value = (column: TableColumn, raw: string | number | null | undefined) => {
    if (raw === null || raw === undefined) return null;
    return column.kind === 'money' ? Number(raw) / 100 : raw;
  };
  for (const row of args.rows) sheet.addRow(args.columns.map((c) => value(c, row[c.key])));
  if (args.totals) {
    const totals = sheet.addRow(args.columns.map((c, index) => (index === 0 ? 'Total' : c.kind === 'money' && args.totals![c.key] !== undefined ? args.totals![c.key] / 100 : null)));
    totals.font = { bold: true };
    totals.eachCell((cell) => (cell.border = { top: { style: 'thin' } }));
  }
  args.columns.forEach((column, index) => {
    const col = sheet.getColumn(index + 1);
    col.width = Math.max(12, Math.min(40, column.header.length + 4));
    if (column.kind === 'money') col.numFmt = '#,##0.00';
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// --- PDF -------------------------------------------------------------------------------------------

/** pdf-lib's standard fonts speak WinAnsi; anything outside it would throw, so it is swapped for its nearest. */
function safe(text: string): string {
  return text.replace(/[−–]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/·/g, '-').replace(/[^\x20-\x7E -ÿ—]/g, '');
}

export async function payslipPdf(slip: Payslip): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Payslip ${slip.employee.staffNumber} ${slip.period}`);
  const page = pdf.addPage([595.28, 841.89]); // A4
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const left = 48;
  const right = 547;
  let y = 790;

  const text = (value: string, x: number, font: PDFFont, size = 10, colour = rgb(0.1, 0.1, 0.1)) => page.drawText(safe(value), { x, y, size, font, color: colour });
  const textRight = (value: string, x: number, font: PDFFont, size = 10) => {
    const clean = safe(value);
    page.drawText(clean, { x: x - font.widthOfTextAtSize(clean, size), y, size, font, color: rgb(0.1, 0.1, 0.1) });
  };
  // In the gap above the row about to be written: clear of the row above and of this one.
  const rule = (target: PDFPage = page) => target.drawLine({ start: { x: left, y: y + 12 }, end: { x: right, y: y + 12 }, thickness: 0.5, color: rgb(0.75, 0.75, 0.75) });
  const heading = (value: string) => {
    y -= 10;
    text(value.toUpperCase(), left, bold, 8, rgb(0.4, 0.4, 0.4));
    y -= 14;
  };
  const row = (r: PayslipRow, font = regular) => {
    text(r.label, left, font);
    if (r.note) text(r.note, left + 220, regular, 8, rgb(0.45, 0.45, 0.45));
    textRight(ghsText(r.amountMinor), right, font);
    y -= 15;
  };

  text(slip.entityName, left, bold, 16);
  textRight(`Payslip - ${periodLabel(slip.period)}`, right, bold, 12);
  y -= 22;
  if (slip.provisional) {
    text('PROVISIONAL - this pay run is not yet posted and the figures may change.', left, bold, 9, rgb(0.7, 0.35, 0));
    y -= 16;
  }
  text(`${slip.employee.name}`, left, bold, 11);
  textRight(`Paid on ${slip.payDate}`, right, regular);
  y -= 14;
  text(`Staff number ${slip.employee.staffNumber}${slip.employee.department ? `   Department ${slip.employee.department}` : ''}`, left, regular, 9);
  y -= 12;
  text(`TIN ${slip.employee.tin || 'not held'}   SSNIT ${slip.employee.ssnitNumber || 'not held'}`, left, regular, 9);
  y -= 12;
  if (slip.daysNote) {
    text(slip.daysNote, left, regular, 9);
    y -= 12;
  }
  y -= 6;
  rule();

  heading('Earnings');
  slip.earnings.forEach((r) => row(r));
  rule();
  row({ label: 'Gross pay', amountMinor: slip.grossMinor }, bold);

  heading('Deductions');
  slip.deductions.forEach((r) => row(r));
  rule();
  row({ label: 'Total deductions', amountMinor: slip.totalDeductionsMinor }, bold);

  y -= 6;
  rule();
  text('NET PAY', left, bold, 12);
  textRight(ghsText(slip.netMinor), right, bold, 12);
  y -= 22;

  heading('Paid by your employer on top of your pay');
  slip.employer.forEach((r) => row(r));

  heading('Year to date');
  slip.yearToDate.forEach((r) => row(r));

  if (slip.loans.length) {
    heading('Loans and advances');
    for (const loan of slip.loans) {
      text(loan.description, left, regular);
      text(`this month ${ghsText(loan.instalmentMinor)}`, left + 220, regular, 8, rgb(0.45, 0.45, 0.45));
      textRight(`${ghsText(loan.outstandingMinor)} left`, right, regular);
      y -= 15;
    }
  }

  return Buffer.from(await pdf.save());
}
