/**
 * The opening-balance workbook: one template per entity, pre-filled with
 * its chart, grades, locations, agents and contacts so the person fills in
 * amounts rather than codes; and the parser that turns an uploaded copy
 * back into rows, with row-numbered errors.
 *
 * Amounts in the sheets are ordinary decimals in the row's currency (GH₵
 * 12,345.67, not pesewas); weights are kilograms. The parser converts to
 * minor units and grams.
 */

import ExcelJS from 'exceljs';

import { currencies, isCurrency, normalizeRate, type Currency } from '../fx';
import type { ContractRow, FarmerAdvanceRow, FloatRow, OpenDocumentRow, OpeningSection, RowError, StockRow, TrialBalanceRow } from '../opening';

export type TemplateContext = {
  entity: { id: string; name: string; functionalCurrency: Currency; cutOverDate: string | null; holdsStock: boolean };
  accounts: { code: string; name: string; type: string; category: string | null }[];
  contacts: { name: string; type: string }[];
  grades: { commodityCode: string; grade: string; name: string }[];
  locations: { code: string; name: string }[];
  agents: { name: string }[];
};

const SHEETS: Record<OpeningSection, string> = {
  'trial-balance': 'Trial balance',
  invoices: 'Customer invoices',
  bills: 'Supplier bills',
  stock: 'Stock',
  floats: 'Agent floats',
  'farmer-advances': 'Farmer advances',
  contracts: 'Contracts',
};

const header = (sheet: ExcelJS.Worksheet, columns: { header: string; key: string; width: number }[]) => {
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F1EC' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
};

/** Build the template workbook for one entity. */
export async function buildTemplate(context: TemplateContext): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sprouted Accounting';
  const fx = context.entity.functionalCurrency;

  const readme = wb.addWorksheet('Read me');
  readme.getColumn(1).width = 110;
  const lines = [
    `Opening balances for ${context.entity.name} — as at the cut-over date ${context.entity.cutOverDate ?? '(set it in the app first)'}.`,
    '',
    'Fill in the sheets that apply, save, and upload the file under Go-live. Each sheet becomes a draft you review before posting.',
    `Amounts are ordinary decimals in the currency shown (e.g. 12345.67). The functional currency is ${fx}; a balance in another currency needs the ${fx}-per-1-unit rate at the cut-over date.`,
    'Weights are kilograms.',
    '',
    'Trial balance: one row per account with a balance. Positive = money in (a debit balance: cash, receivables, stock, expenses); negative = money out (a credit balance: payables, equity, income). It must balance in functional currency or it will not post.',
    'Do not include 3090 Opening Balance Suspense. Control accounts (receivables 1010, payables 2001, inventory, agent floats 1060, farmer advances 1070) go to suspense automatically and are cleared by the detail sheets.',
    'Customer invoices / Supplier bills: one row per unpaid document, at the amount still outstanding. Their totals must equal 1010 / 2001 in the trial balance.',
    'Stock: one row per commodity grade per location, with kilograms and total cost in functional currency. Totals must equal the inventory accounts.',
    'Agent floats / Farmer advances: one row per outstanding amount. Totals must equal 1060 / 1070.',
    'Contracts: open sales contracts, with what has already been delivered. Deliveries before the cut-over date carry no revenue here — that is in the trial balance.',
    '',
    'Anything that does not reconcile stays in 3090 Opening Balance Suspense, and the entity cannot go live until that is zero.',
  ];
  lines.forEach((text, i) => { readme.getCell(i + 1, 1).value = text; if (i === 0) readme.getCell(1, 1).font = { bold: true, size: 13 }; });

  const chart = wb.addWorksheet('Chart');
  header(chart, [{ header: 'Code', key: 'code', width: 10 }, { header: 'Name', key: 'name', width: 44 }, { header: 'Type', key: 'type', width: 16 }]);
  for (const a of context.accounts) chart.addRow({ code: a.code, name: a.name, type: a.type });

  const tb = wb.addWorksheet(SHEETS['trial-balance']);
  header(tb, [{ header: 'Account code', key: 'code', width: 14 }, { header: 'Account name (for reference)', key: 'name', width: 40 }, { header: 'Currency', key: 'currency', width: 10 }, { header: 'Balance (+ in / − out)', key: 'amount', width: 22 }, { header: `Rate (${fx} per 1 unit) if not ${fx}`, key: 'rate', width: 26 }, { header: 'Note', key: 'note', width: 30 }]);
  for (const a of context.accounts.filter((x) => x.code !== '3090')) tb.addRow({ code: a.code, name: a.name, currency: fx, amount: null, rate: null, note: '' });

  const docs = (name: string, who: string) => {
    const s = wb.addWorksheet(name);
    header(s, [{ header: 'Document number', key: 'number', width: 18 }, { header: who, key: 'contact', width: 30 }, { header: 'Date (YYYY-MM-DD)', key: 'date', width: 18 }, { header: 'Due date', key: 'dueDate', width: 14 }, { header: 'Currency', key: 'currency', width: 10 }, { header: 'Amount outstanding', key: 'outstanding', width: 20 }, { header: `Rate if not ${fx}`, key: 'rate', width: 16 }, { header: 'Note', key: 'note', width: 30 }]);
    return s;
  };
  docs(SHEETS.invoices, 'Customer');
  docs(SHEETS.bills, 'Supplier');

  if (context.entity.holdsStock) {
    const stock = wb.addWorksheet(SHEETS.stock);
    header(stock, [{ header: 'Commodity code', key: 'commodity', width: 16 }, { header: 'Grade', key: 'grade', width: 16 }, { header: 'Location code', key: 'location', width: 16 }, { header: 'Kilograms', key: 'kg', width: 14 }, { header: `Total cost (${fx})`, key: 'cost', width: 18 }, { header: 'Lot ref (optional)', key: 'lot', width: 18 }]);
    for (const g of context.grades) for (const l of context.locations) stock.addRow({ commodity: g.commodityCode, grade: g.grade, location: l.code, kg: null, cost: null, lot: '' });

    const floats = wb.addWorksheet(SHEETS.floats);
    header(floats, [{ header: 'Agent', key: 'agent', width: 28 }, { header: 'Date advanced (YYYY-MM-DD)', key: 'date', width: 26 }, { header: `Outstanding (${fx})`, key: 'amount', width: 18 }, { header: 'Note', key: 'note', width: 30 }]);
    for (const a of context.agents) floats.addRow({ agent: a.name, date: null, amount: null, note: '' });

    const farmers = wb.addWorksheet(SHEETS['farmer-advances']);
    header(farmers, [{ header: 'Farmer', key: 'farmer', width: 28 }, { header: 'Community', key: 'community', width: 18 }, { header: 'District', key: 'district', width: 18 }, { header: 'Date advanced (YYYY-MM-DD)', key: 'date', width: 26 }, { header: `Outstanding (${fx})`, key: 'amount', width: 18 }, { header: 'Note', key: 'note', width: 30 }]);

    const contracts = wb.addWorksheet(SHEETS.contracts);
    header(contracts, [
      { header: 'Contract no.', key: 'no', width: 14 }, { header: 'Buyer', key: 'buyer', width: 28 }, { header: 'Commodity code', key: 'commodity', width: 16 }, { header: 'Grade', key: 'grade', width: 14 },
      { header: 'Quantity (kg)', key: 'kg', width: 14 }, { header: 'Price', key: 'price', width: 12 }, { header: 'Per (kg/bag/tonne)', key: 'unit', width: 18 }, { header: 'Currency', key: 'currency', width: 10 }, { header: `Contract rate (${fx} per 1) if foreign`, key: 'rate', width: 30 },
      { header: 'Delivery terms', key: 'terms', width: 24 }, { header: 'Deliver from', key: 'from', width: 14 }, { header: 'Deliver to', key: 'to', width: 14 }, { header: 'Revenue on (delivery/acceptance)', key: 'recognize', width: 30 }, { header: 'Sale (domestic/export)', key: 'sale', width: 22 }, { header: 'Already delivered (kg)', key: 'delivered', width: 22 },
    ]);

    const refs = wb.addWorksheet('Reference');
    refs.getColumn(1).width = 22; refs.getColumn(2).width = 40;
    refs.addRow(['Grades (commodity code · grade)', '']);
    for (const g of context.grades) refs.addRow([g.commodityCode, `${g.grade} — ${g.name}`]);
    refs.addRow(['', '']);
    refs.addRow(['Locations (code · name)', '']);
    for (const l of context.locations) refs.addRow([l.code, l.name]);
    refs.addRow(['', '']);
    refs.addRow(['Agents', '']);
    for (const a of context.agents) refs.addRow([a.name, '']);
  }

  const contacts = wb.addWorksheet('Contacts');
  header(contacts, [{ header: 'Name (as the app knows it)', key: 'name', width: 34 }, { header: 'Type', key: 'type', width: 12 }]);
  for (const c of context.contacts) contacts.addRow({ name: c.name, type: c.type });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- parsing --------------------------------------------------------------------------------

export type ParsedWorkbook = {
  sections: Partial<Record<OpeningSection, { rows: unknown[]; errors: RowError[] }>>;
};

const text = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('richText' in v) return v.richText.map((r) => r.text).join('').trim();
    if ('result' in v) return text(v.result as ExcelJS.CellValue);
    if ('text' in v) return String(v.text).trim();
    return String(v).trim();
  }
  return String(v).trim();
};
const num = (v: ExcelJS.CellValue): number | null => {
  const t = text(v).replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const minor = (v: ExcelJS.CellValue): number | null => { const n = num(v); return n === null ? null : Math.round(n * 100); };
const grams = (v: ExcelJS.CellValue): number | null => { const n = num(v); return n === null ? null : Math.round(n * 1000); };
const dateText = (v: ExcelJS.CellValue): string => { const t = text(v); return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : t; };
const isDate = (t: string) => /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(new Date(`${t}T00:00:00Z`).getTime());
const currencyOf = (v: ExcelJS.CellValue, fallback: Currency): Currency | null => { const t = text(v).toUpperCase(); if (t === '') return fallback; return isCurrency(t) ? t : null; };
const rateOf = (v: ExcelJS.CellValue): string | null => { const t = text(v); if (t === '') return null; try { return normalizeRate(t); } catch { return null; } };

function eachRow(sheet: ExcelJS.Worksheet | undefined, cb: (cells: ExcelJS.CellValue[], rowNumber: number) => void) {
  if (!sheet) return;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: ExcelJS.CellValue[] = [];
    for (let c = 1; c <= sheet.columnCount; c++) cells.push(row.getCell(c).value);
    if (cells.every((v) => text(v) === '')) return;
    cb(cells, rowNumber);
  });
}

/** Parse an uploaded workbook. Rows with any value in an amount/weight column are taken; template rows left blank are skipped. */
export async function parseWorkbook(buffer: Buffer, functionalCurrency: Currency): Promise<ParsedWorkbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sections: ParsedWorkbook['sections'] = {};

  // Trial balance
  {
    const rows: TrialBalanceRow[] = []; const errors: RowError[] = [];
    eachRow(wb.getWorksheet(SHEETS['trial-balance']), (c, r) => {
      const amount = minor(c[3]);
      if (amount === null || amount === 0) return;
      const code = text(c[0]);
      const currency = currencyOf(c[2], functionalCurrency);
      if (!code) errors.push({ row: r, message: 'Missing account code.' });
      if (!currency) errors.push({ row: r, message: `Currency must be one of ${currencies.join(', ')}.` });
      const rate = rateOf(c[4]);
      if (currency && currency !== functionalCurrency && !rate) errors.push({ row: r, message: `Row is in ${currency}: enter the ${functionalCurrency}-per-1-${currency} rate at the cut-over date.` });
      rows.push({ row: r, accountCode: code, currency: currency ?? functionalCurrency, amountMinor: amount, rate: currency === functionalCurrency ? '1.0' : (rate ?? '1.0'), note: text(c[5]) });
    });
    if (rows.length || errors.length) sections['trial-balance'] = { rows, errors };
  }

  // Invoices and bills
  for (const [section, sheetName] of [['invoices', SHEETS.invoices], ['bills', SHEETS.bills]] as const) {
    const rows: OpenDocumentRow[] = []; const errors: RowError[] = [];
    eachRow(wb.getWorksheet(sheetName), (c, r) => {
      const outstanding = minor(c[5]);
      if (outstanding === null) return;
      const number = text(c[0]); const contactName = text(c[1]); const date = dateText(c[2]); const dueDate = dateText(c[3]) || date;
      const currency = currencyOf(c[4], functionalCurrency); const rate = rateOf(c[6]);
      if (!number) errors.push({ row: r, message: 'Missing document number.' });
      if (!contactName) errors.push({ row: r, message: 'Missing contact name.' });
      if (!isDate(date)) errors.push({ row: r, message: 'Date must be YYYY-MM-DD.' });
      if (!currency) errors.push({ row: r, message: 'Unknown currency.' });
      if (outstanding <= 0) errors.push({ row: r, message: 'Amount outstanding must be greater than zero.' });
      if (currency && currency !== functionalCurrency && !rate) errors.push({ row: r, message: `Row is in ${currency}: enter the cut-over rate.` });
      rows.push({ row: r, number, contactName, date, dueDate: isDate(dueDate) ? dueDate : date, currency: currency ?? functionalCurrency, outstandingMinor: outstanding, rate: currency === functionalCurrency ? '1.0' : (rate ?? '1.0'), note: text(c[7]) });
    });
    if (rows.length || errors.length) sections[section] = { rows, errors };
  }

  // Stock
  {
    const rows: StockRow[] = []; const errors: RowError[] = [];
    eachRow(wb.getWorksheet(SHEETS.stock), (c, r) => {
      const kg = grams(c[3]); const cost = minor(c[4]);
      if ((kg === null || kg === 0) && (cost === null || cost === 0)) return;
      if (kg === null || kg <= 0) errors.push({ row: r, message: 'Kilograms must be greater than zero.' });
      if (cost === null || cost < 0) errors.push({ row: r, message: 'Total cost is missing.' });
      if (!text(c[0]) || !text(c[1]) || !text(c[2])) errors.push({ row: r, message: 'Commodity, grade and location are all needed.' });
      rows.push({ row: r, commodityCode: text(c[0]).toUpperCase(), grade: text(c[1]), locationCode: text(c[2]).toUpperCase(), grams: kg ?? 0, valueMinor: cost ?? 0, lotRef: text(c[5]) });
    });
    if (rows.length || errors.length) sections.stock = { rows, errors };
  }

  // Floats
  {
    const rows: FloatRow[] = []; const errors: RowError[] = [];
    eachRow(wb.getWorksheet(SHEETS.floats), (c, r) => {
      const amount = minor(c[2]);
      if (amount === null) return;
      const date = dateText(c[1]);
      if (!text(c[0])) errors.push({ row: r, message: 'Missing agent.' });
      if (!isDate(date)) errors.push({ row: r, message: 'Date must be YYYY-MM-DD.' });
      if (amount <= 0) errors.push({ row: r, message: 'Amount must be greater than zero.' });
      rows.push({ row: r, agentName: text(c[0]), date, amountMinor: amount, note: text(c[3]) });
    });
    if (rows.length || errors.length) sections.floats = { rows, errors };
  }

  // Farmer advances
  {
    const rows: FarmerAdvanceRow[] = []; const errors: RowError[] = [];
    eachRow(wb.getWorksheet(SHEETS['farmer-advances']), (c, r) => {
      const amount = minor(c[4]);
      if (amount === null) return;
      const date = dateText(c[3]);
      if (!text(c[0])) errors.push({ row: r, message: 'Missing farmer name.' });
      if (!isDate(date)) errors.push({ row: r, message: 'Date must be YYYY-MM-DD.' });
      if (amount <= 0) errors.push({ row: r, message: 'Amount must be greater than zero.' });
      rows.push({ row: r, farmerName: text(c[0]), community: text(c[1]), district: text(c[2]), date, amountMinor: amount, note: text(c[5]) });
    });
    if (rows.length || errors.length) sections['farmer-advances'] = { rows, errors };
  }

  // Contracts
  {
    const rows: ContractRow[] = []; const errors: RowError[] = [];
    eachRow(wb.getWorksheet(SHEETS.contracts), (c, r) => {
      const kg = grams(c[4]);
      if (kg === null) return;
      const price = minor(c[5]); const unit = text(c[6]).toLowerCase(); const currency = currencyOf(c[7], functionalCurrency); const rate = rateOf(c[8]);
      const from = dateText(c[10]); const to = dateText(c[11]); const recognize = text(c[12]).toLowerCase(); const sale = text(c[13]).toLowerCase(); const delivered = grams(c[14]) ?? 0;
      if (!text(c[0]) || !text(c[1]) || !text(c[2]) || !text(c[3])) errors.push({ row: r, message: 'Contract no., buyer, commodity and grade are all needed.' });
      if (kg <= 0) errors.push({ row: r, message: 'Quantity must be greater than zero.' });
      if (price === null || price <= 0) errors.push({ row: r, message: 'Price is missing.' });
      if (!['kg', 'bag', 'tonne'].includes(unit)) errors.push({ row: r, message: 'Per must be kg, bag or tonne.' });
      if (!currency) errors.push({ row: r, message: 'Unknown currency.' });
      if (!isDate(from) || !isDate(to)) errors.push({ row: r, message: 'Delivery dates must be YYYY-MM-DD.' });
      if (!['delivery', 'acceptance'].includes(recognize)) errors.push({ row: r, message: 'Revenue on must be delivery or acceptance.' });
      if (!['domestic', 'export'].includes(sale)) errors.push({ row: r, message: 'Sale must be domestic or export.' });
      if (delivered < 0 || delivered > kg) errors.push({ row: r, message: 'Already delivered cannot exceed the quantity.' });
      rows.push({ row: r, contractNo: text(c[0]), buyerName: text(c[1]), commodityCode: text(c[2]).toUpperCase(), grade: text(c[3]), grams: kg, priceMinor: price ?? 0, priceUnit: (['kg', 'bag', 'tonne'].includes(unit) ? unit : 'kg') as ContractRow['priceUnit'], currency: currency ?? functionalCurrency, contractRate: rate, deliveryTerms: text(c[9]), deliveryFrom: from, deliveryTo: to, recognizeOn: recognize === 'acceptance' ? 'acceptance' : 'delivery', saleType: sale === 'domestic' ? 'domestic' : 'export', deliveredGrams: delivered });
    });
    if (rows.length || errors.length) sections.contracts = { rows, errors };
  }

  return { sections };
}

export const sheetNames = SHEETS;
