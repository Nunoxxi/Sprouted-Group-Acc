/**
 * Invoice and bill logic shared by the editor (client), the posting server
 * function, and the tests. Pure: no I/O, no Prisma.
 *
 * Amounts are integer pesewas throughout.
 */

import type { AccountRecord, ContactRecord } from './data/types';
import { isCurrency, type Currency } from './fx';
import {
  leviesOnBase,
  roundPesewas,
  withholdingRateOf,
  withholdingTaxOn,
  type VATTreatment,
  type WithholdingTaxStatus,
} from './ghana-tax';

export type DocumentKind = 'invoice' | 'bill';
export type DocumentStatus = 'draft' | 'awaiting-payment' | 'paid' | 'voided';

export type DocumentLine = {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number; // pesewas
  accountCode: string;
  vatTreatment: VATTreatment;
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
  };
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
    lines: lines.length > 0 ? lines : fresh.lines,
    evatClearanceNumber: asText(draft.evatClearanceNumber),
    evatQrCode: asText(draft.evatQrCode),
    evatTimestamp: asText(draft.evatTimestamp),
  };
}

export function lineTaxBreakdown(line: DocumentLine) {
  // Each line is its own tax point, so levies are rounded per line and then
  // summed — rounding the summed base instead would disagree with the invoice.
  return leviesOnBase(roundPesewas(line.quantity * line.unitPrice), line.vatTreatment);
}

export function buildTotals(lines: DocumentLine[], withholdingTaxStatus?: WithholdingTaxStatus) {
  const lineSummaries = lines.map(lineTaxBreakdown);
  const subtotal = lineSummaries.reduce((sum, line) => sum + line.base, 0);
  const vat = lineSummaries.reduce((sum, line) => sum + line.vat, 0);
  const nhil = lineSummaries.reduce((sum, line) => sum + line.nhil, 0);
  const getFund = lineSummaries.reduce((sum, line) => sum + line.getFund, 0);
  const totalTax = vat + nhil + getFund;
  const total = subtotal + totalTax;

  const withheldRate = withholdingRateOf(withholdingTaxStatus);
  const withholdingTax = withholdingTaxOn(total, withheldRate);
  const netPayable = Math.max(total - withholdingTax, 0);

  return { subtotal, vat, nhil, getFund, totalTax, total, withholdingTax, netPayable };
}

/** Code → name lookup from an entity's chart. */
export function accountNameMap(accounts: Pick<AccountRecord, 'code' | 'name'>[]): Record<string, string> {
  return Object.fromEntries(accounts.map((account) => [account.code, account.name]));
}

/**
 * The full journal for a document, including zero-amount levy lines — what
 * the editor previews so a person can see every account the posting touches.
 * Account names come from the entity's own chart, so the same code reads
 * "Grants - Unrestricted" on the charity and "Domestic Sales" on a
 * manufacturer.
 */
export function buildJournalEntries(
  documentState: DocumentFormState,
  isPurchase: boolean,
  contact: Pick<ContactRecord, 'withholdingTaxStatus'> | undefined,
  accountNames: Record<string, string>,
): JournalLineDraft[] {
  const totals = buildTotals(documentState.lines, isPurchase ? contact?.withholdingTaxStatus : undefined);
  const entries: JournalLineDraft[] = [];
  const nameOf = (code: string, fallback: string) => accountNames[code] ?? fallback;

  if (!documentState.lines.length) {
    return entries;
  }

  const baseByAccount = documentState.lines.reduce(
    (accumulator, line) => {
      const summary = lineTaxBreakdown(line);
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

    entries.push({ accountCode: controlAccounts.vatOutput, accountName: nameOf(controlAccounts.vatOutput, 'VAT Output Tax Payable'), amount: totals.vat, type: 'credit' });
    entries.push({ accountCode: controlAccounts.nhilOutput, accountName: nameOf(controlAccounts.nhilOutput, 'NHIL Payable'), amount: totals.nhil, type: 'credit' });
    entries.push({ accountCode: controlAccounts.getFundOutput, accountName: nameOf(controlAccounts.getFundOutput, 'GETFund Payable'), amount: totals.getFund, type: 'credit' });
  } else {
    for (const [accountCode, amount] of Object.entries(baseByAccount)) {
      entries.push({ accountCode, accountName: nameOf(accountCode, 'Expense'), amount, type: 'debit' });
    }

    entries.push({ accountCode: controlAccounts.vatInput, accountName: nameOf(controlAccounts.vatInput, 'VAT Input Tax Recoverable'), amount: totals.vat, type: 'debit' });
    entries.push({ accountCode: controlAccounts.nhilInput, accountName: nameOf(controlAccounts.nhilInput, 'NHIL Input Tax Recoverable'), amount: totals.nhil, type: 'debit' });
    entries.push({ accountCode: controlAccounts.getFundInput, accountName: nameOf(controlAccounts.getFundInput, 'GETFund Input Tax Recoverable'), amount: totals.getFund, type: 'debit' });

    entries.push({ accountCode: controlAccounts.payables, accountName: nameOf(controlAccounts.payables, 'Trade Payables'), amount: Math.max(totals.total - totals.withholdingTax, 0), type: 'credit' });

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
): JournalLineDraft[] {
  return buildJournalEntries(documentState, isPurchase, contact, accountNames).filter((line) => line.amount > 0);
}

/** YYYY-MM of a YYYY-MM-DD date string. */
export function periodOf(date: string): string {
  return date.slice(0, 7);
}
