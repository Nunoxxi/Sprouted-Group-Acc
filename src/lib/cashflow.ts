/**
 * Cash flow forecasting: a 13-week rolling view and a 12-month view, built
 * from what the books already know — open invoices and bills, undelivered
 * contracts, the buying seasons, agent floats, grant schedules and recurring
 * costs — plus whatever is added by hand.
 *
 * Every flow carries its own currency and is forecast in it. The combined
 * view converts at rates the person sets, so a cedi shortage is visible even
 * when the dollar account looks healthy.
 *
 * Pure: no I/O, no Prisma. Money is integer minor units throughout.
 */

import type { Currency } from './fx';

// --- buckets ---------------------------------------------------------------------------------

export type Horizon = 'weekly-13' | 'monthly-12';
export const horizons: Horizon[] = ['weekly-13', 'monthly-12'];
export const horizonLabels: Record<Horizon, string> = { 'weekly-13': '13 weeks', 'monthly-12': '12 months' };

export type Bucket = {
  index: number;
  /** Inclusive. */
  start: string;
  /** Inclusive. */
  end: string;
  label: string;
};

const dayMs = 86_400_000;
const parse = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return iso(parse(date) + days * dayMs);
}

/** The Monday of the week a date falls in. */
export function weekStart(date: string): string {
  const day = new Date(parse(date)).getUTCDay(); // 0 = Sunday
  return addDays(date, day === 0 ? -6 : 1 - day);
}

export function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * The buckets a horizon covers, starting from the week or month the anchor
 * falls in. Thirteen weeks rolls forward with today; twelve months covers
 * the year ahead.
 */
export function bucketsFor(horizon: Horizon, anchor: string): Bucket[] {
  if (horizon === 'weekly-13') {
    const first = weekStart(anchor);
    return Array.from({ length: 13 }, (_, index) => {
      const start = addDays(first, index * 7);
      const end = addDays(start, 6);
      return { index, start, end, label: `w/c ${start}` };
    });
  }
  const first = monthStart(anchor);
  return Array.from({ length: 12 }, (_, index) => {
    const start = addMonths(first, index);
    const end = addDays(addMonths(first, index + 1), -1);
    return { index, start, end, label: start.slice(0, 7) };
  });
}

/** The bucket a date falls in, or null when it is outside the horizon. */
export function bucketOf(date: string, buckets: Bucket[]): number | null {
  const found = buckets.findIndex((bucket) => date >= bucket.start && date <= bucket.end);
  return found < 0 ? null : found;
}

// --- flows -----------------------------------------------------------------------------------

/** Where a forecast line came from. Every one is traceable back to a record. */
export type FlowSource =
  | 'opening'
  | 'invoice'
  | 'bill'
  | 'contract'
  | 'purchase'
  | 'float'
  | 'grant'
  | 'recurring'
  | 'manual';

export const flowSourceLabels: Record<FlowSource, string> = {
  opening: 'Cash on hand',
  invoice: 'Customer invoices',
  bill: 'Supplier bills',
  contract: 'Sales contracts to deliver',
  purchase: 'Commodity purchases',
  float: 'Agent floats',
  grant: 'Grant receipts',
  recurring: 'Payroll, rent and other recurring',
  manual: 'Added by hand',
};

export type Flow = {
  source: FlowSource;
  date: string;
  currency: Currency;
  /** Signed: positive is money in, negative is money out. */
  amountMinor: number;
  description: string;
  /** The record this came from, for the person to go and look at. */
  reference: string;
};

// --- the assumptions a scenario can change -------------------------------------------------------

export type Assumptions = {
  /** Days added to every customer invoice due date: how late they really pay. */
  collectionDelayDays: number;
  /** Percent of the planned commodity price. 100 leaves it alone. */
  pricePct: number;
  /** Percent of the planned commodity volume. */
  volumePct: number;
  /** Days before a purchase that the agent's float has to be advanced. */
  floatLeadDays: number;
  /** Functional units per one unit of each currency, for the combined view. */
  rates: Partial<Record<Currency, string>>;
  /** Below this, a bucket is flagged. In the functional currency. */
  minimumCashMinor: number;
};

export const defaultAssumptions: Assumptions = {
  collectionDelayDays: 0,
  pricePct: 100,
  volumePct: 100,
  floatLeadDays: 7,
  rates: {},
  minimumCashMinor: 0,
};

const pct = (value: number, percent: number) => Math.round((value * percent) / 100);

// --- seasonality -------------------------------------------------------------------------------

export type Season = {
  id: string;
  commodityName: string;
  currency: Currency;
  startDate: string;
  /** Where buying is heaviest. The curve rises to here and falls away after. */
  peakDate: string;
  endDate: string;
  /** What we expect to buy across the whole season, in grams. */
  expectedGrams: number;
  /** What we expect to pay, minor units per kilogram. */
  priceMinorPerKgMinor: number;
};

/**
 * A season's buying spread across days as a triangle: nothing at the start,
 * most at the peak, nothing again at the end. Real buying follows the crop,
 * and a flat line would hide the squeeze that matters — the weeks around the
 * peak, when money goes out fastest and nothing has been sold yet.
 *
 * Returns the share of the season's volume falling on each day, summing to 1.
 */
export function seasonProfile(season: Pick<Season, 'startDate' | 'peakDate' | 'endDate'>): { date: string; share: number }[] {
  const start = parse(season.startDate);
  const end = parse(season.endDate);
  if (end < start) return [];
  const peak = Math.min(Math.max(parse(season.peakDate), start), end);
  const days: { date: string; weight: number }[] = [];
  for (let ms = start; ms <= end; ms += dayMs) {
    // Rise to 1 at the peak, fall back to 0 at the end. A season that peaks
    // on its first or last day is a ramp rather than a triangle.
    const weight = ms <= peak ? (peak === start ? 1 : (ms - start) / (peak - start)) : peak === end ? 1 : (end - ms) / (end - peak);
    days.push({ date: iso(ms), weight: Math.max(weight, 0.0001) });
  }
  const total = days.reduce((sum, day) => sum + day.weight, 0);
  return days.map((day) => ({ date: day.date, share: day.weight / total }));
}

/**
 * The cash a season needs and when. Purchases are dated when the produce is
 * bought; the float that funds them leaves `floatLeadDays` earlier, so the
 * flows show money going out before any of it has been sold.
 *
 * Two lines come out of a season: the purchases themselves, and the
 * float working capital — one lead period's buying, advanced at the start of
 * the season and returned at the end. Only the purchases are a cost; the
 * float is timing, and it comes back.
 */
export function seasonFlows(season: Season, assumptions: Assumptions): Flow[] {
  const grams = pct(season.expectedGrams, assumptions.volumePct);
  const price = pct(season.priceMinorPerKgMinor, assumptions.pricePct);
  if (grams <= 0 || price <= 0) return [];
  const profile = seasonProfile(season);
  if (profile.length === 0) return [];

  const totalMinor = Math.round((grams / 1000) * price);
  const flows: Flow[] = [];
  let allocated = 0;
  profile.forEach((day, index) => {
    const raw = index === profile.length - 1 ? totalMinor - allocated : Math.round(totalMinor * day.share);
    allocated += raw;
    if (raw === 0) return;
    flows.push({
      source: 'purchase',
      date: addDays(day.date, -assumptions.floatLeadDays),
      currency: season.currency,
      amountMinor: -raw,
      description: `${season.commodityName} buying`,
      reference: season.id,
    });
  });

  // The float that has to be outstanding to keep buying going: one lead
  // period of purchases, out at the start and back at the end.
  const leadDays = Math.max(assumptions.floatLeadDays, 0);
  if (leadDays > 0) {
    const seasonDays = profile.length;
    const floatMinor = Math.round((totalMinor * Math.min(leadDays, seasonDays)) / seasonDays);
    if (floatMinor > 0) {
      flows.push({ source: 'float', date: addDays(season.startDate, -leadDays), currency: season.currency, amountMinor: -floatMinor, description: `${season.commodityName}: agent float advanced`, reference: season.id });
      flows.push({ source: 'float', date: season.endDate, currency: season.currency, amountMinor: floatMinor, description: `${season.commodityName}: agent float recovered`, reference: season.id });
    }
  }
  return flows;
}

// --- recurring costs ---------------------------------------------------------------------------

export type RecurringFrequency = 'weekly' | 'monthly' | 'quarterly' | 'annual';
export const recurringFrequencies: RecurringFrequency[] = ['weekly', 'monthly', 'quarterly', 'annual'];
export const recurringFrequencyLabels: Record<RecurringFrequency, string> = { weekly: 'Every week', monthly: 'Every month', quarterly: 'Every quarter', annual: 'Every year' };

export type Recurring = {
  id: string;
  name: string;
  currency: Currency;
  /** Positive: what goes out each time. */
  amountMinor: number;
  frequency: RecurringFrequency;
  startDate: string;
  endDate: string | null;
};

/** Every occurrence of a recurring cost inside a window. */
export function recurringFlows(cost: Recurring, from: string, to: string): Flow[] {
  const flows: Flow[] = [];
  const step = { weekly: 0, monthly: 1, quarterly: 3, annual: 12 }[cost.frequency];
  let date = cost.startDate;
  for (let occurrence = 0; occurrence < 600; occurrence++) {
    date = cost.frequency === 'weekly' ? addDays(cost.startDate, occurrence * 7) : addMonths(cost.startDate, occurrence * step);
    if (date > to) break;
    if (cost.endDate && date > cost.endDate) break;
    if (date >= from) {
      flows.push({ source: 'recurring', date, currency: cost.currency, amountMinor: -Math.abs(cost.amountMinor), description: cost.name, reference: cost.id });
    }
  }
  return flows;
}

// --- grants ------------------------------------------------------------------------------------

export type GrantSchedule = {
  id: string;
  code: string;
  currency: Currency;
  /** Still to come from the donor, in their currency. */
  outstandingMinor: number;
  /** The donor's own reporting periods; money is expected at the start of each. */
  periodStarts: string[];
};

/**
 * What a grant is expected to bring in. The agreement rarely names payment
 * dates, so what is left of the award is spread evenly across the reporting
 * periods still to come and dated at the start of each: the donor's own
 * schedule, which is the best the books know. Periods already past bring
 * nothing — that money is either in or overdue, and overdue is a
 * conversation, not a forecast.
 */
export function grantFlows(grant: GrantSchedule, from: string): Flow[] {
  if (grant.outstandingMinor <= 0) return [];
  const ahead = grant.periodStarts.filter((start) => start >= from);
  if (ahead.length === 0) return [];
  const each = Math.round(grant.outstandingMinor / ahead.length);
  return ahead.map((start, index) => ({
    source: 'grant' as const,
    date: start,
    currency: grant.currency,
    // The last instalment carries the rounding, so the flows add back to the award.
    amountMinor: index === ahead.length - 1 ? grant.outstandingMinor - each * (ahead.length - 1) : each,
    description: `${grant.code}: expected instalment`,
    reference: grant.id,
  }));
}

// --- documents and contracts ---------------------------------------------------------------------

export type OpenDocument = {
  id: string;
  kind: 'invoice' | 'bill';
  number: string;
  contactName: string;
  currency: Currency;
  /** Still outstanding, in the document's currency. */
  outstandingMinor: number;
  dueDate: string;
};

/**
 * Open documents as flows. An invoice is money in on its due date plus the
 * collection delay — the scenario's view of how late customers really are.
 * A bill is money out on its due date: we are the ones being chased.
 */
export function documentFlows(documents: OpenDocument[], assumptions: Assumptions): Flow[] {
  return documents
    .filter((document) => document.outstandingMinor > 0)
    .map((document) => ({
      source: document.kind === 'invoice' ? ('invoice' as const) : ('bill' as const),
      date: document.kind === 'invoice' ? addDays(document.dueDate, assumptions.collectionDelayDays) : document.dueDate,
      currency: document.currency,
      amountMinor: document.kind === 'invoice' ? document.outstandingMinor : -document.outstandingMinor,
      description: `${document.number} — ${document.contactName}`,
      reference: document.id,
    }));
}

export type OpenContract = {
  id: string;
  contractNo: string;
  buyerName: string;
  currency: Currency;
  /** Value still to deliver, in the contract's currency. */
  undeliveredMinor: number;
  /** When the contract period ends: the last date we could deliver by. */
  deliveryDate: string;
  /** Days after delivery that the buyer pays. */
  paymentTermsDays: number;
};

/**
 * Contracts still to deliver: revenue is cash when the buyer pays, which is
 * the delivery date plus their terms. The collection delay applies here too —
 * a buyer who is late on invoices is late on contracts.
 */
export function contractFlows(contracts: OpenContract[], assumptions: Assumptions): Flow[] {
  return contracts
    .filter((contract) => contract.undeliveredMinor > 0)
    .map((contract) => ({
      source: 'contract' as const,
      date: addDays(contract.deliveryDate, contract.paymentTermsDays + assumptions.collectionDelayDays),
      currency: contract.currency,
      amountMinor: contract.undeliveredMinor,
      description: `${contract.contractNo} — ${contract.buyerName}`,
      reference: contract.id,
    }));
}

// --- the forecast ---------------------------------------------------------------------------------

export type BucketTotals = {
  bucket: Bucket;
  /** Signed totals by source, for the rows of the table. */
  bySource: Partial<Record<FlowSource, number>>;
  inMinor: number;
  outMinor: number;
  netMinor: number;
  /** Cash at the end of the bucket. */
  closingMinor: number;
  /** True when the closing balance is under the minimum. */
  belowMinimum: boolean;
};

export type CurrencyForecast = {
  currency: Currency;
  openingMinor: number;
  buckets: BucketTotals[];
  /** Flows that fall outside the horizon, kept so nothing is silently lost. */
  beyondMinor: number;
  lowestClosingMinor: number;
  firstShortfall: Bucket | null;
};

/**
 * One currency's forecast: the opening balance, then each bucket's flows and
 * the balance they leave. A minimum of zero flags only a negative balance.
 */
export function forecastCurrency(
  currency: Currency,
  openingMinor: number,
  flows: Flow[],
  buckets: Bucket[],
  minimumMinor: number,
): CurrencyForecast {
  const totals: BucketTotals[] = buckets.map((bucket) => ({
    bucket,
    bySource: {},
    inMinor: 0,
    outMinor: 0,
    netMinor: 0,
    closingMinor: 0,
    belowMinimum: false,
  }));
  let beyondMinor = 0;

  for (const flow of flows) {
    if (flow.currency !== currency || flow.amountMinor === 0) continue;
    const index = bucketOf(flow.date, buckets);
    if (index === null) {
      // Anything before the horizon has already happened as far as the
      // opening balance is concerned; anything after is noted, not dropped.
      if (flow.date > buckets[buckets.length - 1].end) beyondMinor += flow.amountMinor;
      continue;
    }
    const target = totals[index];
    target.bySource[flow.source] = (target.bySource[flow.source] ?? 0) + flow.amountMinor;
    if (flow.amountMinor > 0) target.inMinor += flow.amountMinor;
    else target.outMinor += -flow.amountMinor;
    target.netMinor += flow.amountMinor;
  }

  let running = openingMinor;
  let lowestClosingMinor = openingMinor;
  let firstShortfall: Bucket | null = null;
  for (const total of totals) {
    running += total.netMinor;
    total.closingMinor = running;
    total.belowMinimum = running < minimumMinor;
    if (running < lowestClosingMinor) lowestClosingMinor = running;
    if (total.belowMinimum && !firstShortfall) firstShortfall = total.bucket;
  }

  return { currency, openingMinor, buckets: totals, beyondMinor, lowestClosingMinor, firstShortfall };
}

export type Forecast = {
  horizon: Horizon;
  buckets: Bucket[];
  /** One per currency that has an opening balance or any flow. */
  byCurrency: CurrencyForecast[];
  /** Everything converted at the scenario's rates and added together. */
  combined: CurrencyForecast;
  minimumCashMinor: number;
};

/** Convert at a scenario rate; a currency with no rate is left at 1:1 and flagged by `missingRates`. */
export function convertAt(amountMinor: number, rate: string | undefined): number {
  if (!rate) return amountMinor;
  const value = Number(rate);
  if (!Number.isFinite(value) || value <= 0) return amountMinor;
  return Math.round(amountMinor * value);
}

/**
 * The whole forecast: each currency on its own, then a combined view at the
 * rates the person set. The combined view is the one that answers "will we
 * run short of cedis" — a healthy dollar balance does not pay a cedi wage
 * bill until somebody sells the dollars.
 */
export function buildForecast(
  horizon: Horizon,
  anchor: string,
  openings: Partial<Record<Currency, number>>,
  flows: Flow[],
  assumptions: Assumptions,
  functionalCurrency: Currency,
): Forecast {
  const buckets = bucketsFor(horizon, anchor);
  const currencies = [...new Set([...(Object.keys(openings) as Currency[]), ...flows.map((flow) => flow.currency)])].sort((a, b) =>
    a === functionalCurrency ? -1 : b === functionalCurrency ? 1 : a.localeCompare(b),
  );

  const rateFor = (currency: Currency) => (currency === functionalCurrency ? '1.0' : assumptions.rates[currency]);
  const byCurrency = currencies.map((currency) =>
    forecastCurrency(
      currency,
      openings[currency] ?? 0,
      flows,
      buckets,
      // The minimum is set in the functional currency; each currency is
      // measured against its own share of it, which is the minimum converted
      // back at the scenario rate.
      currency === functionalCurrency ? assumptions.minimumCashMinor : 0,
    ),
  );

  const combinedFlows: Flow[] = flows.map((flow) => ({ ...flow, currency: functionalCurrency, amountMinor: convertAt(flow.amountMinor, rateFor(flow.currency)) }));
  const combinedOpening = currencies.reduce((total, currency) => total + convertAt(openings[currency] ?? 0, rateFor(currency)), 0);
  const combined = forecastCurrency(functionalCurrency, combinedOpening, combinedFlows, buckets, assumptions.minimumCashMinor);

  return { horizon, buckets, byCurrency, combined, minimumCashMinor: assumptions.minimumCashMinor };
}

/** Currencies with flows but no rate set: the combined view is wrong until they have one. */
export function missingRates(flows: Flow[], assumptions: Assumptions, functionalCurrency: Currency): Currency[] {
  return [...new Set(flows.map((flow) => flow.currency))].filter((currency) => currency !== functionalCurrency && !assumptions.rates[currency]);
}

// --- scenarios side by side ---------------------------------------------------------------------------

export type ScenarioComparison = {
  name: string;
  closingByBucket: number[];
  lowestClosingMinor: number;
  firstShortfallLabel: string | null;
  /** Against the first scenario in the list, bucket by bucket. */
  differenceFromFirst: number[];
};

/** Two or more scenarios lined up on the same buckets, in the combined view. */
export function compareScenarios(scenarios: { name: string; forecast: Forecast }[]): ScenarioComparison[] {
  if (scenarios.length === 0) return [];
  const base = scenarios[0].forecast.combined.buckets.map((bucket) => bucket.closingMinor);
  return scenarios.map((scenario) => {
    const closingByBucket = scenario.forecast.combined.buckets.map((bucket) => bucket.closingMinor);
    return {
      name: scenario.name,
      closingByBucket,
      lowestClosingMinor: scenario.forecast.combined.lowestClosingMinor,
      firstShortfallLabel: scenario.forecast.combined.firstShortfall?.label ?? null,
      differenceFromFirst: closingByBucket.map((value, index) => value - (base[index] ?? 0)),
    };
  });
}

// --- the group -----------------------------------------------------------------------------------------

export type EntityForecast = { entityId: string; entityName: string; forecast: Forecast };

export type GroupForecast = {
  horizon: Horizon;
  buckets: Bucket[];
  entities: EntityForecast[];
  /** Every entity's combined view added together, in the group currency. */
  combined: CurrencyForecast;
  minimumCashMinor: number;
};

/**
 * The group view: each entity's combined forecast added together. Entities
 * keep their own functional currency, so each one's combined figures are
 * converted once more at the group rate for its currency.
 *
 * Intercompany flows are not eliminated: one entity paying another is real
 * cash leaving one bank account and arriving in a different one, and the
 * group total is unchanged by it anyway.
 */
export function buildGroupForecast(
  entities: { entityId: string; entityName: string; functionalCurrency: Currency; forecast: Forecast }[],
  rates: Partial<Record<Currency, string>>,
  groupCurrency: Currency,
  minimumCashMinor: number,
): GroupForecast {
  const first = entities[0]?.forecast;
  const buckets = first?.buckets ?? [];
  const totals: BucketTotals[] = buckets.map((bucket) => ({ bucket, bySource: {}, inMinor: 0, outMinor: 0, netMinor: 0, closingMinor: 0, belowMinimum: false }));
  let openingMinor = 0;

  for (const entity of entities) {
    const rate = entity.functionalCurrency === groupCurrency ? '1.0' : rates[entity.functionalCurrency];
    openingMinor += convertAt(entity.forecast.combined.openingMinor, rate);
    entity.forecast.combined.buckets.forEach((bucket, index) => {
      const target = totals[index];
      if (!target) return;
      for (const [source, amount] of Object.entries(bucket.bySource)) {
        target.bySource[source as FlowSource] = (target.bySource[source as FlowSource] ?? 0) + convertAt(amount as number, rate);
      }
      target.inMinor += convertAt(bucket.inMinor, rate);
      target.outMinor += convertAt(bucket.outMinor, rate);
      target.netMinor += convertAt(bucket.netMinor, rate);
    });
  }

  let running = openingMinor;
  let lowestClosingMinor = openingMinor;
  let firstShortfall: Bucket | null = null;
  for (const total of totals) {
    running += total.netMinor;
    total.closingMinor = running;
    total.belowMinimum = running < minimumCashMinor;
    if (running < lowestClosingMinor) lowestClosingMinor = running;
    if (total.belowMinimum && !firstShortfall) firstShortfall = total.bucket;
  }

  return {
    horizon: first?.horizon ?? 'weekly-13',
    buckets,
    entities: entities.map(({ entityId, entityName, forecast }) => ({ entityId, entityName, forecast })),
    combined: { currency: groupCurrency, openingMinor, buckets: totals, beyondMinor: entities.reduce((sum, entity) => sum + entity.forecast.combined.beyondMinor, 0), lowestClosingMinor, firstShortfall },
    minimumCashMinor,
  };
}

// --- putting one entity's flows together --------------------------------------------------------------

export type CashSources = {
  openings: Record<string, number>;
  /** Flows that do not move with the assumptions: grant instalments, mostly. */
  fixedFlows: Flow[];
  seasons: Season[];
  recurring: Recurring[];
  documents: OpenDocument[];
  contracts: OpenContract[];
  /** Lines the person added to this scenario. */
  manual: { id: string; date: string; currency: Currency; amountMinor: number; description: string }[];
};

/**
 * Every flow one entity's forecast is made of, under one set of assumptions.
 * Recurring costs are generated across the window the buckets cover; the
 * rest are dated by the records they come from.
 */
export function flowsFor(sources: CashSources, assumptions: Assumptions, buckets: Bucket[]): Flow[] {
  const from = buckets[0]?.start ?? '';
  const to = buckets[buckets.length - 1]?.end ?? '';
  return [
    ...sources.fixedFlows,
    ...documentFlows(sources.documents, assumptions),
    ...contractFlows(sources.contracts, assumptions),
    ...sources.seasons.flatMap((season) => seasonFlows(season, assumptions)),
    ...(from && to ? sources.recurring.flatMap((cost) => recurringFlows(cost, from, to)) : []),
    ...sources.manual.map((line) => ({ source: 'manual' as const, date: line.date, currency: line.currency, amountMinor: line.amountMinor, description: line.description, reference: line.id })),
  ];
}
