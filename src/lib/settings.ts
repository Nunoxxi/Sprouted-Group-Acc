/**
 * The rules behind the Settings area: projects and their budgets, funds,
 * fixed asset classes and the tax rates.
 *
 * The one that matters most is the budget. A budget line's original figure is
 * written once and never edited — a revision goes in beside it. That is what
 * lets a report show the budget as it was agreed, the budget as it stands,
 * and the difference, which is the whole point of revising one mid-project.
 *
 * Pure: no I/O, no Prisma.
 */

import type { Currency } from './fx';

// --- projects -------------------------------------------------------------------------------

export type ProjectKind = 'grant-funded' | 'service-contract';

export const projectKinds: ProjectKind[] = ['grant-funded', 'service-contract'];

export const projectKindLabels: Record<ProjectKind, string> = {
  'grant-funded': 'Paid for by a grant',
  'service-contract': 'Paid for under a contract for services',
};

export type ProjectDraft = {
  code: string;
  name: string;
  kind: ProjectKind;
  currency: Currency;
  fundingMinor: number;
  startDate?: string | null;
  endDate?: string | null;
  fundCode?: string | null;
};

export type Invalid = { field: string; message: string };

const isDate = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());

export function validateProject(draft: ProjectDraft, existingCodes: readonly string[], originalCode?: string): Invalid[] {
  const problems: Invalid[] = [];
  const code = draft.code.trim();
  const name = draft.name.trim();

  if (!code) problems.push({ field: 'code', message: 'A project needs a short code.' });
  else if (code.length > 32) problems.push({ field: 'code', message: 'Keep the code under 32 characters.' });
  if (!name) problems.push({ field: 'name', message: 'A project needs a name.' });
  if (code && existingCodes.includes(code) && code !== originalCode) {
    problems.push({ field: 'code', message: `${code} is already used by another project.` });
  }
  if (!Number.isSafeInteger(draft.fundingMinor) || draft.fundingMinor < 0) {
    problems.push({ field: 'fundingMinor', message: 'The amount funded cannot be negative.' });
  }

  const start = draft.startDate?.trim() || '';
  const end = draft.endDate?.trim() || '';
  if (start && !isDate(start)) problems.push({ field: 'startDate', message: 'The start date has to be a real date.' });
  if (end && !isDate(end)) problems.push({ field: 'endDate', message: 'The end date has to be a real date.' });
  if (start && end && isDate(start) && isDate(end) && end < start) {
    problems.push({ field: 'endDate', message: 'The project cannot end before it starts.' });
  }

  return problems;
}

/**
 * Whether a project can be closed. A project is closed, not deleted, so
 * whatever was coded to it still reports; closing only takes it out of the
 * lists people code against.
 */
export function canCloseProject(project: { closed: boolean }): { ok: true } | { ok: false; error: string } {
  if (project.closed) return { ok: false, error: 'That project is already closed.' };
  return { ok: true };
}

export function canReopenProject(project: { closed: boolean }): { ok: true } | { ok: false; error: string } {
  if (!project.closed) return { ok: false, error: 'That project is already open.' };
  return { ok: true };
}

/** A project may only be deleted while nothing at all has been coded to it. */
export function canDeleteProject(facts: { postings: number; documentLines: number; grants: number; budgetLines: number }): { ok: true } | { ok: false; error: string } {
  if (facts.postings > 0) return { ok: false, error: `${facts.postings} transaction${facts.postings === 1 ? '' : 's'} are coded to this project, so it cannot be deleted. Close it instead — it will leave the coding lists and stay in the reports.` };
  if (facts.documentLines > 0) return { ok: false, error: 'Invoice or bill lines are coded to this project, so it cannot be deleted. Close it instead.' };
  if (facts.grants > 0) return { ok: false, error: 'A grant points at this project, so it cannot be deleted. Close it instead.' };
  return { ok: true };
}

// --- budget lines ---------------------------------------------------------------------------

export type BudgetLine = {
  id: string;
  name: string;
  originalMinor: number;
  /** Null until somebody revises it. */
  revisedMinor: number | null;
};

export type BudgetComparison = {
  name: string;
  originalMinor: number;
  /** What it stands at now: the revision if there is one, else the original. */
  currentMinor: number;
  /** Positive where the revision raised the line. */
  movementMinor: number;
  revised: boolean;
};

/** What a line stands at now. */
export function currentBudget(line: Pick<BudgetLine, 'originalMinor' | 'revisedMinor'>): number {
  return line.revisedMinor ?? line.originalMinor;
}

/** Each line as originally agreed, as it stands, and the movement between. */
export function compareBudget(lines: readonly BudgetLine[]): BudgetComparison[] {
  return lines.map((line) => ({
    name: line.name,
    originalMinor: line.originalMinor,
    currentMinor: currentBudget(line),
    movementMinor: currentBudget(line) - line.originalMinor,
    revised: line.revisedMinor !== null,
  }));
}

export type BudgetTotals = { originalMinor: number; currentMinor: number; movementMinor: number; revisedLines: number };

export function budgetTotals(lines: readonly BudgetLine[]): BudgetTotals {
  const originalMinor = lines.reduce((sum, line) => sum + line.originalMinor, 0);
  const currentMinor = lines.reduce((sum, line) => sum + currentBudget(line), 0);
  return {
    originalMinor,
    currentMinor,
    movementMinor: currentMinor - originalMinor,
    revisedLines: lines.filter((line) => line.revisedMinor !== null).length,
  };
}

export function validateBudgetLine(draft: { name: string; amountMinor: number }): Invalid[] {
  const problems: Invalid[] = [];
  if (!draft.name.trim()) problems.push({ field: 'name', message: 'A budget line needs a name.' });
  if (!Number.isSafeInteger(draft.amountMinor) || draft.amountMinor < 0) {
    problems.push({ field: 'amountMinor', message: 'A budget line cannot be negative.' });
  }
  return problems;
}

/**
 * The note shown when a budget line is revised, so the change is understood
 * before it is saved rather than discovered in a report afterwards.
 */
export function revisionEffect(line: BudgetLine, toMinor: number): string {
  const from = currentBudget(line);
  const direction = toMinor > from ? 'raises' : toMinor < from ? 'lowers' : 'leaves';
  const original = line.revisedMinor === null
    ? 'The figure first agreed is kept as it is, so reports can show both.'
    : 'This replaces the previous revision. The figure first agreed is still kept.';
  return `This ${direction} ${line.name} from ${(from / 100).toFixed(2)} to ${(toMinor / 100).toFixed(2)}. ${original}`;
}

// --- funds ----------------------------------------------------------------------------------

export type FundClassification = 'restricted' | 'unrestricted';

export function validateFund(draft: { code: string; name: string }, existingCodes: readonly string[], originalCode?: string): Invalid[] {
  const problems: Invalid[] = [];
  const code = draft.code.trim();
  if (!code) problems.push({ field: 'code', message: 'A fund needs a short code.' });
  if (!draft.name.trim()) problems.push({ field: 'name', message: 'A fund needs a name.' });
  if (code && existingCodes.includes(code) && code !== originalCode) {
    problems.push({ field: 'code', message: `${code} is already used by another fund.` });
  }
  return problems;
}

/**
 * Changing a fund from restricted to unrestricted, or back, once money has
 * gone through it moves that money between the restricted and unrestricted
 * columns of every fund report already produced.
 */
export function fundClassificationEffect(before: FundClassification, after: FundClassification, postings: number): string | null {
  if (before === after || postings === 0) return null;
  return `${postings} transaction${postings === 1 ? '' : 's'} have gone through this fund. Moving it from ${before} to ${after} moves all of them between the two columns of every fund report, including periods already closed.`;
}

// --- fixed asset classes ---------------------------------------------------------------------

export type DepreciationMethod = 'straight-line' | 'reducing-balance';

export const depreciationMethods: DepreciationMethod[] = ['straight-line', 'reducing-balance'];

export const depreciationMethodLabels: Record<DepreciationMethod, string> = {
  'straight-line': 'The same amount every year',
  'reducing-balance': 'A share of what is left each year',
};

/**
 * A rate a year as a useful life in months, which is what an asset is given.
 * 25% is four years; 20% is five.
 */
export function lifeMonthsFromRate(ratePct: number): number | null {
  if (!(ratePct > 0) || ratePct > 100) return null;
  return Math.round((100 / ratePct) * 12);
}

export function rateFromLifeMonths(months: number): number | null {
  if (!(months > 0)) return null;
  return Math.round((1200 / months) * 1000) / 1000;
}

export function validateAssetCategory(draft: { name: string; ratePct: number }, existingNames: readonly string[], originalName?: string): Invalid[] {
  const problems: Invalid[] = [];
  const name = draft.name.trim();
  if (!name) problems.push({ field: 'name', message: 'A class of asset needs a name.' });
  if (name && existingNames.some((row) => row.toLowerCase() === name.toLowerCase()) && name !== originalName) {
    problems.push({ field: 'name', message: `There is already a class called ${name}.` });
  }
  if (!(draft.ratePct > 0) || draft.ratePct > 100) {
    problems.push({ field: 'ratePct', message: 'A depreciation rate is more than nil and no more than 100% a year.' });
  }
  return problems;
}

// --- tax rates ------------------------------------------------------------------------------

export type TaxRates = {
  vatPct: number;
  nhilPct: number;
  getFundPct: number;
  registrationThresholdMinor: number;
};

/** Ghana as it stands, and what an entity starts with. */
export const statutoryTaxRates: TaxRates = {
  vatPct: 15,
  nhilPct: 2.5,
  getFundPct: 2.5,
  registrationThresholdMinor: 750_000_00,
};

export function validateTaxRates(draft: TaxRates): Invalid[] {
  const problems: Invalid[] = [];
  for (const [field, value, label] of [
    ['vatPct', draft.vatPct, 'VAT'],
    ['nhilPct', draft.nhilPct, 'NHIL'],
    ['getFundPct', draft.getFundPct, 'GETFund'],
  ] as const) {
    if (!(value >= 0) || value > 100) problems.push({ field, message: `The ${label} rate is between nil and 100%.` });
  }
  if (!Number.isSafeInteger(draft.registrationThresholdMinor) || draft.registrationThresholdMinor < 0) {
    problems.push({ field: 'registrationThresholdMinor', message: 'The registration threshold cannot be negative.' });
  }
  return problems;
}

/** What changing a rate does, and — just as importantly — what it does not. */
export function taxRateEffect(before: TaxRates, after: TaxRates): string | null {
  const changed: string[] = [];
  if (before.vatPct !== after.vatPct) changed.push(`VAT from ${before.vatPct}% to ${after.vatPct}%`);
  if (before.nhilPct !== after.nhilPct) changed.push(`NHIL from ${before.nhilPct}% to ${after.nhilPct}%`);
  if (before.getFundPct !== after.getFundPct) changed.push(`GETFund from ${before.getFundPct}% to ${after.getFundPct}%`);
  if (before.registrationThresholdMinor !== after.registrationThresholdMinor) {
    changed.push(`the registration threshold from ${(before.registrationThresholdMinor / 100).toFixed(2)} to ${(after.registrationThresholdMinor / 100).toFixed(2)}`);
  }
  if (changed.length === 0) return null;
  return `This changes ${changed.join(', ')}. Anything already posted keeps the figures it was posted with — a posted journal is never recalculated. The new rates apply to what is worked out from here on, including drafts that have not been posted yet.`;
}

// --- entities -------------------------------------------------------------------------------

/**
 * An entity's type decides which chart of accounts it is given and which
 * screens it sees. Changing it once the books are running would leave the
 * accounts it has and the accounts its type expects out of step.
 */
export function canChangeEntityType(facts: { postings: number }): boolean {
  return facts.postings === 0;
}

export function validateEntity(draft: { name: string; financialYearEnd: string; tin: string }): Invalid[] {
  const problems: Invalid[] = [];
  if (!draft.name.trim()) problems.push({ field: 'name', message: 'A company needs a name.' });
  const yearEnd = draft.financialYearEnd.trim();
  if (yearEnd && !/^\d{1,2} [A-Z][a-z]{2}$/.test(yearEnd)) {
    problems.push({ field: 'financialYearEnd', message: 'Write the year end as a day and a short month, like "30 Sep".' });
  }
  if (draft.tin.trim().length > 40) problems.push({ field: 'tin', message: 'That TIN is too long.' });
  return problems;
}
