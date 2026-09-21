/**
 * Sales contracts for the trading entities. Pure: no I/O, no Prisma.
 * Contract values, margin per contract (with foreign contracts shown at
 * the contract rate and at today's rate), the position report, and the
 * journal shapes for deliveries — ordinary, on-acceptance, and LBC gross
 * or net. The gross-versus-net choice is a setting a person makes; this
 * file only knows how to post each.
 */

import { convertMinor, type Currency } from './fx';
import { GRAMS_PER_KG, GRAMS_PER_TONNE, type StockUnit } from './inventory';
import type { TradingJournalLine } from './trading';

// --- accounts -----------------------------------------------------------------------------

export const contractAccounts = {
  receivables: '1010',
  goodsInTransit: '1050',
  cocobodReceivable: '1065',
  seedFundPayable: '2050',
  domesticSales: '4001',
  exportSales: '4005',
  buyerMargin: '4020',
  haulage: '4025',
  passThrough: '4030',
  costOfSales: '5025',
} as const;

export type SellingCostKind = 'transport-to-buyer' | 'port-handling' | 'export-permit' | 'levy' | 'other';
export const sellingCostKinds: SellingCostKind[] = ['transport-to-buyer', 'port-handling', 'export-permit', 'levy', 'other'];
export const sellingCostLabels: Record<SellingCostKind, string> = {
  'transport-to-buyer': 'Transport to buyer or port',
  'port-handling': 'Port handling',
  'export-permit': 'Export permit',
  levy: 'Levy',
  other: 'Other selling cost',
};

export type PriceUnit = Extract<StockUnit, 'kg' | 'bag' | 'tonne'>;
export const priceUnits: PriceUnit[] = ['kg', 'bag', 'tonne'];

// --- values ---------------------------------------------------------------------------------

function mulDiv(a: number, b: number, d: number): number {
  if (d <= 0) return 0;
  const numerator = BigInt(a) * BigInt(b);
  const denominator = BigInt(d);
  const sign = numerator < 0n ? -1n : 1n;
  const abs = numerator < 0n ? -numerator : numerator;
  return Number(sign * ((abs * 2n + denominator) / (denominator * 2n)));
}

function gramsPerPriceUnit(unit: PriceUnit, gramsPerBag: number): number {
  return unit === 'kg' ? GRAMS_PER_KG : unit === 'tonne' ? GRAMS_PER_TONNE : gramsPerBag;
}

/** Value of a weight at the contract price, in the contract currency's minor units, half-up. */
export function contractValueMinor(grams: number, priceMinor: number, priceUnit: PriceUnit, gramsPerBag: number): number {
  return mulDiv(grams, priceMinor, gramsPerPriceUnit(priceUnit, gramsPerBag));
}

/** Per-kg figure from a total and a weight, minor units, half-up. */
export function perKg(totalMinor: number, grams: number): number {
  return grams > 0 ? mulDiv(totalMinor, GRAMS_PER_KG, grams) : 0;
}

// --- margin -----------------------------------------------------------------------------------

export type ContractLike = {
  quantityGrams: number;
  priceMinor: number;
  priceUnit: PriceUnit;
  currency: Currency;
  /** Functional per 1 unit of currency at signing; null for a functional-currency contract. */
  contractRate: string | null;
};

export type DeliveryLike = {
  grams: number;
  revenueTxnMinor: number;
  /** Functional, fixed at the delivery-date rate. */
  revenueMinor: number;
  costMinor: number;
  marginMinor: number;
  haulageMinor: number;
  /** Only recognised deliveries count towards revenue and cost. */
  recognised: boolean;
};

export type RateView = { rate: string; revenueMinor: number; grossMarginMinor: number; marginPerKgMinor: number };

export type ContractMargin = {
  deliveredGrams: number;
  recognisedGrams: number;
  undeliveredGrams: number;
  /** Contract currency. */
  revenueTxnMinor: number;
  /** Functional, as posted. */
  revenueMinor: number;
  costMinor: number;
  sellingMinor: number;
  /** LBC: buyer's margin and haulage on recognised deliveries. */
  allowancesMinor: number;
  grossMarginMinor: number;
  marginPerKgMinor: number;
  /** Foreign contracts only: the same recognised revenue restated at the contract rate and at today's. */
  atContractRate: RateView | null;
  atTodayRate: RateView | null;
  /** Foreign contracts only: the undelivered balance, at each rate, and the difference. */
  exposure: { undeliveredTxnMinor: number; atContractRateMinor: number | null; atTodayRateMinor: number | null; differenceMinor: number | null } | null;
};

/**
 * Margin per contract. Revenue and cost are what the recognised deliveries
 * posted; selling costs are the attributed bill lines. For a foreign
 * contract the recognised revenue is also restated at the contract rate and
 * at today's rate so the FX effect is visible; the undelivered balance is
 * valued at both to show the exposure still open.
 */
export function contractMargin(
  contract: ContractLike,
  deliveries: DeliveryLike[],
  sellingCosts: { amountMinor: number }[],
  functionalCurrency: Currency,
  gramsPerBag: number,
  todayRate: string | null,
): ContractMargin {
  const recognised = deliveries.filter((d) => d.recognised);
  const deliveredGrams = deliveries.reduce((s, d) => s + d.grams, 0);
  const recognisedGrams = recognised.reduce((s, d) => s + d.grams, 0);
  const undeliveredGrams = Math.max(contract.quantityGrams - deliveredGrams, 0);
  const revenueTxnMinor = recognised.reduce((s, d) => s + d.revenueTxnMinor, 0);
  const revenueMinor = recognised.reduce((s, d) => s + d.revenueMinor, 0);
  const costMinor = recognised.reduce((s, d) => s + d.costMinor, 0);
  const allowancesMinor = recognised.reduce((s, d) => s + d.marginMinor + d.haulageMinor, 0);
  const sellingMinor = sellingCosts.reduce((s, c) => s + c.amountMinor, 0);
  const grossMarginMinor = revenueMinor + allowancesMinor - costMinor - sellingMinor;

  const foreign = contract.currency !== functionalCurrency;
  const view = (rate: string | null): RateView | null => {
    if (!foreign || !rate) return null;
    const restated = convertMinor(revenueTxnMinor, rate);
    const margin = restated + allowancesMinor - costMinor - sellingMinor;
    return { rate, revenueMinor: restated, grossMarginMinor: margin, marginPerKgMinor: perKg(margin, recognisedGrams) };
  };
  const undeliveredTxnMinor = contractValueMinor(undeliveredGrams, contract.priceMinor, contract.priceUnit, gramsPerBag);
  const atContract = foreign && contract.contractRate ? convertMinor(undeliveredTxnMinor, contract.contractRate) : null;
  const atToday = foreign && todayRate ? convertMinor(undeliveredTxnMinor, todayRate) : null;

  return {
    deliveredGrams,
    recognisedGrams,
    undeliveredGrams,
    revenueTxnMinor,
    revenueMinor,
    costMinor,
    sellingMinor,
    allowancesMinor,
    grossMarginMinor,
    marginPerKgMinor: perKg(grossMarginMinor, recognisedGrams),
    atContractRate: view(contract.contractRate),
    atTodayRate: view(todayRate),
    exposure: foreign ? { undeliveredTxnMinor, atContractRateMinor: atContract, atTodayRateMinor: atToday, differenceMinor: atContract !== null && atToday !== null ? atToday - atContract : null } : null,
  };
}

// --- position -----------------------------------------------------------------------------------

export type PositionRow = {
  itemId: string;
  contractedGrams: number;
  deliveredGrams: number;
  undeliveredGrams: number;
  onHandGrams: number;
  /** on hand − undelivered: negative means sold more than held. */
  netGrams: number;
  status: 'oversold' | 'covered' | 'unsold' | 'idle';
};

/**
 * Contracted-but-undelivered against stock on hand, per grade. Open
 * contracts only; a closed or cancelled contract commits nothing.
 */
export function positionReport(
  contracts: { itemId: string; status: 'open' | 'closed' | 'cancelled'; quantityGrams: number; deliveredGrams: number }[],
  balances: { itemId: string; quantityGrams: number }[],
  itemIds: string[],
): PositionRow[] {
  return itemIds.map((itemId) => {
    const open = contracts.filter((c) => c.itemId === itemId && c.status === 'open');
    const contractedGrams = open.reduce((s, c) => s + c.quantityGrams, 0);
    const deliveredGrams = open.reduce((s, c) => s + Math.min(c.deliveredGrams, c.quantityGrams), 0);
    const undeliveredGrams = contractedGrams - deliveredGrams;
    const onHandGrams = balances.filter((b) => b.itemId === itemId).reduce((s, b) => s + b.quantityGrams, 0);
    const netGrams = onHandGrams - undeliveredGrams;
    const status: PositionRow['status'] = netGrams < 0 ? 'oversold' : undeliveredGrams === 0 ? (onHandGrams > 0 ? 'unsold' : 'idle') : netGrams > 0 ? 'unsold' : 'covered';
    return { itemId, contractedGrams, deliveredGrams, undeliveredGrams, onHandGrams, netGrams, status };
  });
}

// --- journals ----------------------------------------------------------------------------------------

const nameOf = (names: Record<string, string>, code: string, fallback: string) => names[code] ?? fallback;
function line(names: Record<string, string>, accountCode: string, fallback: string, amount: number, type: 'debit' | 'credit'): TradingJournalLine {
  return { accountCode, accountName: nameOf(names, accountCode, fallback), amount, type };
}

export type LbcTerms = { presentation: 'gross' | 'net'; marginMinor: number; haulageMinor: number };

export type DeliveryJournalInput = {
  revenueMinor: number;
  costMinor: number;
  inventoryCode: string;
  saleType: 'domestic' | 'export';
  /** On acceptance terms the delivery only moves stock to Goods in Transit; revenue waits. */
  recognizeOn: 'delivery' | 'acceptance';
  lbc: LbcTerms | null;
  names: Record<string, string>;
};

/**
 * The journal a delivery posts. Zero-amount lines are dropped.
 *
 *  ordinary, on delivery:   Dr Receivables / Cr Sales;  Dr COGS / Cr Inventory
 *  ordinary, on acceptance: Dr Goods in Transit / Cr Inventory  (revenue at acceptance)
 *  LBC gross:  Dr COCOBOD Receivable (value + margin + haulage) / Cr Sales (value), Cr Buyer's Margin, Cr Haulage;  Dr COGS / Cr Inventory
 *  LBC net:    Dr COCOBOD Receivable (value + margin + haulage) / Cr Inventory (cost), Cr Buyer's Margin, Cr Haulage, and the
 *              difference between value and cost to Cocoa Pass-through — no sales, no COGS
 */
export function deliveryJournal(input: DeliveryJournalInput): TradingJournalLine[] {
  const { names } = input;
  const lines: TradingJournalLine[] = [];
  const push = (l: TradingJournalLine) => { if (l.amount > 0) lines.push(l); };

  if (input.lbc) {
    const receivable = input.revenueMinor + input.lbc.marginMinor + input.lbc.haulageMinor;
    push(line(names, contractAccounts.cocobodReceivable, 'COCOBOD Receivable', receivable, 'debit'));
    push(line(names, contractAccounts.buyerMargin, "Buyer's Margin (COCOBOD)", input.lbc.marginMinor, 'credit'));
    push(line(names, contractAccounts.haulage, 'Haulage Allowance (COCOBOD)', input.lbc.haulageMinor, 'credit'));
    if (input.lbc.presentation === 'gross') {
      push(line(names, contractAccounts.domesticSales, 'Domestic Sales', input.revenueMinor, 'credit'));
      push(line(names, contractAccounts.costOfSales, 'Cost of Goods Sold', input.costMinor, 'debit'));
      push(line(names, input.inventoryCode, 'Inventory', input.costMinor, 'credit'));
    } else {
      push(line(names, input.inventoryCode, 'Inventory', input.costMinor, 'credit'));
      const difference = input.revenueMinor - input.costMinor;
      push(line(names, contractAccounts.passThrough, 'Cocoa Pass-through (net presentation)', Math.abs(difference), difference >= 0 ? 'credit' : 'debit'));
    }
    return lines;
  }

  if (input.recognizeOn === 'acceptance') {
    push(line(names, contractAccounts.goodsInTransit, 'Goods in Transit', input.costMinor, 'debit'));
    push(line(names, input.inventoryCode, 'Inventory', input.costMinor, 'credit'));
    return lines;
  }

  const salesCode = input.saleType === 'export' ? contractAccounts.exportSales : contractAccounts.domesticSales;
  push(line(names, contractAccounts.receivables, 'Trade Receivables', input.revenueMinor, 'debit'));
  push(line(names, salesCode, input.saleType === 'export' ? 'Export Sales' : 'Domestic Sales', input.revenueMinor, 'credit'));
  push(line(names, contractAccounts.costOfSales, 'Cost of Goods Sold', input.costMinor, 'debit'));
  push(line(names, input.inventoryCode, 'Inventory', input.costMinor, 'credit'));
  return lines;
}

/** Acceptance of an on-acceptance delivery: revenue now, cost out of Goods in Transit. */
export function acceptanceJournal(revenueMinor: number, costMinor: number, saleType: 'domestic' | 'export', names: Record<string, string>): TradingJournalLine[] {
  const salesCode = saleType === 'export' ? contractAccounts.exportSales : contractAccounts.domesticSales;
  return [
    line(names, contractAccounts.receivables, 'Trade Receivables', revenueMinor, 'debit'),
    line(names, salesCode, saleType === 'export' ? 'Export Sales' : 'Domestic Sales', revenueMinor, 'credit'),
    line(names, contractAccounts.costOfSales, 'Cost of Goods Sold', costMinor, 'debit'),
    line(names, contractAccounts.goodsInTransit, 'Goods in Transit', costMinor, 'credit'),
  ].filter((l) => l.amount > 0);
}

export type SeedFundKind = 'received' | 'repaid' | 'offset';

/** Seed funds: a liability to COCOBOD from the day they arrive, never income. */
export function seedFundJournal(kind: SeedFundKind, amountMinor: number, bankCode: string | null, names: Record<string, string>): TradingJournalLine[] {
  if (amountMinor <= 0) return [];
  switch (kind) {
    case 'received':
      return [line(names, bankCode ?? '1001', 'Bank', amountMinor, 'debit'), line(names, contractAccounts.seedFundPayable, 'COCOBOD Seed Fund Payable', amountMinor, 'credit')];
    case 'repaid':
      return [line(names, contractAccounts.seedFundPayable, 'COCOBOD Seed Fund Payable', amountMinor, 'debit'), line(names, bankCode ?? '1001', 'Bank', amountMinor, 'credit')];
    case 'offset':
      return [line(names, contractAccounts.seedFundPayable, 'COCOBOD Seed Fund Payable', amountMinor, 'debit'), line(names, contractAccounts.cocobodReceivable, 'COCOBOD Receivable', amountMinor, 'credit')];
  }
}

/** CMC pays for cocoa delivered: bank in, receivable down. */
export function cmcReceiptJournal(amountMinor: number, bankCode: string, names: Record<string, string>): TradingJournalLine[] {
  if (amountMinor <= 0) return [];
  return [line(names, bankCode, 'Bank', amountMinor, 'debit'), line(names, contractAccounts.cocobodReceivable, 'COCOBOD Receivable', amountMinor, 'credit')];
}

export function journalBalanced(lines: TradingJournalLine[]): boolean {
  const debits = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
  return debits === credits;
}
