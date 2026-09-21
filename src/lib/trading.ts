/**
 * Commodity trading logic on top of inventory.ts: landed cost spread per
 * kilogram, moisture shrinkage within and beyond a tolerance, buying-agent
 * floats and their reconciliation. Pure: no I/O, no Prisma.
 *
 * Grams and minor units throughout; percentages are plain numbers.
 */

import { GRAMS_PER_KG, type StockPosition } from './inventory';

// --- who holds stock --------------------------------------------------------------------

/** Sprouted Roots is an impact programme and holds no stock at all. */
export function holdsStock(entityType: 'manufacturing' | 'programs'): boolean {
  return entityType === 'manufacturing';
}

export type CommodityKind = 'cashew' | 'cocoa' | 'other';
export const commodityKinds: CommodityKind[] = ['cashew', 'cocoa', 'other'];
export const commodityKindLabels: Record<CommodityKind, string> = { cashew: 'Raw cashew nuts', cocoa: 'Cocoa beans', other: 'Other' };

/** Quality fields per commodity, in the order the form shows them. */
export type QualityField = { key: 'kor' | 'moisturePct' | 'nutCount' | 'cocoaGrade' | 'beanCount'; label: string; unit: string; kind: 'number' | 'text' };
export function qualityFieldsFor(kind: CommodityKind): QualityField[] {
  switch (kind) {
    case 'cashew':
      return [
        { key: 'kor', label: 'Outturn (KOR)', unit: 'lb / 80 kg', kind: 'number' },
        { key: 'moisturePct', label: 'Moisture', unit: '%', kind: 'number' },
        { key: 'nutCount', label: 'Nut count', unit: 'per kg', kind: 'number' },
      ];
    case 'cocoa':
      return [
        { key: 'cocoaGrade', label: 'Grade', unit: '', kind: 'text' },
        { key: 'moisturePct', label: 'Moisture', unit: '%', kind: 'number' },
        { key: 'beanCount', label: 'Bean count', unit: 'per 100 g', kind: 'number' },
      ];
    default:
      return [{ key: 'moisturePct', label: 'Moisture', unit: '%', kind: 'number' }];
  }
}

export type Quality = { kor?: number | null; moisturePct?: number | null; nutCount?: number | null; cocoaGrade?: string | null; beanCount?: number | null };

/** Bags from grams for display and the reverse for entry. */
export function bagsOf(grams: number, gramsPerBag: number): number {
  return gramsPerBag > 0 ? grams / gramsPerBag : 0;
}

// --- landed cost ----------------------------------------------------------------------------

export const landedCostKinds = ['transport', 'bags', 'loading', 'fumigation', 'levy', 'commission'] as const;
export type LandedCostKind = (typeof landedCostKinds)[number];
export const landedCostLabels: Record<LandedCostKind, string> = {
  transport: 'Transport',
  bags: 'Bags',
  loading: 'Loading',
  fumigation: 'Fumigation',
  levy: 'Regulatory levy',
  commission: 'Agent commission',
};

/**
 * Spread an amount over weights, per kilogram: each share is amount ×
 * grams / total grams, whole minor units, the rounding remainder on the
 * heaviest. The shares always sum to the amount exactly.
 */
export function allocateByWeight(amountMinor: number, weights: { key: string; grams: number }[]): Record<string, number> {
  const result: Record<string, number> = {};
  const positive = weights.filter((w) => w.grams > 0);
  const total = positive.reduce((s, w) => s + w.grams, 0);
  if (amountMinor === 0 || total <= 0) {
    for (const w of weights) result[w.key] = 0;
    return result;
  }
  let remaining = amountMinor;
  let heaviest = positive[0];
  for (const w of positive) {
    const numerator = BigInt(amountMinor) * BigInt(w.grams);
    const denominator = BigInt(total);
    const sign = numerator < 0n ? -1n : 1n;
    const abs = numerator < 0n ? -numerator : numerator;
    const share = Number(sign * ((abs * 2n + denominator) / (denominator * 2n)));
    result[w.key] = share;
    remaining -= share;
    if (w.grams > heaviest.grams) heaviest = w;
  }
  result[heaviest.key] += remaining;
  for (const w of weights) if (!(w.key in result)) result[w.key] = 0;
  return result;
}

/** Landed cost per kg once capitalised: what the charge added to each kilogram. */
export function landedCostPerKgMinor(valueMinor: number, grams: number): number {
  if (grams <= 0) return 0;
  return Number((BigInt(valueMinor) * BigInt(GRAMS_PER_KG) * 2n + BigInt(grams)) / (BigInt(grams) * 2n));
}

// --- shrinkage --------------------------------------------------------------------------------

export type ShrinkageSplit = {
  /** Weight lost at this weigh-out. */
  lossGrams: number;
  /** Within the commodity's tolerance (cumulative over the lot): absorbed — quantity down, value unchanged. */
  normalGrams: number;
  /** Beyond it: stock loss expense at average cost. */
  abnormalGrams: number;
  /** The tolerance in grams for the whole lot. */
  allowanceGrams: number;
};

/**
 * Weight in vs weight out for a lot. The tolerance is a percentage of the
 * lot's weight in and applies once over the lot's life, so a second
 * weigh-out only gets what the first left of it.
 */
export function shrinkageSplit(gramsIn: number, alreadyShrunk: number, gramsOutNow: number, tolerancePct: number): ShrinkageSplit {
  if (gramsOutNow < 0 || alreadyShrunk < 0) throw new Error('Weights cannot be negative.');
  const remainingBefore = gramsIn - alreadyShrunk;
  if (gramsOutNow > remainingBefore) throw new Error(`Weight out (${gramsOutNow} g) exceeds what the lot still holds (${remainingBefore} g).`);
  const lossGrams = remainingBefore - gramsOutNow;
  const allowanceGrams = Math.floor((gramsIn * tolerancePct) / 100);
  const normalLeft = Math.max(allowanceGrams - alreadyShrunk, 0);
  const normalGrams = Math.min(lossGrams, normalLeft);
  return { lossGrams, normalGrams, abnormalGrams: lossGrams - normalGrams, allowanceGrams };
}

/** Value of abnormal loss at the grade's average cost across its locations. */
export function abnormalLossValue(abnormalGrams: number, position: StockPosition): number {
  if (abnormalGrams <= 0 || position.quantityGrams <= 0) return 0;
  return Number((BigInt(position.valueMinor) * BigInt(abnormalGrams) * 2n + BigInt(position.quantityGrams)) / (BigInt(position.quantityGrams) * 2n));
}

// --- accounts ---------------------------------------------------------------------------------

export const tradingAccounts = {
  /** Loss beyond the shrinkage tolerance; count differences and damage stay on 5030. */
  stockLoss: '5045',
  /** Cash advanced to buying agents, a receivable until reconciled. */
  agentFloats: '1060',
} as const;

export type TradingJournalLine = { accountCode: string; accountName: string; amount: number; type: 'debit' | 'credit' };
const nameOf = (names: Record<string, string>, code: string, fallback: string) => names[code] ?? fallback;

export function stockLossJournal(valueMinor: number, inventoryCode: string, names: Record<string, string>): TradingJournalLine[] {
  if (valueMinor <= 0) return [];
  return [
    { accountCode: tradingAccounts.stockLoss, accountName: nameOf(names, tradingAccounts.stockLoss, 'Stock Loss'), amount: valueMinor, type: 'debit' },
    { accountCode: inventoryCode, accountName: nameOf(names, inventoryCode, 'Inventory'), amount: valueMinor, type: 'credit' },
  ];
}

/** Float out: the agent owes it back in produce or cash. */
export function floatAdvanceJournal(amountMinor: number, bankCode: string, names: Record<string, string>): TradingJournalLine[] {
  return [
    { accountCode: tradingAccounts.agentFloats, accountName: nameOf(names, tradingAccounts.agentFloats, 'Agent Float Advances'), amount: amountMinor, type: 'debit' },
    { accountCode: bankCode, accountName: nameOf(names, bankCode, 'Bank'), amount: amountMinor, type: 'credit' },
  ];
}

/** Cash back from the agent. */
export function floatReturnJournal(amountMinor: number, bankCode: string, names: Record<string, string>): TradingJournalLine[] {
  return [
    { accountCode: bankCode, accountName: nameOf(names, bankCode, 'Bank'), amount: amountMinor, type: 'debit' },
    { accountCode: tradingAccounts.agentFloats, accountName: nameOf(names, tradingAccounts.agentFloats, 'Agent Float Advances'), amount: amountMinor, type: 'credit' },
  ];
}

/** Produce bought with the float: stock in, float relieved. */
export function agentPurchaseJournal(priceMinor: number, inventoryCode: string, names: Record<string, string>): TradingJournalLine[] {
  return [
    { accountCode: inventoryCode, accountName: nameOf(names, inventoryCode, 'Inventory'), amount: priceMinor, type: 'debit' },
    { accountCode: tradingAccounts.agentFloats, accountName: nameOf(names, tradingAccounts.agentFloats, 'Agent Float Advances'), amount: priceMinor, type: 'credit' },
  ];
}

// --- floats -----------------------------------------------------------------------------------------

export type FloatPosition = {
  advancedMinor: number;
  purchasedMinor: number;
  returnedMinor: number;
  /** advanced − purchases posted − cash returned. Zero means it reconciles. */
  outstandingMinor: number;
  ageDays: number;
  /** Outstanding and older than the entity's limit. */
  overdue: boolean;
  reconciles: boolean;
};

function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.UTC(Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)) - 1, Number(fromIso.slice(8, 10)));
  const to = Date.UTC(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)) - 1, Number(toIso.slice(8, 10)));
  return Math.floor((to - from) / 86_400_000);
}

/**
 * The reconciliation rule: what was advanced must equal what the agent
 * bought (posted purchases) plus what they handed back. Anything else is
 * outstanding, and outstanding past the age limit is flagged.
 */
export function floatPosition(advance: { amountMinor: number; date: string }, purchasedMinor: number, returnedMinor: number, asOf: string, ageLimitDays: number): FloatPosition {
  const outstandingMinor = advance.amountMinor - purchasedMinor - returnedMinor;
  const ageDays = daysBetween(advance.date, asOf);
  return {
    advancedMinor: advance.amountMinor,
    purchasedMinor,
    returnedMinor,
    outstandingMinor,
    ageDays,
    overdue: outstandingMinor !== 0 && ageDays > ageLimitDays,
    reconciles: outstandingMinor === 0,
  };
}

export type AgentFloatSummary = { agentId: string; agentName: string; openFloats: number; outstandingMinor: number; oldestAgeDays: number; overdue: boolean };

/** Per agent, across open floats: what is out, how old the oldest is, whether any is overdue. */
export function agentFloatSummaries(
  agents: { id: string; name: string }[],
  floats: { agentId: string; position: FloatPosition; status: 'open' | 'reconciled' }[],
): AgentFloatSummary[] {
  return agents.map((agent) => {
    const open = floats.filter((f) => f.agentId === agent.id && f.status === 'open');
    return {
      agentId: agent.id,
      agentName: agent.name,
      openFloats: open.length,
      outstandingMinor: open.reduce((s, f) => s + f.position.outstandingMinor, 0),
      oldestAgeDays: open.reduce((max, f) => Math.max(max, f.position.ageDays), 0),
      overdue: open.some((f) => f.position.overdue),
    };
  });
}
