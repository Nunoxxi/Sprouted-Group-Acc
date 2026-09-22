/**
 * Mobile money and farmer payments. Pure: no I/O, no Prisma.
 *
 * A wallet is an ordinary bank account. A statement is parsed with a named
 * column mapping, the transaction fee and any levy are split off each line
 * so what remains is the amount that actually moved, and the charges post
 * to one charges account rather than being left as unmatched differences.
 *
 * Farmer advances are receivables recovered from the next amount payable;
 * a purchase records what it recovered and what is left owing.
 */

import type { TradingJournalLine } from './trading';

// --- accounts -------------------------------------------------------------------------------

export const momoAccounts = {
  /** Owed to farmers for produce received but not yet paid. */
  farmerPayables: '2060',
  /** Pre-season advances to farmers. */
  farmerAdvances: '1070',
  /** Mobile money transaction fees and levies. */
  charges: '6050',
} as const;

export type BankAccountKind = 'bank' | 'mobile-money' | 'cash';
export const bankAccountKinds: BankAccountKind[] = ['bank', 'mobile-money', 'cash'];
export const bankAccountKindLabels: Record<BankAccountKind, string> = { bank: 'Bank account', 'mobile-money': 'Mobile money wallet', cash: 'Cash' };

// --- statement mappings ------------------------------------------------------------------------

export type StatementMapping = {
  name: string;
  dateColumn: string;
  descriptionColumn: string;
  referenceColumn: string | null;
  /** One signed amount column, or separate money-in and money-out columns. */
  amountColumn: string | null;
  moneyInColumn: string | null;
  moneyOutColumn: string | null;
  feeColumn: string | null;
  levyColumn: string | null;
  balanceColumn: string | null;
  /** Descriptions containing one of these are charge lines in their own right. */
  chargeKeywords: string[];
  dateFormat: string;
};

/** The mappings the Ghanaian providers' exports need, ready to use. */
export const defaultMappings: StatementMapping[] = [
  {
    name: 'MTN MoMo (merchant statement)',
    dateColumn: 'Date', descriptionColumn: 'Description', referenceColumn: 'Transaction ID',
    amountColumn: null, moneyInColumn: 'Credit', moneyOutColumn: 'Debit', feeColumn: 'Fee', levyColumn: 'E-Levy', balanceColumn: 'Balance',
    chargeKeywords: ['charge', 'fee', 'levy', 'commission'], dateFormat: 'YYYY-MM-DD',
  },
  {
    name: 'Telecel Cash',
    dateColumn: 'Transaction Date', descriptionColumn: 'Details', referenceColumn: 'Reference',
    amountColumn: 'Amount', moneyInColumn: null, moneyOutColumn: null, feeColumn: 'Charge', levyColumn: 'Levy', balanceColumn: 'Running Balance',
    chargeKeywords: ['charge', 'fee', 'levy'], dateFormat: 'DD/MM/YYYY',
  },
  {
    name: 'AT Money',
    dateColumn: 'DATE', descriptionColumn: 'NARRATION', referenceColumn: 'TRANS ID',
    amountColumn: 'AMOUNT', moneyInColumn: null, moneyOutColumn: null, feeColumn: 'FEES', levyColumn: null, balanceColumn: 'BALANCE',
    chargeKeywords: ['charge', 'fee', 'levy'], dateFormat: 'DD-MMM-YYYY',
  },
];

// --- CSV --------------------------------------------------------------------------------------

/** Split a CSV line, honouring quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { value += '"'; i++; }
      else if (ch === '"') quoted = false;
      else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(value.trim()); value = ''; }
    else value += ch;
  }
  out.push(value.trim());
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Read a date in the mapping's format (or anything ISO-like) to YYYY-MM-DD; null when unreadable. */
export function parseStatementDate(raw: string, format: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const named = /^(\d{1,2})[-/\s]([A-Za-z]{3,})[-/\s](\d{2,4})/.exec(text);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase());
    if (month < 0) return null;
    const year = named[3].length === 2 ? `20${named[3]}` : named[3];
    return `${year}-${String(month + 1).padStart(2, '0')}-${named[1].padStart(2, '0')}`;
  }
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(text);
  if (numeric) {
    const [, a, b, c] = numeric;
    const year = c.length === 2 ? `20${c}` : c;
    // MM/DD only when the first part cannot be a day-of-month in this format.
    const dayFirst = !format.toUpperCase().startsWith('MM');
    const day = dayFirst ? a : b;
    const month = dayFirst ? b : a;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return null;
}

/** An amount cell to minor units; blanks are zero. Handles 1,234.56, (123.45) and trailing CR/DR. */
export function parseAmountMinor(raw: string): number | null {
  let text = raw.trim().replace(/[₵$€]/g, '').replace(/\b(GHS|USD|EUR)\b/gi, '').replace(/,/g, '').trim();
  if (!text) return 0;
  let sign = 1;
  if (/^\(.*\)$/.test(text)) { sign = -1; text = text.slice(1, -1).trim(); }
  if (/\bDR\b/i.test(text)) sign = -1;
  text = text.replace(/\b(DR|CR)\b/gi, '').trim();
  if (text.startsWith('-') || text.endsWith('-')) { sign = -1; text = text.replace(/-/g, '').trim(); }
  if (!text) return 0;
  // Anything still not a plain number is unreadable, and must not quietly become zero.
  if (!/^\+?\d+(\.\d+)?$/.test(text)) return null;
  return sign * Math.round(Number(text) * 100);
}

export type ParsedStatementLine = {
  row: number;
  date: string;
  description: string;
  reference: string | null;
  /** Signed, net of fee and levy: what actually moved on the wallet. */
  amountMinor: number;
  feeMinor: number;
  levyMinor: number;
  balanceMinor: number | null;
  /** A line that is itself a charge, not a transfer. */
  isCharge: boolean;
};

export type StatementParse = { lines: ParsedStatementLine[]; errors: { row: number; message: string }[]; feeTotalMinor: number };

/**
 * Parse a statement CSV with a mapping.
 *
 * Fees and levies are taken out of the line: a GH₵1,000 payment that cost
 * GH₵5 in fee and GH₵10 in levy leaves the wallet GH₵1,015 lighter, so the
 * line's own amount stays GH₵1,000 (matching the payment) and GH₵15 goes to
 * charges. A line that is only a charge is marked as such and its whole
 * amount goes to charges.
 */
export function parseStatement(csv: string, mapping: StatementMapping): StatementParse {
  const rows = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (rows.length === 0) return { lines: [], errors: [{ row: 0, message: 'The file is empty.' }], feeTotalMinor: 0 };
  const headers = splitCsvLine(rows[0]).map((h) => h.trim());
  const indexOf = (name: string | null) => (name ? headers.findIndex((h) => h.toLowerCase() === name.toLowerCase()) : -1);
  const columns = {
    date: indexOf(mapping.dateColumn),
    description: indexOf(mapping.descriptionColumn),
    reference: indexOf(mapping.referenceColumn),
    amount: indexOf(mapping.amountColumn),
    moneyIn: indexOf(mapping.moneyInColumn),
    moneyOut: indexOf(mapping.moneyOutColumn),
    fee: indexOf(mapping.feeColumn),
    levy: indexOf(mapping.levyColumn),
    balance: indexOf(mapping.balanceColumn),
  };
  const errors: { row: number; message: string }[] = [];
  if (columns.date < 0) errors.push({ row: 1, message: `No "${mapping.dateColumn}" column in the file.` });
  if (columns.description < 0) errors.push({ row: 1, message: `No "${mapping.descriptionColumn}" column in the file.` });
  if (columns.amount < 0 && columns.moneyIn < 0 && columns.moneyOut < 0) errors.push({ row: 1, message: 'No amount column: the mapping needs an amount, or money in and money out.' });
  if (errors.length) return { lines: [], errors, feeTotalMinor: 0 };

  const lines: ParsedStatementLine[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = splitCsvLine(rows[i]);
    const row = i + 1;
    const date = parseStatementDate(cells[columns.date] ?? '', mapping.dateFormat);
    const description = (cells[columns.description] ?? '').trim();
    if (!date && !description) continue; // a blank or footer row
    if (!date) { errors.push({ row, message: `Could not read the date "${cells[columns.date] ?? ''}".` }); continue; }

    let amountMinor: number | null;
    if (columns.amount >= 0) {
      amountMinor = parseAmountMinor(cells[columns.amount] ?? '');
    } else {
      const inMinor = columns.moneyIn >= 0 ? parseAmountMinor(cells[columns.moneyIn] ?? '') : 0;
      const outMinor = columns.moneyOut >= 0 ? parseAmountMinor(cells[columns.moneyOut] ?? '') : 0;
      amountMinor = inMinor === null || outMinor === null ? null : Math.abs(inMinor) - Math.abs(outMinor);
    }
    if (amountMinor === null) { errors.push({ row, message: 'Could not read the amount.' }); continue; }
    const feeMinor = columns.fee >= 0 ? Math.abs(parseAmountMinor(cells[columns.fee] ?? '') ?? 0) : 0;
    const levyMinor = columns.levy >= 0 ? Math.abs(parseAmountMinor(cells[columns.levy] ?? '') ?? 0) : 0;
    const balanceMinor = columns.balance >= 0 ? parseAmountMinor(cells[columns.balance] ?? '') : null;
    const isCharge = mapping.chargeKeywords.some((word) => word && description.toLowerCase().includes(word.toLowerCase()));
    if (amountMinor === 0 && feeMinor === 0 && levyMinor === 0) continue;
    lines.push({
      row,
      date,
      description,
      reference: columns.reference >= 0 ? (cells[columns.reference] ?? '').trim() || null : null,
      amountMinor,
      feeMinor,
      levyMinor,
      balanceMinor,
      isCharge,
    });
  }
  return { lines, errors, feeTotalMinor: lines.reduce((s, l) => s + l.feeMinor + l.levyMinor + (l.isCharge ? Math.abs(l.amountMinor) : 0), 0) };
}

// --- journals -----------------------------------------------------------------------------------

const nameOf = (names: Record<string, string>, code: string, fallback: string) => names[code] ?? fallback;
const line = (names: Record<string, string>, accountCode: string, fallback: string, amount: number, type: 'debit' | 'credit'): TradingJournalLine => ({ accountCode, accountName: nameOf(names, accountCode, fallback), amount, type });

/** Fees and levies on an import: charges out of the wallet, in one journal. */
export function chargesJournal(totalMinor: number, walletCode: string, names: Record<string, string>): TradingJournalLine[] {
  if (totalMinor <= 0) return [];
  return [
    line(names, momoAccounts.charges, 'Mobile Money Charges & Levies', totalMinor, 'debit'),
    line(names, walletCode, 'Wallet', totalMinor, 'credit'),
  ];
}

/**
 * A purchase with an advance recovered from it: stock comes in at the full
 * price, the advance recovered comes off the receivable, and only the net
 * is settled — from the agent's float if the agent paid on the spot, or as
 * a payable to the farmer if a batch will pay it later.
 */
export function purchaseJournal(priceMinor: number, recoveredMinor: number, inventoryCode: string, settlementCode: string, settlementName: string, names: Record<string, string>): TradingJournalLine[] {
  const lines: TradingJournalLine[] = [line(names, inventoryCode, 'Inventory', priceMinor, 'debit')];
  if (recoveredMinor > 0) lines.push(line(names, momoAccounts.farmerAdvances, 'Farmer Advances', recoveredMinor, 'credit'));
  const net = priceMinor - recoveredMinor;
  if (net > 0) lines.push(line(names, settlementCode, settlementName, net, 'credit'));
  return lines;
}

/** A purchase left payable: produce in, farmer owed, advance recovered. */
export function payablePurchaseJournal(priceMinor: number, recoveredMinor: number, inventoryCode: string, names: Record<string, string>): TradingJournalLine[] {
  return purchaseJournal(priceMinor, recoveredMinor, inventoryCode, momoAccounts.farmerPayables, 'Farmer Payables', names);
}

/** A batch paid out of a wallet: farmers' payables cleared, the fee to charges. */
export function batchSettlementJournal(totalMinor: number, feeMinor: number, walletCode: string, names: Record<string, string>): TradingJournalLine[] {
  const lines: TradingJournalLine[] = [];
  if (totalMinor > 0) lines.push(line(names, momoAccounts.farmerPayables, 'Farmer Payables', totalMinor, 'debit'));
  if (feeMinor > 0) lines.push(line(names, momoAccounts.charges, 'Mobile Money Charges & Levies', feeMinor, 'debit'));
  const outflow = totalMinor + feeMinor;
  if (outflow > 0) lines.push(line(names, walletCode, 'Wallet', outflow, 'credit'));
  return lines;
}

// --- advance recovery ------------------------------------------------------------------------------

export type OpenAdvance = { id: string; date: string; amountMinor: number; settledMinor: number };
export type Recovery = { advanceId: string; amountMinor: number };
export type RecoveryPlan = { recoveries: Recovery[]; recoveredMinor: number; payableMinor: number; remainingAdvanceMinor: number };

/**
 * What a purchase recovers: the farmer's open advances, oldest first, up to
 * what is payable. Never more than is owed, and never more than the purchase
 * is worth, so a payment cannot go negative.
 */
export function planRecovery(priceMinor: number, advances: OpenAdvance[]): RecoveryPlan {
  const open = [...advances].map((a) => ({ ...a, outstanding: a.amountMinor - a.settledMinor })).filter((a) => a.outstanding > 0).sort((a, b) => a.date.localeCompare(b.date));
  const totalOutstanding = open.reduce((s, a) => s + a.outstanding, 0);
  let left = Math.max(priceMinor, 0);
  const recoveries: Recovery[] = [];
  for (const advance of open) {
    if (left <= 0) break;
    const take = Math.min(advance.outstanding, left);
    recoveries.push({ advanceId: advance.id, amountMinor: take });
    left -= take;
  }
  const recoveredMinor = recoveries.reduce((s, r) => s + r.amountMinor, 0);
  return { recoveries, recoveredMinor, payableMinor: Math.max(priceMinor, 0) - recoveredMinor, remainingAdvanceMinor: totalOutstanding - recoveredMinor };
}

// --- the farmer's history ----------------------------------------------------------------------------

export type FarmerEvent =
  | { kind: 'delivery'; date: string; description: string; grams: number; grossMinor: number; recoveredMinor: number; payableMinor: number; paidMinor: number; reference: string; evidence: string }
  | { kind: 'advance'; date: string; description: string; amountMinor: number }
  | { kind: 'payment'; date: string; description: string; amountMinor: number; reference: string };

export type FarmerStatement = {
  events: FarmerEvent[];
  deliveries: number;
  gramsTotal: number;
  grossMinor: number;
  advancedMinor: number;
  recoveredMinor: number;
  paidMinor: number;
  /** Advances less recoveries: what the farmer still owes. */
  advanceOutstandingMinor: number;
  /** Payable less paid: what is still owed to the farmer. */
  payableOutstandingMinor: number;
};

/** One farmer's history, newest first, with the two balances that matter. */
export function farmerStatement(
  deliveries: { date: string; description: string; grams: number; grossMinor: number; recoveredMinor: number; payableMinor: number; paidMinor: number; reference: string; evidence: string }[],
  advances: { date: string; description: string; amountMinor: number }[],
  payments: { date: string; description: string; amountMinor: number; reference: string }[],
): FarmerStatement {
  const events: FarmerEvent[] = [
    ...deliveries.map((d) => ({ kind: 'delivery' as const, ...d })),
    ...advances.map((a) => ({ kind: 'advance' as const, ...a })),
    ...payments.map((p) => ({ kind: 'payment' as const, ...p })),
  ].sort((a, b) => b.date.localeCompare(a.date));

  const grossMinor = deliveries.reduce((s, d) => s + d.grossMinor, 0);
  const recoveredMinor = deliveries.reduce((s, d) => s + d.recoveredMinor, 0);
  const payableMinor = deliveries.reduce((s, d) => s + d.payableMinor, 0);
  const paidFromDeliveries = deliveries.reduce((s, d) => s + d.paidMinor, 0);
  const advancedMinor = advances.reduce((s, a) => s + a.amountMinor, 0);
  const paidMinor = paidFromDeliveries + payments.reduce((s, p) => s + p.amountMinor, 0);

  return {
    events,
    deliveries: deliveries.length,
    gramsTotal: deliveries.reduce((s, d) => s + d.grams, 0),
    grossMinor,
    advancedMinor,
    recoveredMinor,
    paidMinor,
    advanceOutstandingMinor: advancedMinor - recoveredMinor,
    payableOutstandingMinor: payableMinor - paidMinor,
  };
}

// --- bulk disbursement export --------------------------------------------------------------------------

export type DisbursementRow = { farmerName: string; walletNumber: string; amountMinor: number; reference: string };

/**
 * The CSV the provider's bulk disbursement takes: wallet, amount in major
 * units, a per-row reference, and the payee's name. One header row, no
 * currency symbols or thousands separators — providers reject both.
 */
export function disbursementCsv(batchReference: string, rows: DisbursementRow[]): string {
  const header = 'MSISDN,Amount,Reference,Name';
  const body = rows.map((r, i) => [r.walletNumber, (r.amountMinor / 100).toFixed(2), r.reference || `${batchReference}-${String(i + 1).padStart(3, '0')}`, r.farmerName.replace(/[",]/g, ' ')].join(','));
  return [header, ...body].join('\n');
}

// --- matching ----------------------------------------------------------------------------------------------

export type MatchCandidate = { id: string; reference: string; date: string; totalMinor: number; feeMinor: number };

/**
 * The batch a statement line settles: its reference if it appears in the
 * description or reference, otherwise the same total within three days. The
 * fee is already off the line, so the amounts compare directly.
 */
export function matchBatch(line: { date: string; description: string; reference: string | null; amountMinor: number }, candidates: MatchCandidate[]): MatchCandidate | null {
  const haystack = `${line.description} ${line.reference ?? ''}`.toLowerCase();
  const byReference = candidates.find((c) => c.reference && haystack.includes(c.reference.toLowerCase()));
  if (byReference) return byReference;
  const outflow = Math.abs(line.amountMinor);
  const within = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) <= 3 * 86_400_000;
  const sameAmount = candidates.filter((c) => c.totalMinor === outflow && within(c.date, line.date));
  return sameAmount.length === 1 ? sameAmount[0] : null;
}
