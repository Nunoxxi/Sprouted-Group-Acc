/**
 * Grant management for the programme entity: budgets against actuals in the
 * donor's currency as well as ours, income recognised on receipt or deferred
 * and released as conditions are met or eligible spending happens, donor
 * reporting periods that follow the donor rather than our financial year,
 * and the in-kind and staff-time contributions donors ask to see.
 *
 * Pure: no I/O, no Prisma. Money is integer minor units throughout.
 */

import type { EntityType } from './data/types';
import type { TradingJournalLine } from './trading';

// --- who has grants -------------------------------------------------------------------------

/** Grants belong to a programme entity. The trading entities buy and sell. */
export function runsGrants(type: EntityType): boolean {
  return type === 'programs';
}

export const grantAccounts = {
  /** Grant money received but not yet earned. Only used by the deferred policy. */
  deferredIncome: '2070',
  restrictedIncome: '4005',
  unrestrictedIncome: '4001',
  /** Donated goods and services, grossed up: income here, expense in inKindExpense. */
  inKindIncome: '4035',
  inKindExpense: '6055',
  /** Promised but not yet received. */
  receivable: '1015',
} as const;

// --- the grant itself -------------------------------------------------------------------------

export type IncomePolicy = 'on-receipt' | 'deferred';
export const incomePolicies: IncomePolicy[] = ['on-receipt', 'deferred'];
export const incomePolicyLabels: Record<IncomePolicy, string> = {
  'on-receipt': 'Recognised when the money arrives',
  deferred: 'Held as deferred income and released as it is earned',
};

/** What releases deferred income. Only meaningful where the policy is deferred. */
export type ReleaseBasis = 'spending' | 'condition';

export type ReportingFrequency = 'monthly' | 'quarterly' | 'half-yearly' | 'annual' | 'final-only';
export const reportingFrequencies: ReportingFrequency[] = ['monthly', 'quarterly', 'half-yearly', 'annual', 'final-only'];
export const reportingFrequencyLabels: Record<ReportingFrequency, string> = {
  monthly: 'Every month',
  quarterly: 'Every quarter',
  'half-yearly': 'Every six months',
  annual: 'Every year',
  'final-only': 'One report at the end',
};
const monthsPerPeriod: Record<Exclude<ReportingFrequency, 'final-only'>, number> = { monthly: 1, quarterly: 3, 'half-yearly': 6, annual: 12 };

export type GrantLike = {
  startDate: string;
  endDate: string;
  reportingFrequency: ReportingFrequency;
  /** The donor's own anchor: their periods run from here, not our year end. */
  reportingStartDate: string | null;
  /** Days after a period ends that the report is due. */
  reportingDueDays: number;
};

export type ReportingPeriod = {
  index: number;
  label: string;
  start: string;
  /** Inclusive. */
  end: string;
  dueDate: string;
};

const dayMs = 86_400_000;
const parse = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The same day-of-month `months` later, clamped to the end of a shorter month. */
export function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return iso(parse(date) + days * dayMs);
}

/**
 * The donor's reporting periods across the grant. They start at the donor's
 * own anchor date when there is one, so a grant reporting on the donor's
 * calendar does not get chopped up by our year end. The last period always
 * ends on the grant's end date, however short that makes it.
 */
export function reportingPeriods(grant: GrantLike): ReportingPeriod[] {
  const start = grant.reportingStartDate || grant.startDate;
  const end = grant.endDate;
  if (parse(end) < parse(start)) return [];
  if (grant.reportingFrequency === 'final-only') {
    return [{ index: 1, label: 'Final report', start, end, dueDate: addDays(end, grant.reportingDueDays) }];
  }
  const step = monthsPerPeriod[grant.reportingFrequency];
  const periods: ReportingPeriod[] = [];
  let cursor = start;
  let index = 1;
  while (parse(cursor) <= parse(end) && index <= 200) {
    const nextStart = addMonths(start, step * index);
    const last = addDays(nextStart, -1);
    const periodEnd = parse(last) > parse(end) ? end : last;
    periods.push({
      index,
      label: `${cursor} to ${periodEnd}`,
      start: cursor,
      end: periodEnd,
      dueDate: addDays(periodEnd, grant.reportingDueDays),
    });
    if (periodEnd === end) break;
    cursor = nextStart;
    index += 1;
  }
  return periods;
}

/** The reporting period a date falls in, or null when it is outside the grant. */
export function periodFor(date: string, periods: ReportingPeriod[]): ReportingPeriod | null {
  return periods.find((period) => date >= period.start && date <= period.end) ?? null;
}

/** How far through the grant a date is, 0 to 1. */
export function elapsedFraction(grant: Pick<GrantLike, 'startDate' | 'endDate'>, asOf: string): number {
  const start = parse(grant.startDate);
  const end = parse(grant.endDate);
  if (end <= start) return parse(asOf) >= end ? 1 : 0;
  const now = parse(asOf);
  if (now <= start) return 0;
  if (now >= end) return 1;
  return (now - start) / (end - start);
}

// --- currency -------------------------------------------------------------------------------

/**
 * Donor currency → ours. `rate` is functional units per one unit of the
 * donor's currency, as a decimal string, exactly as the rest of the app
 * carries rates. Both directions round half away from zero.
 */
export function toFunctional(donorMinor: number, rate: string): number {
  const scaled = Math.round(donorMinor * Number(rate) * 1000) / 1000;
  return Math.round(scaled);
}

export function toDonor(functionalMinor: number, rate: string): number {
  const value = Number(rate);
  if (!(value > 0)) return 0;
  return Math.round(functionalMinor / value);
}

// --- budget against actual ---------------------------------------------------------------------

export type BudgetLine = {
  id: string;
  code: string;
  name: string;
  accountCode: string;
  /** In the donor's currency. The budget is what the donor agreed. */
  budgetDonorMinor: number;
};

/** One posting attributed to a grant, in our functional currency. */
export type GrantActual = { budgetLineId: string | null; date: string; functionalMinor: number };

export type BudgetStatus = 'on-track' | 'over' | 'under' | 'unbudgeted';

export type BudgetComparison = {
  budgetLineId: string;
  code: string;
  name: string;
  accountCode: string;
  budgetDonorMinor: number;
  budgetFunctionalMinor: number;
  actualDonorMinor: number;
  actualFunctionalMinor: number;
  /** Budget less actual: positive is money still to spend. */
  varianceDonorMinor: number;
  varianceFunctionalMinor: number;
  /** Actual as a fraction of budget, 0 when there is no budget. */
  spentFraction: number;
  status: BudgetStatus;
};

export type BudgetVsActual = {
  lines: BudgetComparison[];
  totals: Omit<BudgetComparison, 'budgetLineId' | 'code' | 'name' | 'accountCode'>;
  /** How far through the grant the comparison is taken. */
  elapsedFraction: number;
  overspent: BudgetComparison[];
  underspent: BudgetComparison[];
};

export type ComparisonOptions = {
  rate: string;
  asOf: string;
  /** Only postings in this window; the whole grant when absent. */
  from?: string;
  to?: string;
  /**
   * A line is significantly underspent below this share of what the elapsed
   * time would suggest it should have spent. 75 means "less than three
   * quarters of the way there".
   */
  underspendThresholdPct: number;
};

function statusOf(budgetDonor: number, actualDonor: number, elapsed: number, thresholdPct: number): BudgetStatus {
  if (budgetDonor <= 0) return actualDonor > 0 ? 'unbudgeted' : 'on-track';
  if (actualDonor > budgetDonor) return 'over';
  // Too early to call a line underspent: nothing is late in the first quarter.
  if (elapsed < 0.25) return 'on-track';
  const expected = budgetDonor * elapsed * (thresholdPct / 100);
  return actualDonor < expected ? 'under' : 'on-track';
}

/**
 * Budget against actual, per budget line, in both currencies. Actuals come
 * from the ledger in our functional currency and are shown in the donor's at
 * the grant's rate — the rate their budget was agreed at, so the two columns
 * compare like with like. Postings with no budget line are gathered into one
 * unbudgeted row rather than being dropped.
 */
export function budgetVsActual(
  grant: Pick<GrantLike, 'startDate' | 'endDate'>,
  budgetLines: BudgetLine[],
  actuals: GrantActual[],
  options: ComparisonOptions,
): BudgetVsActual {
  const inWindow = actuals.filter((actual) => (!options.from || actual.date >= options.from) && (!options.to || actual.date <= options.to));
  const elapsed = elapsedFraction(grant, options.asOf);
  const byLine = new Map<string, number>();
  for (const actual of inWindow) {
    const key = actual.budgetLineId ?? '';
    byLine.set(key, (byLine.get(key) ?? 0) + actual.functionalMinor);
  }

  const lines: BudgetComparison[] = budgetLines.map((line) => {
    const actualFunctionalMinor = byLine.get(line.id) ?? 0;
    const actualDonorMinor = toDonor(actualFunctionalMinor, options.rate);
    const budgetFunctionalMinor = toFunctional(line.budgetDonorMinor, options.rate);
    return {
      budgetLineId: line.id,
      code: line.code,
      name: line.name,
      accountCode: line.accountCode,
      budgetDonorMinor: line.budgetDonorMinor,
      budgetFunctionalMinor,
      actualDonorMinor,
      actualFunctionalMinor,
      varianceDonorMinor: line.budgetDonorMinor - actualDonorMinor,
      varianceFunctionalMinor: budgetFunctionalMinor - actualFunctionalMinor,
      spentFraction: line.budgetDonorMinor > 0 ? actualDonorMinor / line.budgetDonorMinor : 0,
      status: statusOf(line.budgetDonorMinor, actualDonorMinor, elapsed, options.underspendThresholdPct),
    };
  });

  const loose = byLine.get('') ?? 0;
  if (loose !== 0) {
    lines.push({
      budgetLineId: '',
      code: '—',
      name: 'Not on a budget line',
      accountCode: '',
      budgetDonorMinor: 0,
      budgetFunctionalMinor: 0,
      actualDonorMinor: toDonor(loose, options.rate),
      actualFunctionalMinor: loose,
      varianceDonorMinor: -toDonor(loose, options.rate),
      varianceFunctionalMinor: -loose,
      spentFraction: 0,
      status: 'unbudgeted',
    });
  }

  const sum = (pick: (line: BudgetComparison) => number) => lines.reduce((total, line) => total + pick(line), 0);
  const budgetDonorMinor = sum((l) => l.budgetDonorMinor);
  const actualDonorMinor = sum((l) => l.actualDonorMinor);
  return {
    lines,
    totals: {
      budgetDonorMinor,
      budgetFunctionalMinor: sum((l) => l.budgetFunctionalMinor),
      actualDonorMinor,
      actualFunctionalMinor: sum((l) => l.actualFunctionalMinor),
      varianceDonorMinor: sum((l) => l.varianceDonorMinor),
      varianceFunctionalMinor: sum((l) => l.varianceFunctionalMinor),
      spentFraction: budgetDonorMinor > 0 ? actualDonorMinor / budgetDonorMinor : 0,
      status: statusOf(budgetDonorMinor, actualDonorMinor, elapsed, options.underspendThresholdPct),
    },
    elapsedFraction: elapsed,
    overspent: lines.filter((line) => line.status === 'over' || line.status === 'unbudgeted'),
    underspent: lines.filter((line) => line.status === 'under'),
  };
}

/** Budget against actual for each of the donor's own reporting periods. */
export function byReportingPeriod(
  grant: GrantLike,
  budgetLines: BudgetLine[],
  actuals: GrantActual[],
  options: ComparisonOptions,
): { period: ReportingPeriod; comparison: BudgetVsActual }[] {
  return reportingPeriods(grant).map((period) => ({
    period,
    comparison: budgetVsActual(grant, budgetLines, actuals, { ...options, from: period.start, to: period.end }),
  }));
}

// --- income recognition ------------------------------------------------------------------------

const nameOf = (names: Record<string, string>, code: string, fallback: string) => names[code] ?? fallback;
const line = (names: Record<string, string>, accountCode: string, fallback: string, amount: number, type: 'debit' | 'credit'): TradingJournalLine => ({
  accountCode,
  accountName: nameOf(names, accountCode, fallback),
  amount,
  type,
});

/** The income account a grant's recognition lands in. */
export function incomeAccountFor(restricted: boolean): string {
  return restricted ? grantAccounts.restrictedIncome : grantAccounts.unrestrictedIncome;
}

/**
 * Money arriving from a donor. Under the on-receipt policy it is income the
 * day it lands. Under the deferred policy it is a liability until it is
 * earned — nothing reaches income here.
 */
export function receiptJournal(policy: IncomePolicy, restricted: boolean, amountMinor: number, bankCode: string, names: Record<string, string>): TradingJournalLine[] {
  if (amountMinor <= 0) return [];
  const credit = policy === 'deferred' ? grantAccounts.deferredIncome : incomeAccountFor(restricted);
  return [
    line(names, bankCode, 'Bank', amountMinor, 'debit'),
    line(names, credit, policy === 'deferred' ? 'Deferred Grant Income' : 'Grant Income', amountMinor, 'credit'),
  ];
}

/** Deferred income earned: out of the liability, into income. */
export function releaseJournal(restricted: boolean, amountMinor: number, names: Record<string, string>): TradingJournalLine[] {
  if (amountMinor <= 0) return [];
  return [
    line(names, grantAccounts.deferredIncome, 'Deferred Grant Income', amountMinor, 'debit'),
    line(names, incomeAccountFor(restricted), 'Grant Income', amountMinor, 'credit'),
  ];
}

export type ReleasePosition = {
  /** Received from the donor and still held as deferred income. */
  heldMinor: number;
  /** Eligible spending not yet matched by a release. */
  earnedNotReleasedMinor: number;
  /** What a spending-based release would post now. */
  releasableMinor: number;
};

/**
 * How much deferred income a grant may release. Spending earns the money, so
 * the release is the eligible spend not yet released — but never more than is
 * actually held: you cannot release money you have not received, however much
 * you have spent. What is left over stays earned and releases when the next
 * instalment arrives.
 */
export function spendingRelease(receivedMinor: number, releasedMinor: number, eligibleSpendMinor: number): ReleasePosition {
  const heldMinor = Math.max(receivedMinor - releasedMinor, 0);
  const earnedNotReleasedMinor = Math.max(eligibleSpendMinor - releasedMinor, 0);
  return { heldMinor, earnedNotReleasedMinor, releasableMinor: Math.min(heldMinor, earnedNotReleasedMinor) };
}

/** A condition-based release: what was asked for, capped at what is held. */
export function conditionRelease(receivedMinor: number, releasedMinor: number, requestedMinor: number): number {
  return Math.max(Math.min(requestedMinor, receivedMinor - releasedMinor), 0);
}

// --- in-kind contributions -----------------------------------------------------------------------

export type InKindKind = 'goods' | 'services' | 'facilities';
export const inKindKinds: InKindKind[] = ['goods', 'services', 'facilities'];
export const inKindKindLabels: Record<InKindKind, string> = { goods: 'Donated goods', services: 'Donated services', facilities: 'Donated use of facilities' };

/**
 * A donated good or service, grossed up: income for what it was worth, and
 * the same amount as expenditure, because it was used. The surplus is
 * unchanged — which is the point of showing it — and the donor sees the
 * contribution they made in kind.
 */
export function inKindJournal(valueMinor: number, names: Record<string, string>): TradingJournalLine[] {
  if (valueMinor <= 0) return [];
  return [
    line(names, grantAccounts.inKindExpense, 'In-kind Goods & Services Used', valueMinor, 'debit'),
    line(names, grantAccounts.inKindIncome, 'Donated Goods & Services', valueMinor, 'credit'),
  ];
}

// --- staff time ------------------------------------------------------------------------------------

/** Hours to money. Hours carry two decimals; the rate is per hour in minor units. */
export function staffTimeValue(hours: number, rateMinorPerHour: number): number {
  if (!(hours > 0) || !(rateMinorPerHour > 0)) return 0;
  return Math.round((Math.round(hours * 100) / 100) * rateMinorPerHour);
}

/**
 * Staff time charged to a grant. The salary was already paid and is already
 * in the books; this moves its cost onto the grant without changing what the
 * entity spent in total — the same account is debited with the grant's code
 * and credited without it. Totals are untouched; only the analysis changes.
 */
export function staffTimeJournal(valueMinor: number, salaryCode: string, names: Record<string, string>): TradingJournalLine[] {
  if (valueMinor <= 0) return [];
  return [
    line(names, salaryCode, 'Staff Salaries', valueMinor, 'debit'),
    line(names, salaryCode, 'Staff Salaries', valueMinor, 'credit'),
  ];
}

// --- conditions ---------------------------------------------------------------------------------------

export type ConditionLike = { description: string; dueDate: string | null; metAt: string | null };

/** Conditions still to meet, those met, and those now overdue. */
export function conditionSummary(conditions: ConditionLike[], asOf: string) {
  const outstanding = conditions.filter((condition) => !condition.metAt);
  return {
    total: conditions.length,
    met: conditions.length - outstanding.length,
    outstanding: outstanding.length,
    overdue: outstanding.filter((condition) => condition.dueDate && condition.dueDate < asOf).length,
  };
}

// --- one grant's position -------------------------------------------------------------------------------

export type GrantPosition = {
  awardDonorMinor: number;
  awardFunctionalMinor: number;
  receivedFunctionalMinor: number;
  /** Awarded less received, at the grant's rate: what the donor still owes. */
  outstandingFunctionalMinor: number;
  spentFunctionalMinor: number;
  recognisedFunctionalMinor: number;
  deferredFunctionalMinor: number;
  spentFraction: number;
};

export function grantPosition(
  awardDonorMinor: number,
  rate: string,
  receivedFunctionalMinor: number,
  recognisedFunctionalMinor: number,
  spentFunctionalMinor: number,
  policy: IncomePolicy,
): GrantPosition {
  const awardFunctionalMinor = toFunctional(awardDonorMinor, rate);
  return {
    awardDonorMinor,
    awardFunctionalMinor,
    receivedFunctionalMinor,
    outstandingFunctionalMinor: awardFunctionalMinor - receivedFunctionalMinor,
    spentFunctionalMinor,
    recognisedFunctionalMinor: policy === 'deferred' ? recognisedFunctionalMinor : receivedFunctionalMinor,
    deferredFunctionalMinor: policy === 'deferred' ? Math.max(receivedFunctionalMinor - recognisedFunctionalMinor, 0) : 0,
    spentFraction: awardFunctionalMinor > 0 ? spentFunctionalMinor / awardFunctionalMinor : 0,
  };
}
