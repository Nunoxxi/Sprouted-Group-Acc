/**
 * Pre-finance: borrowing money, advancing it to aggregators, receiving cashew
 * against those advances, selling it, and getting the money back in time to do
 * it again before the loan falls due.
 *
 * The whole business turns on one number — how many times the same borrowed
 * cedi goes round before it has to be repaid — so most of this file exists to
 * work that out honestly, including the time the money sat still.
 *
 * Conventions, as everywhere else in this app: money is whole pesewas, weight
 * is whole grams, and a rate is an exact decimal string rather than a float.
 *
 * Pure: no I/O, no Prisma, no dates from the clock — every function that needs
 * "today" is given it.
 */

// --- money and weight helpers ------------------------------------------------------------

/** Pesewas, never a fraction of one. */
export const roundPesewas = (value: number): number => Math.round(value);

const GRAMS_PER_KG = 1000;

/** Value of a weight at a price per kilogram, in pesewas. */
export function valueOf(grams: number, pricePerKgMinor: number): number {
  return roundPesewas((grams * pricePerKgMinor) / GRAMS_PER_KG);
}

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function addDays(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// --- interest ------------------------------------------------------------------------------

/**
 * How a year is counted. Ghanaian bank facilities are usually actual/365;
 * some dollar facilities are actual/360, which quietly costs more.
 */
export type DayCountBasis = 'actual/365' | 'actual/360' | '30/360';

export const dayCountBases: DayCountBasis[] = ['actual/365', 'actual/360', '30/360'];

export const dayCountLabels: Record<DayCountBasis, string> = {
  'actual/365': 'Actual days over a 365-day year',
  'actual/360': 'Actual days over a 360-day year',
  '30/360': 'Thirty-day months over a 360-day year',
};

const yearDays = (basis: DayCountBasis): number => (basis === 'actual/365' ? 365 : 360);

/** Days between two dates on the given basis. 30/360 counts every month as 30. */
export function interestDays(from: string, to: string, basis: DayCountBasis): number {
  if (basis !== '30/360') return daysBetween(from, to);
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  const start = Math.min(d1, 30);
  const end = d1 >= 30 && d2 > 30 ? 30 : d2;
  return (y2 - y1) * 360 + (m2 - m1) * 30 + (end - start);
}

/**
 * Interest on a balance for a period. `ratePct` is the annual rate as a
 * number, so 24.5 means 24.5% a year.
 */
export function interestOn(balanceMinor: number, ratePct: number, days: number, basis: DayCountBasis): number {
  if (balanceMinor <= 0 || days <= 0 || ratePct <= 0) return 0;
  return roundPesewas((balanceMinor * (ratePct / 100) * days) / yearDays(basis));
}

/** What one day costs on a balance — used for idle cash and for cycle finance cost. */
export function dailyInterest(balanceMinor: number, ratePct: number, basis: DayCountBasis): number {
  return (balanceMinor * (ratePct / 100)) / yearDays(basis);
}

// --- the facility and its tranches -----------------------------------------------------------

export type Tranche = {
  id: string;
  /** When the money actually landed. */
  drawnOn: string;
  amountMinor: number;
  /** Repaid in full on this date, if it has been. */
  repaidOn?: string | null;
};

export type Facility = {
  limitMinor: number;
  ratePct: number;
  basis: DayCountBasis;
  /** When the whole facility falls due. */
  repaymentDate: string;
};

/** Drawn and still outstanding on a given day. */
export function drawnOn(tranches: readonly Tranche[], asOf: string): number {
  return tranches
    .filter((tranche) => tranche.drawnOn <= asOf && (!tranche.repaidOn || tranche.repaidOn > asOf))
    .reduce((sum, tranche) => sum + tranche.amountMinor, 0);
}

/** Everything ever drawn, repaid or not. */
export function totalDrawn(tranches: readonly Tranche[]): number {
  return tranches.reduce((sum, tranche) => sum + tranche.amountMinor, 0);
}

export function headroom(facility: Facility, tranches: readonly Tranche[], asOf: string): number {
  return Math.max(facility.limitMinor - drawnOn(tranches, asOf), 0);
}

/**
 * Interest accrued on each tranche between two dates, so it can be posted a
 * period at a time rather than guessed at the end.
 */
export function accrueInterest(
  tranches: readonly Tranche[],
  facility: Pick<Facility, 'ratePct' | 'basis'>,
  from: string,
  to: string,
): { trancheId: string; days: number; amountMinor: number }[] {
  return tranches
    .map((tranche) => {
      const start = tranche.drawnOn > from ? tranche.drawnOn : from;
      const end = tranche.repaidOn && tranche.repaidOn < to ? tranche.repaidOn : to;
      if (end <= start) return { trancheId: tranche.id, days: 0, amountMinor: 0 };
      const days = interestDays(start, end, facility.basis);
      return { trancheId: tranche.id, days, amountMinor: interestOn(tranche.amountMinor, facility.ratePct, days, facility.basis) };
    })
    .filter((row) => row.amountMinor > 0);
}

// --- quality: what was agreed, and what turned up ------------------------------------------------

/**
 * The quality the agreed price assumes. Outturn is KOR — pounds of kernel from
 * an 80kg bag — and is what the price is really paid for. Moisture is water:
 * above the basis you would be paying cashew prices for it.
 */
export type QualityBasis = {
  /** Kernel outturn ratio the price assumes. */
  outturn: number;
  /** Moisture percent the price assumes. */
  moisturePct: number;
};

export type DeliveredQuality = {
  grams: number;
  outturn: number;
  moisturePct: number;
};

export type QualitySettlement = {
  /** Weight after water above the basis is taken off. */
  adjustedGrams: number;
  /** Price per kg after the outturn adjustment. */
  adjustedPricePerKgMinor: number;
  /** What the load would have been worth had it met the basis exactly. */
  valueAtBasisMinor: number;
  /** What it is actually worth. */
  settledValueMinor: number;
  /** settled − at basis. Negative means the load came in under what was agreed. */
  varianceMinor: number;
  /** The part of the variance caused by water. Never positive. */
  moistureVarianceMinor: number;
  /** The part caused by outturn. Positive when the load beat the basis. */
  outturnVarianceMinor: number;
  outturnDifference: number;
  moistureDifference: number;
};

/**
 * Settle a delivery against the quality the price assumed.
 *
 * Two adjustments, each doing one job:
 *
 *  - **Moisture takes weight off.** Wet nuts weigh more without being worth
 *    more, so weight is scaled down to what it would have been at the basis
 *    moisture. Only ever downward: a load drier than agreed does not earn a
 *    bonus, which is the trade's convention and the prudent way round.
 *  - **Outturn moves the price.** Outturn is what a processor actually buys,
 *    so the price moves in proportion, up as well as down.
 *
 * The two effects are reported apart, and they add back exactly to the total
 * variance, so a conversation with an aggregator can be about the right one.
 */
export function settleQuality(
  agreed: QualityBasis,
  agreedPricePerKgMinor: number,
  delivered: DeliveredQuality,
): QualitySettlement {
  const moistureDifference = Math.round((delivered.moisturePct - agreed.moisturePct) * 100) / 100;
  const outturnDifference = Math.round((delivered.outturn - agreed.outturn) * 100) / 100;

  // Water above the basis comes off the weight; below it, the weight stands.
  const wetter = delivered.moisturePct > agreed.moisturePct;
  const adjustedGrams = wetter
    ? Math.round((delivered.grams * (100 - delivered.moisturePct)) / (100 - agreed.moisturePct))
    : delivered.grams;

  // Outturn moves the price both ways.
  const adjustedPricePerKgMinor = agreed.outturn > 0
    ? roundPesewas((agreedPricePerKgMinor * delivered.outturn) / agreed.outturn)
    : agreedPricePerKgMinor;

  const valueAtBasisMinor = valueOf(delivered.grams, agreedPricePerKgMinor);
  const settledValueMinor = valueOf(adjustedGrams, adjustedPricePerKgMinor);

  const moistureVarianceMinor = valueOf(adjustedGrams, agreedPricePerKgMinor) - valueAtBasisMinor;
  const outturnVarianceMinor = settledValueMinor - valueOf(adjustedGrams, agreedPricePerKgMinor);

  return {
    adjustedGrams,
    adjustedPricePerKgMinor,
    valueAtBasisMinor,
    settledValueMinor,
    varianceMinor: settledValueMinor - valueAtBasisMinor,
    moistureVarianceMinor,
    outturnVarianceMinor,
    outturnDifference,
    moistureDifference,
  };
}

// --- settling the advance itself ------------------------------------------------------------------

export type SettlementOutcome = 'collect-shortfall' | 'pay-top-up' | 'carry-forward' | 'square';

export type AdvanceSettlement = {
  advanceMinor: number;
  settledValueMinor: number;
  /** Positive: the aggregator owes us. Negative: we owe them. */
  differenceMinor: number;
  outcome: SettlementOutcome;
  /** Plain words for the screen. */
  explanation: string;
};

/**
 * What the delivery does to the advance. The advance was a receivable from the
 * aggregator; the goods pay it down. Whatever is left over goes one of three
 * ways, and which one is a decision a person makes, not one this works out.
 */
export function settleAdvance(advanceMinor: number, settledValueMinor: number, choice: SettlementOutcome = 'carry-forward'): AdvanceSettlement {
  const differenceMinor = advanceMinor - settledValueMinor;
  if (differenceMinor === 0) {
    return { advanceMinor, settledValueMinor, differenceMinor, outcome: 'square', explanation: 'The delivery is worth exactly what was advanced. Nothing to settle.' };
  }
  const cedis = (minor: number) => (Math.abs(minor) / 100).toFixed(2);
  if (differenceMinor > 0) {
    const outcome = choice === 'pay-top-up' ? 'carry-forward' : choice;
    return {
      advanceMinor,
      settledValueMinor,
      differenceMinor,
      outcome: outcome === 'square' ? 'carry-forward' : outcome,
      explanation:
        outcome === 'collect-shortfall'
          ? `The delivery is worth ${cedis(differenceMinor)} less than was advanced. Collecting it back.`
          : `The delivery is worth ${cedis(differenceMinor)} less than was advanced. Carrying it forward against their next advance.`,
    };
  }
  return {
    advanceMinor,
    settledValueMinor,
    differenceMinor,
    outcome: 'pay-top-up',
    explanation: `The delivery is worth ${cedis(differenceMinor)} more than was advanced. Paying them the difference.`,
  };
}

// --- ageing and provisioning ------------------------------------------------------------------------

export type OpenAdvance = {
  id: string;
  aggregatorId: string;
  aggregatorName: string;
  amountMinor: number;
  advancedOn: string;
  expectedOn: string;
};

export type AgeingThresholds = {
  /** Days past expected delivery at which an advance is flagged. */
  flagAfterDays: number;
  /** Days past expected delivery at which a provision is made. */
  provisionAfterDays: number;
  /** Percent of the advance to provide for, 0–100. */
  provisionPct: number;
};

export type AgedAdvance = OpenAdvance & {
  daysOutstanding: number;
  /** Negative until the expected date passes. */
  daysOverdue: number;
  flagged: boolean;
  provisionMinor: number;
};

/**
 * Every open advance by age. Nothing is held as security against these, so an
 * old one is a real risk rather than a late invoice.
 */
export function ageAdvances(advances: readonly OpenAdvance[], thresholds: AgeingThresholds, asOf: string): AgedAdvance[] {
  return advances
    .map((advance) => {
      const daysOverdue = daysBetween(advance.expectedOn, asOf);
      const provide = daysOverdue >= thresholds.provisionAfterDays && thresholds.provisionPct > 0;
      return {
        ...advance,
        daysOutstanding: daysBetween(advance.advancedOn, asOf),
        daysOverdue,
        flagged: daysOverdue >= thresholds.flagAfterDays,
        provisionMinor: provide ? roundPesewas((advance.amountMinor * thresholds.provisionPct) / 100) : 0,
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
}

export function provisionTotal(aged: readonly AgedAdvance[]): number {
  return aged.reduce((sum, advance) => sum + advance.provisionMinor, 0);
}

// --- what an aggregator's record says ------------------------------------------------------------------

export type AggregatorHistory = {
  advancedMinor: number;
  deliveredValueMinor: number;
  deliveries: number;
  /** One per delivery, in days from advance to delivery. */
  daysToDeliver: readonly number[];
  /** One per delivery: settled less value at basis, in pesewas. */
  qualityVariances: readonly number[];
  /** Shortfalls written off rather than collected or carried. */
  unrecoveredMinor: number;
  /** Advances still open. */
  currentExposureMinor: number;
  /** What we have agreed they may owe us at once. Nil means no limit set. */
  exposureLimitMinor: number;
};

export type AggregatorRecord = {
  advancedMinor: number;
  deliveredValueMinor: number;
  deliveries: number;
  averageDaysToDeliver: number | null;
  /** Average money effect of quality per delivery. Negative is the bad direction. */
  averageQualityVarianceMinor: number | null;
  unrecoveredMinor: number;
  currentExposureMinor: number;
  exposureLimitMinor: number;
  /** Headroom under the limit; null when no limit is set. */
  availableMinor: number | null;
};

export function aggregatorRecord(history: AggregatorHistory): AggregatorRecord {
  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  return {
    advancedMinor: history.advancedMinor,
    deliveredValueMinor: history.deliveredValueMinor,
    deliveries: history.deliveries,
    averageDaysToDeliver: mean(history.daysToDeliver),
    averageQualityVarianceMinor: mean(history.qualityVariances),
    unrecoveredMinor: history.unrecoveredMinor,
    currentExposureMinor: history.currentExposureMinor,
    exposureLimitMinor: history.exposureLimitMinor,
    availableMinor: history.exposureLimitMinor > 0 ? history.exposureLimitMinor - history.currentExposureMinor : null,
  };
}

export type ExposureCheck = { ok: true } | { ok: false; warning: string };

/** Whether a new advance would put an aggregator past the limit set for them. */
export function checkExposure(record: AggregatorRecord, newAdvanceMinor: number, aggregatorName: string): ExposureCheck {
  if (record.exposureLimitMinor <= 0) return { ok: true };
  const after = record.currentExposureMinor + newAdvanceMinor;
  if (after <= record.exposureLimitMinor) return { ok: true };
  const cedis = (minor: number) => (minor / 100).toFixed(2);
  return {
    ok: false,
    warning: `${aggregatorName} already holds ${cedis(record.currentExposureMinor)} of advances. Another ${cedis(newAdvanceMinor)} takes them to ${cedis(after)}, past the ${cedis(record.exposureLimitMinor)} limit set for them. Nothing is held as security against these advances.`,
  };
}

// --- cycles: money out, goods in, goods sold, money back -------------------------------------------------

export type Cycle = {
  id: string;
  reference: string;
  /** When the money left the bank for this cycle. */
  deployedOn: string;
  deployedMinor: number;
  /** The dates that mark each stage. Null until the stage happens. */
  drawnOn?: string | null;
  firstDeliveryOn?: string | null;
  soldOn?: string | null;
  cashBackOn?: string | null;
  returnedMinor?: number;
  proceedsMinor?: number;
  costOfGoodsMinor?: number;
  landedCostMinor?: number;
  /** Kilograms the cycle handled, in grams. */
  grams?: number;
};

export type CycleStages = {
  drawdownToAdvance: number | null;
  advanceToDelivery: number | null;
  deliveryToSale: number | null;
  saleToCash: number | null;
  /** Drawdown (or advance, if no drawdown date) through to cash back. */
  totalDays: number | null;
};

/**
 * Where the days went. A cycle that takes ninety days is not one problem, it
 * is four, and this says which of the four to go and look at.
 */
export function cycleStages(cycle: Cycle): CycleStages {
  const between = (from: string | null | undefined, to: string | null | undefined): number | null =>
    from && to ? daysBetween(from, to) : null;
  const start = cycle.drawnOn ?? cycle.deployedOn;
  return {
    drawdownToAdvance: between(cycle.drawnOn, cycle.deployedOn),
    advanceToDelivery: between(cycle.deployedOn, cycle.firstDeliveryOn),
    deliveryToSale: between(cycle.firstDeliveryOn, cycle.soldOn),
    saleToCash: between(cycle.soldOn, cycle.cashBackOn),
    totalDays: between(start, cycle.cashBackOn),
  };
}

export const isComplete = (cycle: Cycle): boolean => !!cycle.cashBackOn;

/** Average days over the cycles that actually finished. */
export function averageCycleDays(cycles: readonly Cycle[]): number | null {
  const done = cycles.map(cycleStages).map((stages) => stages.totalDays).filter((days): days is number => days !== null && days > 0);
  return done.length === 0 ? null : Math.round(done.reduce((sum, days) => sum + days, 0) / done.length);
}

export type CycleMargin = {
  proceedsMinor: number;
  costOfGoodsMinor: number;
  landedCostMinor: number;
  grossMarginMinor: number;
  financeCostMinor: number;
  netMarginMinor: number;
  grams: number;
  /** Nil when the cycle moved no weight. */
  grossMarginPerKgMinor: number | null;
  netMarginPerKgMinor: number | null;
};

/**
 * What a cycle made, before and after the cost of the money it tied up.
 *
 * The finance cost is the interest for the days this cycle actually held the
 * money — not a share of the total. A cycle that turned round in three weeks
 * should not carry the cost of one that took three months.
 */
export function cycleMargin(cycle: Cycle, facility: Pick<Facility, 'ratePct' | 'basis'>): CycleMargin {
  const proceedsMinor = cycle.proceedsMinor ?? 0;
  const costOfGoodsMinor = cycle.costOfGoodsMinor ?? 0;
  const landedCostMinor = cycle.landedCostMinor ?? 0;
  const grossMarginMinor = proceedsMinor - costOfGoodsMinor - landedCostMinor;

  const stages = cycleStages(cycle);
  const heldDays = stages.totalDays ?? 0;
  const financeCostMinor = interestOn(cycle.deployedMinor, facility.ratePct, heldDays, facility.basis);
  const netMarginMinor = grossMarginMinor - financeCostMinor;

  const grams = cycle.grams ?? 0;
  const perKg = (minor: number): number | null => (grams > 0 ? roundPesewas((minor * GRAMS_PER_KG) / grams) : null);

  return {
    proceedsMinor,
    costOfGoodsMinor,
    landedCostMinor,
    grossMarginMinor,
    financeCostMinor,
    netMarginMinor,
    grams,
    grossMarginPerKgMinor: perKg(grossMarginMinor),
    netMarginPerKgMinor: perKg(netMarginMinor),
  };
}

// --- how many times the money went round -----------------------------------------------------------------

export type RecycleMeasures = {
  /** Everything deployed over the life of the facility, against the limit. */
  cashBasedTimes: number | null;
  totalDeployedMinor: number;
  /** A year's worth of cycles at the average length. */
  cycleBasedTimes: number | null;
  averageCycleDays: number | null;
  completedCycles: number;
};

/**
 * The headline number, both ways round, because they answer different
 * questions. The cash measure says what actually happened. The cycle measure
 * says what the current pace would give over a year — useful while a facility
 * is young and the cash measure is still small by construction.
 */
export function recycleMeasures(facility: Pick<Facility, 'limitMinor'>, cycles: readonly Cycle[]): RecycleMeasures {
  const totalDeployedMinor = cycles.reduce((sum, cycle) => sum + cycle.deployedMinor, 0);
  const average = averageCycleDays(cycles);
  return {
    totalDeployedMinor,
    cashBasedTimes: facility.limitMinor > 0 ? Math.round((totalDeployedMinor / facility.limitMinor) * 100) / 100 : null,
    cycleBasedTimes: average && average > 0 ? Math.round((365 / average) * 100) / 100 : null,
    averageCycleDays: average,
    completedCycles: cycles.filter(isComplete).length,
  };
}

// --- the cost of money standing still ---------------------------------------------------------------------

export type DeploymentDay = { date: string; drawnMinor: number; deployedMinor: number };

export type IdleCost = {
  /** Days on which some drawn money was not deployed. */
  idleDays: number;
  /** Sum of the idle balance across those days — cedi-days, not a balance. */
  idleBalanceDaysMinor: number;
  /** Largest idle balance seen. */
  peakIdleMinor: number;
  /** What the idleness cost in interest. */
  costMinor: number;
};

/**
 * A term loan charges interest whether the money is working or not, so money
 * sitting in the account is not free — it is the most expensive money there
 * is, earning nothing and costing the full rate.
 */
export function idleCost(days: readonly DeploymentDay[], facility: Pick<Facility, 'ratePct' | 'basis'>): IdleCost {
  let idleDays = 0;
  let idleBalanceDaysMinor = 0;
  let peakIdleMinor = 0;
  let costMinor = 0;

  for (const day of days) {
    const idle = Math.max(day.drawnMinor - day.deployedMinor, 0);
    if (idle <= 0) continue;
    idleDays += 1;
    idleBalanceDaysMinor += idle;
    if (idle > peakIdleMinor) peakIdleMinor = idle;
    costMinor += dailyInterest(idle, facility.ratePct, facility.basis);
  }

  return { idleDays, idleBalanceDaysMinor, peakIdleMinor, costMinor: roundPesewas(costMinor) };
}

// --- can another advance still get back in time? ------------------------------------------------------------

export type Runway = {
  /** The last day a new advance can go out and still return as cash. */
  lastSafeAdvanceDate: string | null;
  daysUntilLastSafe: number | null;
  daysToRepayment: number;
  /** True once today is at or past the last safe date. */
  closed: boolean;
  /** True while it is close enough to think about. */
  closingSoon: boolean;
  explanation: string;
};

/**
 * Working backwards from the repayment date: given how long a cycle currently
 * takes, when does the last one have to start?
 *
 * Deliberately blunt. Being a week late here means money still sitting in
 * cashew on the day the bank wants its cedis back.
 */
export function repaymentRunway(
  facility: Pick<Facility, 'repaymentDate'>,
  averageDays: number | null,
  asOf: string,
  warnWithinDays = 14,
): Runway {
  const daysToRepayment = daysBetween(asOf, facility.repaymentDate);
  if (averageDays === null || averageDays <= 0) {
    return {
      lastSafeAdvanceDate: null,
      daysUntilLastSafe: null,
      daysToRepayment,
      closed: false,
      closingSoon: false,
      explanation: 'No cycle has completed yet, so there is nothing to work a safe date back from. Finish one and this will fill in.',
    };
  }

  const lastSafeAdvanceDate = addDays(facility.repaymentDate, -averageDays);
  const daysUntilLastSafe = daysBetween(asOf, lastSafeAdvanceDate);
  const closed = daysUntilLastSafe <= 0;
  const closingSoon = !closed && daysUntilLastSafe <= warnWithinDays;

  return {
    lastSafeAdvanceDate,
    daysUntilLastSafe,
    daysToRepayment,
    closed,
    closingSoon,
    explanation: closed
      ? `A new advance today would not come back as cash before ${facility.repaymentDate}. At ${averageDays} days a cycle, the last safe day was ${lastSafeAdvanceDate}. Anything advanced now has to be funded another way.`
      : `At ${averageDays} days a cycle, the last day to advance and still be back in cash by ${facility.repaymentDate} is ${lastSafeAdvanceDate} — ${daysUntilLastSafe} day${daysUntilLastSafe === 1 ? '' : 's'} away.`,
  };
}

// --- the one screen that says where things stand ----------------------------------------------------------

export type PreFinancePosition = {
  limitMinor: number;
  drawnMinor: number;
  headroomMinor: number;
  deployedMinor: number;
  idleMinor: number;
  advancesOutstandingMinor: number;
  provisionMinor: number;
  stockHeldMinor: number;
  completedCycles: number;
  averageCycleDays: number | null;
  daysToRepayment: number;
  recycle: RecycleMeasures;
  runway: Runway;
};

export function position(input: {
  facility: Facility;
  tranches: readonly Tranche[];
  cycles: readonly Cycle[];
  openAdvances: readonly OpenAdvance[];
  thresholds: AgeingThresholds;
  stockHeldMinor: number;
  asOf: string;
}): PreFinancePosition {
  const { facility, tranches, cycles, openAdvances, thresholds, stockHeldMinor, asOf } = input;
  const drawn = drawnOn(tranches, asOf);
  const advancesOutstandingMinor = openAdvances.reduce((sum, advance) => sum + advance.amountMinor, 0);
  // Money is deployed while it is out with an aggregator or sitting as stock.
  const deployedMinor = advancesOutstandingMinor + stockHeldMinor;
  const recycle = recycleMeasures(facility, cycles);

  return {
    limitMinor: facility.limitMinor,
    drawnMinor: drawn,
    headroomMinor: headroom(facility, tranches, asOf),
    deployedMinor,
    idleMinor: Math.max(drawn - deployedMinor, 0),
    advancesOutstandingMinor,
    provisionMinor: provisionTotal(ageAdvances(openAdvances, thresholds, asOf)),
    stockHeldMinor,
    completedCycles: recycle.completedCycles,
    averageCycleDays: recycle.averageCycleDays,
    daysToRepayment: daysBetween(asOf, facility.repaymentDate),
    recycle,
    runway: repaymentRunway(facility, recycle.averageCycleDays, asOf),
  };
}
