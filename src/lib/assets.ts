/**
 * Fixed assets, depreciation, and the tax computation that sits beside them.
 *
 * Accounting and tax are kept apart on purpose. Depreciation is what the
 * books say an asset lost; capital allowances are what the Revenue lets you
 * deduct, on their own classes at their own rates. The two never meet except
 * in the computation, where the first is added back and the second taken off.
 *
 * Nothing about Ghana's tax classes, rates or incentives is written into this
 * file. They are settings the person enters, because they change with each
 * budget and a number baked into code is a number nobody can correct.
 *
 * Pure: no I/O, no Prisma. Money is integer minor units throughout.
 */

import type { TradingJournalLine } from './trading';

// --- accounts -----------------------------------------------------------------------------

export const assetAccounts = {
  cost: '1200',
  accumulatedDepreciation: '1205',
  /** Found by category, because the two charts number it differently. */
  depreciationCategory: 'depreciation',
  disposal: '7030',
  incomeTaxPayable: '2055',
  incomeTaxCharge: '7040',
} as const;

// --- depreciation ---------------------------------------------------------------------------

export type DepreciationMethod = 'straight-line' | 'reducing-balance';
export const depreciationMethods: DepreciationMethod[] = ['straight-line', 'reducing-balance'];
export const depreciationMethodLabels: Record<DepreciationMethod, string> = {
  'straight-line': 'Straight line — the same every month',
  'reducing-balance': 'Reducing balance — more early on, less later',
};

export type AssetLike = {
  costMinor: number;
  residualMinor: number;
  usefulLifeMonths: number;
  method: DepreciationMethod;
  /** The month it became available for use, YYYY-MM. Depreciation starts here. */
  inServiceMonth: string;
};

/** YYYY-MM of a YYYY-MM-DD date. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** Whole months from one YYYY-MM to another; negative when the second is earlier. */
export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

export function addMonths(month: string, count: number): string {
  const [year, index] = month.split('-').map(Number);
  const target = new Date(Date.UTC(year, index - 1 + count, 1));
  return target.toISOString().slice(0, 7);
}

/** The last month an asset depreciates in. */
export function finalMonth(asset: AssetLike): string {
  return addMonths(asset.inServiceMonth, Math.max(asset.usefulLifeMonths - 1, 0));
}

/**
 * The monthly rate that takes a reducing-balance asset from cost to exactly
 * its residual over its life. Reducing balance never reaches zero, so an
 * asset written down to nothing cannot use it: that is a refusal at the form,
 * not a fudge here.
 */
export function reducingMonthlyRate(asset: Pick<AssetLike, 'costMinor' | 'residualMinor' | 'usefulLifeMonths'>): number | null {
  if (asset.costMinor <= 0 || asset.residualMinor <= 0 || asset.usefulLifeMonths <= 0) return null;
  if (asset.residualMinor >= asset.costMinor) return null;
  return 1 - Math.pow(asset.residualMinor / asset.costMinor, 1 / asset.usefulLifeMonths);
}

/**
 * What an asset depreciates in one month, given what it has accumulated so
 * far. Depreciation runs from the month it entered service, stops at the end
 * of its life, and never takes the book value below the residual — the last
 * month carries whatever rounding is left, so the asset lands on its residual
 * exactly rather than a pesewa either side.
 */
export function depreciationFor(asset: AssetLike, period: string, accumulatedMinor: number): number {
  const elapsed = monthsBetween(asset.inServiceMonth, period);
  if (elapsed < 0 || asset.usefulLifeMonths <= 0) return 0;
  if (elapsed >= asset.usefulLifeMonths) return 0;

  const depreciable = Math.max(asset.costMinor - asset.residualMinor, 0);
  const remaining = depreciable - accumulatedMinor;
  if (remaining <= 0) return 0;

  // The last month of life takes everything left, so rounding never strands a
  // few pesewas on an asset that is finished.
  if (elapsed === asset.usefulLifeMonths - 1) return remaining;

  if (asset.method === 'straight-line') {
    return Math.min(Math.round(depreciable / asset.usefulLifeMonths), remaining);
  }
  const rate = reducingMonthlyRate(asset);
  if (rate === null) return 0;
  const openingBook = asset.costMinor - accumulatedMinor;
  return Math.min(Math.round((openingBook - asset.residualMinor) * rate), remaining);
}

export type ScheduleRow = { period: string; openingMinor: number; chargeMinor: number; accumulatedMinor: number; closingMinor: number };

/** The whole life of an asset, month by month. Used to show the person what they are signing up to. */
export function depreciationSchedule(asset: AssetLike): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let accumulated = 0;
  for (let index = 0; index < asset.usefulLifeMonths && index < 1200; index++) {
    const period = addMonths(asset.inServiceMonth, index);
    const opening = asset.costMinor - accumulated;
    const charge = depreciationFor(asset, period, accumulated);
    accumulated += charge;
    rows.push({ period, openingMinor: opening, chargeMinor: charge, accumulatedMinor: accumulated, closingMinor: asset.costMinor - accumulated });
  }
  return rows;
}

/** Cost less what has been written off. */
export function bookValue(costMinor: number, accumulatedMinor: number): number {
  return costMinor - accumulatedMinor;
}

const nameOf = (names: Record<string, string>, code: string, fallback: string) => names[code] ?? fallback;
const line = (names: Record<string, string>, accountCode: string, fallback: string, amount: number, type: 'debit' | 'credit'): TradingJournalLine => ({
  accountCode,
  accountName: nameOf(names, accountCode, fallback),
  amount,
  type,
});

/** A month's depreciation: the cost of using the assets, against what they have lost. */
export function depreciationJournal(totalMinor: number, expenseCode: string, names: Record<string, string>): TradingJournalLine[] {
  if (totalMinor <= 0) return [];
  return [
    line(names, expenseCode, 'Depreciation', totalMinor, 'debit'),
    line(names, assetAccounts.accumulatedDepreciation, 'Accumulated Depreciation', totalMinor, 'credit'),
  ];
}

// --- disposal --------------------------------------------------------------------------------

export type Disposal = {
  costMinor: number;
  accumulatedMinor: number;
  proceedsMinor: number;
};

export type DisposalResult = {
  bookValueMinor: number;
  /** Positive is a gain, negative a loss. */
  gainLossMinor: number;
};

/** What an asset was still worth, and what selling it made or cost. */
export function disposalResult(disposal: Disposal): DisposalResult {
  const bookValueMinor = disposal.costMinor - disposal.accumulatedMinor;
  return { bookValueMinor, gainLossMinor: disposal.proceedsMinor - bookValueMinor };
}

/**
 * Selling an asset: the cost and its accumulated depreciation both leave the
 * books, the proceeds arrive, and whatever is left over is the gain or loss.
 * A credit to 7030 is a gain, a debit a loss — the same convention the
 * exchange accounts use.
 */
export function disposalJournal(disposal: Disposal, bankCode: string, names: Record<string, string>): TradingJournalLine[] {
  const { bookValueMinor, gainLossMinor } = disposalResult(disposal);
  const lines: TradingJournalLine[] = [];
  if (disposal.proceedsMinor > 0) lines.push(line(names, bankCode, 'Bank', disposal.proceedsMinor, 'debit'));
  if (disposal.accumulatedMinor > 0) lines.push(line(names, assetAccounts.accumulatedDepreciation, 'Accumulated Depreciation', disposal.accumulatedMinor, 'debit'));
  if (disposal.costMinor > 0) lines.push(line(names, assetAccounts.cost, 'Fixed Assets at Cost', disposal.costMinor, 'credit'));
  if (gainLossMinor > 0) lines.push(line(names, assetAccounts.disposal, 'Gain or Loss on Asset Disposal', gainLossMinor, 'credit'));
  if (gainLossMinor < 0) lines.push(line(names, assetAccounts.disposal, 'Gain or Loss on Asset Disposal', -gainLossMinor, 'debit'));
  void bookValueMinor;
  return lines;
}

// --- capital allowances ----------------------------------------------------------------------
//
// A class, its rate and its method are settings. Ghana's classes and rates
// change with the budget; they are entered once and edited when they move.

export type AllowanceMethod = 'straight-line' | 'reducing-balance';
export const allowanceMethods: AllowanceMethod[] = ['straight-line', 'reducing-balance'];
export const allowanceMethodLabels: Record<AllowanceMethod, string> = {
  'straight-line': 'Straight line on cost',
  'reducing-balance': 'Reducing balance on the pool',
};

export type AllowanceClass = {
  id: string;
  code: string;
  name: string;
  /** Percent a year, as a decimal string so 37.5 is exact. */
  ratePct: string;
  method: AllowanceMethod;
};

export type PoolMovement = {
  classId: string;
  /** Written down value brought forward. */
  openingMinor: number;
  /** Assets bought in the year, at cost. */
  additionsMinor: number;
  /** What disposals brought in, which comes off the pool before the allowance. */
  disposalProceedsMinor: number;
  /** Straight-line classes need the cost still being written off. */
  straightLineCostMinor: number;
};

export type PoolRow = {
  classId: string;
  code: string;
  name: string;
  ratePct: string;
  method: AllowanceMethod;
  openingMinor: number;
  additionsMinor: number;
  disposalProceedsMinor: number;
  /** What the allowance is worked out on. */
  baseMinor: number;
  allowanceMinor: number;
  closingMinor: number;
};

/**
 * One class's capital allowance for a year. A reducing-balance pool is
 * written down by its rate on the pool after additions and disposals; a
 * straight-line class takes its rate on cost, capped at what is left in the
 * pool so it cannot claim more than the asset was worth.
 */
export function poolAllowance(movement: PoolMovement, klass: AllowanceClass): PoolRow {
  const rate = Number(klass.ratePct) / 100;
  const poolAfterMovements = movement.openingMinor + movement.additionsMinor - movement.disposalProceedsMinor;
  const base = klass.method === 'reducing-balance' ? Math.max(poolAfterMovements, 0) : Math.max(movement.straightLineCostMinor, 0);
  const uncapped = Number.isFinite(rate) && rate > 0 ? Math.round(base * rate) : 0;
  const allowanceMinor = Math.min(uncapped, Math.max(poolAfterMovements, 0));
  return {
    classId: klass.id,
    code: klass.code,
    name: klass.name,
    ratePct: klass.ratePct,
    method: klass.method,
    openingMinor: movement.openingMinor,
    additionsMinor: movement.additionsMinor,
    disposalProceedsMinor: movement.disposalProceedsMinor,
    baseMinor: base,
    allowanceMinor,
    closingMinor: poolAfterMovements - allowanceMinor,
  };
}

export type AllowanceSchedule = { rows: PoolRow[]; totalAllowanceMinor: number; totalClosingMinor: number };

/** Every class's pool for one year. */
export function allowanceSchedule(movements: PoolMovement[], classes: AllowanceClass[]): AllowanceSchedule {
  const byId = new Map(classes.map((klass) => [klass.id, klass]));
  const rows = movements
    .map((movement) => {
      const klass = byId.get(movement.classId);
      return klass ? poolAllowance(movement, klass) : null;
    })
    .filter((row): row is PoolRow => row !== null);
  return {
    rows,
    totalAllowanceMinor: rows.reduce((total, row) => total + row.allowanceMinor, 0),
    totalClosingMinor: rows.reduce((total, row) => total + row.closingMinor, 0),
  };
}

// --- the tax computation ----------------------------------------------------------------------

export type TaxStatus = 'taxable' | 'exempt' | 'special-rate';
export const taxStatuses: TaxStatus[] = ['taxable', 'exempt', 'special-rate'];
export const taxStatusLabels: Record<TaxStatus, string> = {
  taxable: 'Taxable at the standard rate',
  exempt: 'Exempt — no computation',
  'special-rate': 'Taxable at its own rate',
};

/** Whether an entity has a computation at all. */
export function isTaxed(status: TaxStatus): boolean {
  return status !== 'exempt';
}

export type AdjustmentKind = 'add-back' | 'deduction' | 'incentive';
export const adjustmentKinds: AdjustmentKind[] = ['add-back', 'deduction', 'incentive'];
export const adjustmentKindLabels: Record<AdjustmentKind, string> = {
  'add-back': 'Added back — not allowed for tax',
  deduction: 'Deducted — allowed for tax but not in the accounts',
  incentive: 'Incentive or exemption — taken off the chargeable income',
};

export type Adjustment = { id: string; kind: AdjustmentKind; description: string; amountMinor: number };

export type Computation = {
  accountingProfitMinor: number;
  /** Depreciation in the accounts, added back in full. */
  depreciationMinor: number;
  addBacks: Adjustment[];
  deductions: Adjustment[];
  incentives: Adjustment[];
  capitalAllowancesMinor: number;
  /** Percent, as a decimal string. */
  ratePct: string;
  /** Losses brought forward, taken off before the rate is applied. */
  lossBroughtForwardMinor: number;
};

export type ComputationResult = {
  accountingProfitMinor: number;
  depreciationMinor: number;
  addBacksMinor: number;
  deductionsMinor: number;
  /** Profit before capital allowances. */
  adjustedProfitMinor: number;
  capitalAllowancesMinor: number;
  incentivesMinor: number;
  lossUsedMinor: number;
  /** What the rate is applied to; never below nil. */
  chargeableIncomeMinor: number;
  taxChargeMinor: number;
  /** Loss to carry on to next year. */
  lossCarriedForwardMinor: number;
};

/**
 * The computation, in the order the Revenue reads it: start from the
 * accounting profit, add back the depreciation and anything else not allowed,
 * take off what is allowed but not in the accounts, then capital allowances,
 * then any incentive. A loss is not taxed and carries forward.
 */
export function taxComputation(input: Computation): ComputationResult {
  const sum = (rows: Adjustment[]) => rows.reduce((total, row) => total + row.amountMinor, 0);
  const addBacksMinor = sum(input.addBacks);
  const deductionsMinor = sum(input.deductions);
  const incentivesMinor = sum(input.incentives);
  const adjustedProfitMinor = input.accountingProfitMinor + input.depreciationMinor + addBacksMinor - deductionsMinor;

  const afterAllowances = adjustedProfitMinor - input.capitalAllowancesMinor - incentivesMinor;
  const lossUsedMinor = afterAllowances > 0 ? Math.min(input.lossBroughtForwardMinor, afterAllowances) : 0;
  const chargeableIncomeMinor = Math.max(afterAllowances - lossUsedMinor, 0);
  const rate = Number(input.ratePct) / 100;
  const taxChargeMinor = Number.isFinite(rate) && rate > 0 ? Math.round(chargeableIncomeMinor * rate) : 0;

  return {
    accountingProfitMinor: input.accountingProfitMinor,
    depreciationMinor: input.depreciationMinor,
    addBacksMinor,
    deductionsMinor,
    adjustedProfitMinor,
    capitalAllowancesMinor: input.capitalAllowancesMinor,
    incentivesMinor,
    lossUsedMinor,
    chargeableIncomeMinor,
    taxChargeMinor,
    lossCarriedForwardMinor: afterAllowances < 0 ? input.lossBroughtForwardMinor - afterAllowances : input.lossBroughtForwardMinor - lossUsedMinor,
  };
}

/** The tax charge for the year: an expense, and a liability until it is paid. */
export function taxChargeJournal(amountMinor: number, names: Record<string, string>): TradingJournalLine[] {
  if (amountMinor <= 0) return [];
  return [
    line(names, assetAccounts.incomeTaxCharge, 'Corporate Income Tax', amountMinor, 'debit'),
    line(names, assetAccounts.incomeTaxPayable, 'Corporate Income Tax Payable', amountMinor, 'credit'),
  ];
}

// --- provisional tax -------------------------------------------------------------------------------

export type Instalment = {
  quarter: 1 | 2 | 3 | 4;
  dueDate: string;
  /** A quarter of the estimate, the last one carrying the rounding. */
  estimatedMinor: number;
  paidMinor: number;
  paidDate: string | null;
  /** Unpaid and the due date has gone. */
  overdue: boolean;
  outstandingMinor: number;
};

const lastDayOf = (month: string) => {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
};

/**
 * The four provisional instalments for a year. Each falls due at the end of
 * the third, sixth, ninth and twelfth month of the entity's own tax year, so
 * a year that does not start in January still gets its own dates.
 */
export function instalments(
  yearStartMonth: string,
  estimatedLiabilityMinor: number,
  payments: { quarter: number; paidMinor: number; paidDate: string | null }[],
  asOf: string,
): Instalment[] {
  const each = Math.round(estimatedLiabilityMinor / 4);
  return ([1, 2, 3, 4] as const).map((quarter) => {
    const dueDate = lastDayOf(addMonths(yearStartMonth, quarter * 3 - 1));
    const estimatedMinor = quarter === 4 ? estimatedLiabilityMinor - each * 3 : each;
    const paid = payments.filter((payment) => payment.quarter === quarter);
    const paidMinor = paid.reduce((total, payment) => total + payment.paidMinor, 0);
    const outstandingMinor = Math.max(estimatedMinor - paidMinor, 0);
    return {
      quarter,
      dueDate,
      estimatedMinor,
      paidMinor,
      paidDate: paid.map((payment) => payment.paidDate).filter(Boolean).sort().pop() ?? null,
      overdue: outstandingMinor > 0 && dueDate < asOf,
      outstandingMinor,
    };
  });
}

export type ProvisionalPosition = {
  instalments: Instalment[];
  estimatedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  /** The next one to fall due, or null when they are all paid or past. */
  next: Instalment | null;
};

export function provisionalPosition(rows: Instalment[], asOf: string): ProvisionalPosition {
  return {
    instalments: rows,
    estimatedMinor: rows.reduce((total, row) => total + row.estimatedMinor, 0),
    paidMinor: rows.reduce((total, row) => total + row.paidMinor, 0),
    outstandingMinor: rows.reduce((total, row) => total + row.outstandingMinor, 0),
    overdueMinor: rows.filter((row) => row.overdue).reduce((total, row) => total + row.outstandingMinor, 0),
    next: rows.find((row) => row.outstandingMinor > 0 && row.dueDate >= asOf) ?? null,
  };
}

/** A provisional payment: off the liability, out of the bank. */
export function provisionalPaymentJournal(amountMinor: number, bankCode: string, names: Record<string, string>): TradingJournalLine[] {
  if (amountMinor <= 0) return [];
  return [
    line(names, assetAccounts.incomeTaxPayable, 'Corporate Income Tax Payable', amountMinor, 'debit'),
    line(names, bankCode, 'Bank', amountMinor, 'credit'),
  ];
}
