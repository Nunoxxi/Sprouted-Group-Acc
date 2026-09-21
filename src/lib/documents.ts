/**
 * Invoice and bill logic shared by the editor (client), the posting server
 * function, and the tests. Pure: no I/O, no Prisma.
 *
 * Amounts are integer pesewas throughout.
 */

import type { AccountRecord, ContactRecord } from './data/types';
import { isCurrency, type Currency } from './fx';
import { landedCostKinds, type LandedCostKind, type Quality } from './trading';
import {
  leviesOnBase,
  roundPesewas,
  splitImportLevies,
  vatAppliesOn,
  withholdingRateOf,
  withholdingTaxOn,
  type TaxableSupply,
  type VatRegistration,
  type VATTreatment,
  type WithholdingTaxStatus,
} from './ghana-tax';

export type DocumentKind = 'invoice' | 'bill';
/** Domestic or export sale. Exports are zero-rated once the entity is registered; until then the flag changes nothing. */
export type SaleType = 'domestic' | 'export';
export const saleTypes: SaleType[] = ['domestic', 'export'];

/**
 * Whether VAT is calculated on a document. Decided once from the entity's
 * registration and the document date; fixed on the document at posting so a
 * later registration never rewrites what a posted document charged.
 */
export type DocumentTax = { vatApplies: boolean };

export function documentTaxFor(entity: VatRegistration, date: string): DocumentTax {
  return { vatApplies: vatAppliesOn(entity, date) };
}
export type DocumentStatus = 'draft' | 'awaiting-payment' | 'paid' | 'voided';

export type DocumentLine = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number; // pesewas
  accountCode: string;
  vatTreatment: VATTreatment;
  /** Bills: the stock item this line receives and where. Quantity is then in the item's base unit. */
  itemId: string | null;
  locationId: string | null;
  /** Bills: a charge capitalised into stock, spread per kg over these lots. */
  landedCostKind: LandedCostKind | null;
  landedCostLotIds: string[];
  /** Bills: origin and quality of the lot a stock line creates. */
  lotRef: string;
  community: string;
  district: string;
  quality: Quality;
};

export type DocumentFormState = {
  /** Database id once saved; null for a document that has never been saved. */
  id: string | null;
  kind: DocumentKind;
  /** Allocated by the server when the document is posted; empty while a draft. */
  docNumber: string;
  contactId: string;
  date: string; // YYYY-MM-DD
  dueDate: string;
  status: DocumentStatus;
  /** Transaction currency; unit prices are in its minor units. */
  currency: Currency;
  /** Functional units per 1 unit of currency. Defaulted from the rate table; may be overridden. Null until known. */
  rate: string | null;
  /** The date the default rate was taken from — earlier than `date` when no rate existed for the day. */
  rateDate: string | null;
  /** False when the rate is a fallback from an earlier date or a manual override. */
  rateExact: boolean;
  /** Invoices only; bills are always 'domestic'. */
  saleType: SaleType;
  /** Bills only: VAT paid at the point of entry on an import, in the document currency (pesewas/cents). */
  importVat: number;
  lines: DocumentLine[];
  evatClearanceNumber: string;
  evatQrCode: string;
  evatTimestamp: string;
};

/** One side of a journal, as the editor previews it and the server persists it. */
export type JournalLineDraft = {
  accountCode: string;
  accountName: string;
  amount: number;
  type: 'debit' | 'credit';
};

// Control accounts the posting rules rely on. They exist in every chart
// template; seedChartForEntity guarantees it for new entities.
export const controlAccounts = {
  receivables: '1010',
  payables: '2001',
  vatOutput: '2020',
  nhilOutput: '2025',
  getFundOutput: '2030',
  withholdingPayable: '2035',
  vatInput: '1101',
  nhilInput: '1102',
  getFundInput: '1103',
} as const;

export const defaultLineAccount: Record<DocumentKind, string> = {
  invoice: '4001',
  bill: '5001',
};

export function makeLine(kind: DocumentKind = 'invoice'): DocumentLine {
  return {
    id: `line-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    description: '',
    quantity: 1,
    unitPrice: 0,
    accountCode: defaultLineAccount[kind],
    vatTreatment: 'standard',
    itemId: null,
    locationId: null,
    landedCostKind: null,
    landedCostLotIds: [],
    lotRef: '',
    community: '',
    district: '',
    quality: {},
  };
}

export function makeDocument(kind: DocumentKind, contactId: string, currency: Currency = 'GHS'): DocumentFormState {
  const today = new Date().toISOString().slice(0, 10);

  return {
    id: null,
    kind,
    docNumber: '',
    contactId,
    date: today,
    dueDate: today,
    status: 'draft',
    currency,
    rate: currency === 'GHS' ? '1.0' : null,
    rateDate: null,
    rateExact: true,
    saleType: 'domestic',
    importVat: 0,
    lines: [makeLine(kind)],
    evatClearanceNumber: '',
    evatQrCode: '',
    evatTimestamp: '',
  };
}

export const documentStatuses: DocumentStatus[] = ['draft', 'awaiting-payment', 'paid', 'voided'];
export const vatTreatments: VATTreatment[] = ['standard', 'zero-rated', 'exempt'];

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function normalizeLine(value: unknown, kind: DocumentKind): DocumentLine {
  const line = (value ?? {}) as Partial<DocumentLine>;
  const fresh = makeLine(kind);

  return {
    id: asText(line.id, fresh.id),
    description: asText(line.description),
    quantity: asNumber(line.quantity, fresh.quantity),
    unitPrice: asNumber(line.unitPrice, fresh.unitPrice),
    accountCode: asText(line.accountCode, fresh.accountCode),
    vatTreatment: vatTreatments.includes(line.vatTreatment as VATTreatment)
      ? (line.vatTreatment as VATTreatment)
      : fresh.vatTreatment,
    itemId: kind === 'bill' && typeof line.itemId === 'string' && line.itemId ? line.itemId : null,
    locationId: kind === 'bill' && typeof line.locationId === 'string' && line.locationId ? line.locationId : null,
    landedCostKind: kind === 'bill' && landedCostKinds.includes(line.landedCostKind as LandedCostKind) ? (line.landedCostKind as LandedCostKind) : null,
    landedCostLotIds: kind === 'bill' && Array.isArray(line.landedCostLotIds) ? line.landedCostLotIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : [],
    lotRef: asText(line.lotRef),
    community: asText(line.community),
    district: asText(line.district),
    quality: normalizeQuality(line.quality),
  };
}

function normalizeQuality(value: unknown): Quality {
  const raw = (value ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const quality: Quality = {};
  if (num(raw.kor) !== null) quality.kor = num(raw.kor);
  if (num(raw.moisturePct) !== null) quality.moisturePct = num(raw.moisturePct);
  if (num(raw.nutCount) !== null) quality.nutCount = num(raw.nutCount);
  if (typeof raw.cocoaGrade === 'string' && raw.cocoaGrade.trim()) quality.cocoaGrade = raw.cocoaGrade.trim();
  if (num(raw.beanCount) !== null) quality.beanCount = num(raw.beanCount);
  return quality;
}

/**
 * Fill every gap in a document that arrived from somewhere untrusted (the
 * client, an old draft) from a fresh one, so the editor never holds an
 * undefined field and React never flips an input to uncontrolled.
 */
export function normalizeDocument(value: unknown, kind: DocumentKind, fallbackContactId: string): DocumentFormState {
  const draft = (value ?? {}) as Partial<DocumentFormState>;
  const fresh = makeDocument(kind, fallbackContactId);
  const lines = Array.isArray(draft.lines) ? draft.lines.map((line) => normalizeLine(line, kind)) : [];

  return {
    id: typeof draft.id === 'string' && draft.id ? draft.id : null,
    kind,
    docNumber: asText(draft.docNumber, fresh.docNumber),
    contactId: asText(draft.contactId, fresh.contactId),
    date: asText(draft.date, fresh.date),
    dueDate: asText(draft.dueDate, fresh.dueDate),
    status: documentStatuses.includes(draft.status as DocumentStatus) ? (draft.status as DocumentStatus) : fresh.status,
    currency: isCurrency(draft.currency) ? draft.currency : fresh.currency,
    rate: typeof draft.rate === 'string' && draft.rate.trim() ? draft.rate.trim() : null,
    rateDate: typeof draft.rateDate === 'string' && draft.rateDate ? draft.rateDate : null,
    rateExact: typeof draft.rateExact === 'boolean' ? draft.rateExact : true,
    saleType: kind === 'invoice' && draft.saleType === 'export' ? 'export' : 'domestic',
    importVat: kind === 'bill' && typeof draft.importVat === 'number' && Number.isInteger(draft.importVat) && draft.importVat > 0 ? draft.importVat : 0,
    lines: lines.length > 0 ? lines : fresh.lines,
    evatClearanceNumber: asText(draft.evatClearanceNumber),
    evatQrCode: asText(draft.evatQrCode),
    evatTimestamp: asText(draft.evatTimestamp),
  };
}

/**
 * The VAT treatment a line is actually taxed at. While the entity is not
 * registered (or the document predates registration) nothing is taxed,
 * whatever the line says: the treatment is kept as a classification, for the
 * threshold tracker and for the day registration takes effect. Once VAT
 * applies, an export sale is zero-rated as a whole.
 */
export function effectiveTreatment(
  line: Pick<DocumentLine, 'vatTreatment'>,
  document: Pick<DocumentFormState, 'kind' | 'saleType'>,
  tax: DocumentTax,
): VATTreatment {
  if (!tax.vatApplies) {
    return 'exempt';
  }
  if (document.kind === 'invoice' && document.saleType === 'export') {
    return 'zero-rated';
  }
  return line.vatTreatment;
}

export function lineTaxBreakdown(line: DocumentLine, treatment: VATTreatment = line.vatTreatment) {
  // Each line is its own tax point, so levies are rounded per line and then
  // summed — rounding the summed base instead would disagree with the invoice.
  return leviesOnBase(roundPesewas(line.quantity * line.unitPrice), treatment);
}

type TotalsInput = Pick<DocumentFormState, 'kind' | 'lines' | 'saleType' | 'importVat'>;

export type DocumentTotals = {
  subtotal: number;
  vat: number;
  nhil: number;
  getFund: number;
  totalTax: number;
  /** The supplier's or customer's document total: subtotal plus levies. */
  total: number;
  /** Bills only: VAT paid at the port on an import. Not part of `total`, never subject to withholding. */
  importVat: number;
  withholdingTax: number;
  /** Bills: total less withholding, plus import VAT — what leaves the bank. Invoices: equals `total`. */
  netPayable: number;
};

/**
 * Document totals under a tax regime. `tax.vatApplies` is required, not
 * defaulted: a caller that forgets it must not silently charge (or fail to
 * charge) VAT.
 */
export function buildTotals(document: TotalsInput, withholdingTaxStatus: WithholdingTaxStatus | undefined, tax: DocumentTax): DocumentTotals {
  const lineSummaries = document.lines.map((line) => lineTaxBreakdown(line, effectiveTreatment(line, document, tax)));
  const subtotal = lineSummaries.reduce((sum, line) => sum + line.base, 0);
  const vat = lineSummaries.reduce((sum, line) => sum + line.vat, 0);
  const nhil = lineSummaries.reduce((sum, line) => sum + line.nhil, 0);
  const getFund = lineSummaries.reduce((sum, line) => sum + line.getFund, 0);
  const totalTax = vat + nhil + getFund;
  const total = subtotal + totalTax;
  const importVat = document.kind === 'bill' ? document.importVat : 0;

  const withheldRate = withholdingRateOf(withholdingTaxStatus);
  const withholdingTax = withholdingTaxOn(total, withheldRate);
  const netPayable = Math.max(total - withholdingTax, 0) + importVat;

  return { subtotal, vat, nhil, getFund, totalTax, total, importVat, withholdingTax, netPayable };
}

/** Code → name lookup from an entity's chart. */
export function accountNameMap(accounts: Pick<AccountRecord, 'code' | 'name'>[]): Record<string, string> {
  return Object.fromEntries(accounts.map((account) => [account.code, account.name]));
}

/**
 * Spread an amount across accounts in proportion to their bases, whole
 * pesewas, remainder on the largest — so import VAT lands on the same cost
 * accounts as the goods it was paid on.
 */
function allocateProRata(amount: number, baseByAccount: Record<string, number>): Record<string, number> {
  const entries = Object.entries(baseByAccount).filter(([, base]) => base > 0);
  const totalBase = entries.reduce((sum, [, base]) => sum + base, 0);
  if (amount <= 0 || entries.length === 0 || totalBase <= 0) {
    return {};
  }
  const allocated: Record<string, number> = {};
  let remaining = amount;
  for (const [code, base] of entries) {
    const share = roundPesewas((amount * base) / totalBase);
    allocated[code] = share;
    remaining -= share;
  }
  const largest = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  allocated[largest] += remaining;
  return allocated;
}

/**
 * The full journal for a document, including zero-amount levy lines — what
 * the editor previews so a person can see every account the posting touches.
 * Account names come from the entity's own chart, so the same code reads
 * "Grants - Unrestricted" on the charity and "Domestic Sales" on a
 * manufacturer.
 *
 * With VAT not applying there are no levy lines at all, not even zero ones:
 * the document has no VAT on it.
 */
export function buildJournalEntries(
  documentState: DocumentFormState,
  isPurchase: boolean,
  contact: Pick<ContactRecord, 'withholdingTaxStatus'> | undefined,
  accountNames: Record<string, string>,
  tax: DocumentTax,
): JournalLineDraft[] {
  const totals = buildTotals(documentState, isPurchase ? contact?.withholdingTaxStatus : undefined, tax);
  const entries: JournalLineDraft[] = [];
  const nameOf = (code: string, fallback: string) => accountNames[code] ?? fallback;

  if (!documentState.lines.length) {
    return entries;
  }

  const baseByAccount = documentState.lines.reduce(
    (accumulator, line) => {
      const summary = lineTaxBreakdown(line, effectiveTreatment(line, documentState, tax));
      accumulator[line.accountCode] = (accumulator[line.accountCode] ?? 0) + summary.base;
      return accumulator;
    },
    {} as Record<string, number>,
  );

  if (!isPurchase) {
    entries.push({ accountCode: controlAccounts.receivables, accountName: nameOf(controlAccounts.receivables, 'Trade Receivables'), amount: totals.total, type: 'debit' });

    for (const [accountCode, amount] of Object.entries(baseByAccount)) {
      entries.push({ accountCode, accountName: nameOf(accountCode, 'Revenue'), amount, type: 'credit' });
    }

    if (tax.vatApplies) {
      entries.push({ accountCode: controlAccounts.vatOutput, accountName: nameOf(controlAccounts.vatOutput, 'VAT Output Tax Payable'), amount: totals.vat, type: 'credit' });
      entries.push({ accountCode: controlAccounts.nhilOutput, accountName: nameOf(controlAccounts.nhilOutput, 'NHIL Payable'), amount: totals.nhil, type: 'credit' });
      entries.push({ accountCode: controlAccounts.getFundOutput, accountName: nameOf(controlAccounts.getFundOutput, 'GETFund Payable'), amount: totals.getFund, type: 'credit' });
    }
  } else {
    if (tax.vatApplies) {
      for (const [accountCode, amount] of Object.entries(baseByAccount)) {
        entries.push({ accountCode, accountName: nameOf(accountCode, 'Expense'), amount, type: 'debit' });
      }

      // Registered: the levies on the purchase and any import VAT paid at the
      // port are input tax, recoverable against output tax on the return.
      const importLevies = splitImportLevies(totals.importVat);
      entries.push({ accountCode: controlAccounts.vatInput, accountName: nameOf(controlAccounts.vatInput, 'VAT Input Tax Recoverable'), amount: totals.vat + importLevies.vat, type: 'debit' });
      entries.push({ accountCode: controlAccounts.nhilInput, accountName: nameOf(controlAccounts.nhilInput, 'NHIL Input Tax Recoverable'), amount: totals.nhil + importLevies.nhil, type: 'debit' });
      entries.push({ accountCode: controlAccounts.getFundInput, accountName: nameOf(controlAccounts.getFundInput, 'GETFund Input Tax Recoverable'), amount: totals.getFund + importLevies.getFund, type: 'debit' });
    } else {
      // UNREGISTERED: VAT PAID ON PURCHASES IS NOT RECOVERABLE.
      //
      // An unregistered entity cannot claim input tax, so the VAT a supplier
      // charged is simply part of what the item cost. The gross amount — the
      // supplier's total including VAT, which is what the unit price holds
      // when no VAT is calculated — goes to the expense or inventory account
      // of the line, and import VAT paid at the port goes to the same cost
      // accounts pro rata. No line is posted to 1101/1102/1103.
      //
      // This reverses the moment registration takes effect: for a document
      // dated on or after the registration date, `tax.vatApplies` is true
      // and the branch above posts the levies to input tax instead.
      const importVatByAccount = allocateProRata(totals.importVat, baseByAccount);
      for (const [accountCode, amount] of Object.entries(baseByAccount)) {
        entries.push({ accountCode, accountName: nameOf(accountCode, 'Expense'), amount: amount + (importVatByAccount[accountCode] ?? 0), type: 'debit' });
      }
    }

    entries.push({ accountCode: controlAccounts.payables, accountName: nameOf(controlAccounts.payables, 'Trade Payables'), amount: totals.netPayable, type: 'credit' });

    if (totals.withholdingTax > 0) {
      entries.push({ accountCode: controlAccounts.withholdingPayable, accountName: nameOf(controlAccounts.withholdingPayable, 'Withholding Tax Payable'), amount: totals.withholdingTax, type: 'credit' });
    }
  }

  return entries;
}

/**
 * The lines that are actually persisted when a document is posted: the
 * preview journal with zero-amount lines removed. An exempt-only invoice
 * previews three zero levy lines so the person can see them; the ledger
 * must not carry them.
 *
 * This is the function the tests target and the server function trusts.
 */
export function journalLinesFor(
  documentState: DocumentFormState,
  isPurchase: boolean,
  contact: Pick<ContactRecord, 'withholdingTaxStatus'> | undefined,
  accountNames: Record<string, string>,
  tax: DocumentTax,
): JournalLineDraft[] {
  return buildJournalEntries(documentState, isPurchase, contact, accountNames, tax).filter((line) => line.amount > 0);
}

/**
 * The taxable supplies a set of documents contributes to the registration
 * threshold: posted (not voided, not draft) invoices, each line that is not
 * exempt, at its base in the entity's functional currency. Zero-rated
 * supplies count — they are taxable at 0%; exempt ones are not taxable.
 * The line's own treatment is used whether or not VAT was charged, because
 * the question is what the entity *would* have to register for.
 */
export function taxableSuppliesOf(
  documents: Pick<DocumentFormState, 'kind' | 'status' | 'date' | 'lines' | 'rate'>[],
  toFunctional: (minor: number, rate: string) => number,
): TaxableSupply[] {
  const supplies: TaxableSupply[] = [];
  for (const document of documents) {
    if (document.kind !== 'invoice' || document.status === 'draft' || document.status === 'voided') continue;
    const base = document.lines
      .filter((line) => line.vatTreatment !== 'exempt')
      .reduce((sum, line) => sum + roundPesewas(line.quantity * line.unitPrice), 0);
    if (base <= 0) continue;
    supplies.push({ date: document.date, baseMinor: toFunctional(base, document.rate ?? '1.0') });
  }
  return supplies;
}

/** YYYY-MM of a YYYY-MM-DD date string. */
export function periodOf(date: string): string {
  return date.slice(0, 7);
}
