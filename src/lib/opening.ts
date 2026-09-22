/**
 * Opening balances: moving an entity onto the app at a cut-over date. Pure.
 *
 * The rule that makes it safe: the trial balance posts with every control
 * account redirected to 3090 Opening Balance Suspense, and each detail
 * import posts to its control account against suspense. Suspense is then
 * exactly the difference between the detail and the trial balance, and an
 * entity may not go live until it is zero.
 */

import { convertMinor, type Currency } from './fx';
import type { TradingJournalLine } from './trading';

export const openingAccounts = {
  suspense: '3090',
  receivables: '1010',
  payables: '2001',
  agentFloats: '1060',
  farmerAdvances: '1070',
} as const;

export type OpeningSection = 'trial-balance' | 'invoices' | 'bills' | 'stock' | 'floats' | 'farmer-advances' | 'contracts';
export const openingSections: OpeningSection[] = ['trial-balance', 'invoices', 'bills', 'stock', 'floats', 'farmer-advances', 'contracts'];
export const sectionLabels: Record<OpeningSection, string> = {
  'trial-balance': 'Opening trial balance',
  invoices: 'Unpaid customer invoices',
  bills: 'Unpaid supplier bills',
  stock: 'Stock on hand',
  floats: 'Outstanding agent floats',
  'farmer-advances': 'Outstanding farmer advances',
  contracts: 'Open sales contracts',
};

// --- rows, as parsed from the sheets -------------------------------------------------------------

export type TrialBalanceRow = {
  row: number;
  accountCode: string;
  currency: Currency;
  /** Signed, minor units of `currency`: positive is money in (a debit balance), negative money out. */
  amountMinor: number;
  /** Functional per 1 unit of currency at the cut-over date; '1.0' for the functional currency. */
  rate: string;
  note: string;
};
export type OpenDocumentRow = { row: number; number: string; contactName: string; date: string; dueDate: string; currency: Currency; outstandingMinor: number; rate: string; note: string };
export type StockRow = { row: number; commodityCode: string; grade: string; locationCode: string; grams: number; valueMinor: number; lotRef: string };
export type FloatRow = { row: number; agentName: string; date: string; amountMinor: number; note: string };
export type FarmerAdvanceRow = { row: number; farmerName: string; community: string; district: string; date: string; amountMinor: number; note: string };
export type ContractRow = {
  row: number;
  contractNo: string;
  buyerName: string;
  commodityCode: string;
  grade: string;
  grams: number;
  priceMinor: number;
  priceUnit: 'kg' | 'bag' | 'tonne';
  currency: Currency;
  contractRate: string | null;
  deliveryTerms: string;
  deliveryFrom: string;
  deliveryTo: string;
  recognizeOn: 'delivery' | 'acceptance';
  saleType: 'domestic' | 'export';
  deliveredGrams: number;
};

export type RowError = { row: number; message: string };

// --- the trial balance -------------------------------------------------------------------------

export type TrialBalanceCheck = {
  functionalRows: { accountCode: string; amountMinor: number; currency: Currency; txnAmountMinor: number; rate: string }[];
  debitsMinor: number;
  creditsMinor: number;
  differenceMinor: number;
  balances: boolean;
  errors: RowError[];
};

/**
 * Convert every row to functional currency and check the whole thing
 * balances. A foreign row without a rate, or a code not in the chart, is an
 * error; a trial balance that does not balance is refused, not "fixed".
 */
export function checkTrialBalance(rows: TrialBalanceRow[], chartCodes: Set<string>, functionalCurrency: Currency): TrialBalanceCheck {
  const errors: RowError[] = [];
  const functionalRows: TrialBalanceCheck['functionalRows'] = [];
  for (const r of rows) {
    if (!chartCodes.has(r.accountCode)) errors.push({ row: r.row, message: `Account ${r.accountCode} is not in this entity's chart.` });
    if (r.amountMinor === 0) errors.push({ row: r.row, message: 'Amount is zero.' });
    if (r.currency !== functionalCurrency && (!r.rate || r.rate === '1.0' || Number(r.rate) <= 0)) errors.push({ row: r.row, message: `A ${r.currency} balance needs the ${r.currency}→${functionalCurrency} rate at the cut-over date.` });
    if (r.accountCode === openingAccounts.suspense) errors.push({ row: r.row, message: 'The suspense account is not an opening balance; leave it out.' });
    const amountMinor = r.currency === functionalCurrency ? r.amountMinor : convertMinor(r.amountMinor, r.rate);
    functionalRows.push({ accountCode: r.accountCode, amountMinor, currency: r.currency, txnAmountMinor: r.amountMinor, rate: r.currency === functionalCurrency ? '1.0' : r.rate });
  }
  const debitsMinor = functionalRows.filter((r) => r.amountMinor > 0).reduce((s, r) => s + r.amountMinor, 0);
  const creditsMinor = functionalRows.filter((r) => r.amountMinor < 0).reduce((s, r) => s - r.amountMinor, 0);
  const differenceMinor = debitsMinor - creditsMinor;
  return { functionalRows, debitsMinor, creditsMinor, differenceMinor, balances: differenceMinor === 0, errors };
}

/**
 * The opening journal: every account at its balance, except that control
 * accounts are redirected to suspense. The detail imports post to the
 * control accounts against suspense afterwards.
 */
export function trialBalanceJournal(rows: TrialBalanceCheck['functionalRows'], controlCodes: Set<string>, names: Record<string, string>): TradingJournalLine[] {
  const lines: TradingJournalLine[] = [];
  let suspense = 0;
  for (const r of rows) {
    if (controlCodes.has(r.accountCode)) {
      suspense += r.amountMinor;
      continue;
    }
    lines.push({ accountCode: r.accountCode, accountName: names[r.accountCode] ?? r.accountCode, amount: Math.abs(r.amountMinor), type: r.amountMinor > 0 ? 'debit' : 'credit' });
  }
  if (suspense !== 0) lines.push({ accountCode: openingAccounts.suspense, accountName: names[openingAccounts.suspense] ?? 'Opening Balance Suspense', amount: Math.abs(suspense), type: suspense > 0 ? 'debit' : 'credit' });
  return lines;
}

/** The trial balance's figure for a set of control codes, functional, signed (debit positive). */
export function controlFigure(rows: { accountCode: string; amountMinor: number }[], codes: Set<string>): number {
  return rows.filter((r) => codes.has(r.accountCode)).reduce((s, r) => s + r.amountMinor, 0);
}

// --- detail journals --------------------------------------------------------------------------------

const nameOf = (names: Record<string, string>, code: string, fallback: string) => names[code] ?? fallback;

/** A detail item to a control account against suspense. Debit-balance controls (receivables, stock, floats) debit the control. */
export function detailJournal(controlCode: string, amountMinor: number, debitBalance: boolean, names: Record<string, string>): TradingJournalLine[] {
  if (amountMinor <= 0) return [];
  const control = { accountCode: controlCode, accountName: nameOf(names, controlCode, controlCode), amount: amountMinor };
  const suspense = { accountCode: openingAccounts.suspense, accountName: nameOf(names, openingAccounts.suspense, 'Opening Balance Suspense'), amount: amountMinor };
  return debitBalance ? [{ ...control, type: 'debit' }, { ...suspense, type: 'credit' }] : [{ ...suspense, type: 'debit' }, { ...control, type: 'credit' }];
}

// --- the checklist ---------------------------------------------------------------------------------------

export type ControlReconciliation = { label: string; trialBalanceMinor: number; detailMinor: number; differenceMinor: number; reconciles: boolean };

export type ChecklistInput = {
  cutOverDate: string | null;
  liveAt: string | null;
  trialBalancePosted: boolean;
  trialBalanceBalances: boolean;
  controls: ControlReconciliation[];
  suspenseMinor: number;
  foreignRowsWithoutRate: number;
  contractsPosted: boolean;
  contractsCount: number;
};

export type ChecklistItem = { key: string; label: string; done: boolean; detail: string };

/** What must be true before an entity goes live, in order, with why it is not yet. */
export function goLiveChecklist(input: ChecklistInput): { items: ChecklistItem[]; canGoLive: boolean } {
  const items: ChecklistItem[] = [
    { key: 'cutover', label: 'Cut-over date set', done: !!input.cutOverDate, detail: input.cutOverDate ?? 'Choose the date the opening balances are as at.' },
    { key: 'tb', label: 'Opening trial balance posted and balanced', done: input.trialBalancePosted && input.trialBalanceBalances, detail: input.trialBalancePosted ? 'Posted.' : 'Upload the trial balance sheet and post it.' },
    ...input.controls.map((c) => ({ key: c.label, label: `${c.label} detail equals the trial balance`, done: c.reconciles, detail: c.reconciles ? `${(c.detailMinor / 100).toFixed(2)} both sides.` : `Trial balance ${(c.trialBalanceMinor / 100).toFixed(2)}, detail ${(c.detailMinor / 100).toFixed(2)}, difference ${(c.differenceMinor / 100).toFixed(2)}.` })),
    { key: 'fx', label: 'Every foreign-currency balance has its cut-over rate', done: input.foreignRowsWithoutRate === 0, detail: input.foreignRowsWithoutRate === 0 ? 'All rated.' : `${input.foreignRowsWithoutRate} row(s) without a rate.` },
    { key: 'contracts', label: 'Open sales contracts imported', done: input.contractsPosted || input.contractsCount === 0, detail: input.contractsPosted ? `${input.contractsCount} contract(s).` : 'Optional: upload the contracts sheet if there are open contracts.' },
    { key: 'suspense', label: 'Opening Balance Suspense is zero', done: input.suspenseMinor === 0, detail: input.suspenseMinor === 0 ? 'Zero.' : `${(input.suspenseMinor / 100).toFixed(2)} in suspense — the detail does not match the trial balance.` },
  ];
  const canGoLive = !input.liveAt && items.filter((i) => i.key !== 'contracts').every((i) => i.done);
  return { items, canGoLive };
}
