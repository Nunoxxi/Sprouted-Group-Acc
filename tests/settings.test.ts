/**
 * The Settings rules: projects and their budgets, funds, asset classes and
 * the tax rates. The point of most of them is that a change made here cannot
 * quietly restate something already reported.
 */

import { describe, expect, it } from 'vitest';

import {
  budgetTotals,
  canChangeEntityType,
  canCloseProject,
  canDeleteProject,
  canReopenProject,
  compareBudget,
  currentBudget,
  fundClassificationEffect,
  lifeMonthsFromRate,
  rateFromLifeMonths,
  revisionEffect,
  statutoryTaxRates,
  taxRateEffect,
  validateAssetCategory,
  validateBudgetLine,
  validateTaxRates,
  validateEntity,
  validateFund,
  validateProject,
  type BudgetLine,
} from '@/lib/settings';

const fieldsOf = (rates: typeof statutoryTaxRates): string[] => validateTaxRates(rates).map((problem) => problem.field);

const line = (over: Partial<BudgetLine> = {}): BudgetLine => ({
  id: 'b1',
  name: 'Training',
  originalMinor: 100_000,
  revisedMinor: null,
  ...over,
});

describe('projects', () => {
  const draft = { code: 'PROJ-HRC', name: 'Human Rights', kind: 'grant-funded' as const, currency: 'GHS' as const, fundingMinor: 500_000 };

  it('accepts a sound project', () => {
    expect(validateProject(draft, [])).toEqual([]);
  });

  it('needs a code and a name', () => {
    expect(validateProject({ ...draft, code: '  ' }, []).some((p) => p.field === 'code')).toBe(true);
    expect(validateProject({ ...draft, name: '' }, []).some((p) => p.field === 'name')).toBe(true);
  });

  it('refuses a code another project already uses', () => {
    expect(validateProject(draft, ['PROJ-HRC']).some((p) => p.message.includes('already used'))).toBe(true);
  });

  it('lets a project keep its own code while being edited', () => {
    expect(validateProject(draft, ['PROJ-HRC'], 'PROJ-HRC')).toEqual([]);
  });

  it('refuses a negative award', () => {
    expect(validateProject({ ...draft, fundingMinor: -1 }, []).some((p) => p.field === 'fundingMinor')).toBe(true);
  });

  it('refuses an end before the start', () => {
    const problems = validateProject({ ...draft, startDate: '2026-10-01', endDate: '2026-09-30' }, []);
    expect(problems.some((p) => p.field === 'endDate' && p.message.includes('before it starts'))).toBe(true);
  });

  it('refuses a date that is not a date', () => {
    expect(validateProject({ ...draft, startDate: '2026-13-45' }, []).some((p) => p.field === 'startDate')).toBe(true);
  });

  it('closes and reopens, but not twice', () => {
    expect(canCloseProject({ closed: false })).toEqual({ ok: true });
    expect(canCloseProject({ closed: true }).ok).toBe(false);
    expect(canReopenProject({ closed: true })).toEqual({ ok: true });
    expect(canReopenProject({ closed: false }).ok).toBe(false);
  });

  it('cannot be deleted once anything is coded to it, and says to close it instead', () => {
    const result = canDeleteProject({ postings: 4, documentLines: 0, grants: 0, budgetLines: 0 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Close it instead');
  });

  it('can be deleted while nothing points at it', () => {
    expect(canDeleteProject({ postings: 0, documentLines: 0, grants: 0, budgetLines: 2 })).toEqual({ ok: true });
  });
});

describe('budget lines: what was agreed, and what it stands at now', () => {
  it('an unrevised line stands at its original', () => {
    expect(currentBudget(line())).toBe(100_000);
  });

  it('a revised line stands at the revision, and keeps the original', () => {
    const revised = line({ revisedMinor: 150_000 });
    expect(currentBudget(revised)).toBe(150_000);
    expect(revised.originalMinor).toBe(100_000);
  });

  it('compares the two side by side with the movement', () => {
    const rows = compareBudget([line(), line({ id: 'b2', name: 'Travel', originalMinor: 50_000, revisedMinor: 30_000 })]);
    expect(rows[0]).toEqual({ name: 'Training', originalMinor: 100_000, currentMinor: 100_000, movementMinor: 0, revised: false });
    expect(rows[1]).toEqual({ name: 'Travel', originalMinor: 50_000, currentMinor: 30_000, movementMinor: -20_000, revised: true });
  });

  it('totals both, so a report can show the budget as agreed and as revised', () => {
    const totals = budgetTotals([line(), line({ id: 'b2', originalMinor: 50_000, revisedMinor: 80_000 })]);
    expect(totals).toEqual({ originalMinor: 150_000, currentMinor: 180_000, movementMinor: 30_000, revisedLines: 1 });
  });

  it('an empty budget totals to nil rather than breaking', () => {
    expect(budgetTotals([])).toEqual({ originalMinor: 0, currentMinor: 0, movementMinor: 0, revisedLines: 0 });
  });

  it('refuses a nameless or negative line', () => {
    expect(validateBudgetLine({ name: ' ', amountMinor: 100 }).some((p) => p.field === 'name')).toBe(true);
    expect(validateBudgetLine({ name: 'Training', amountMinor: -1 }).some((p) => p.field === 'amountMinor')).toBe(true);
  });

  it('says what a revision does, and that the original is kept', () => {
    const note = revisionEffect(line(), 150_000);
    expect(note).toContain('raises');
    expect(note).toContain('1000.00');
    expect(note).toContain('1500.00');
    expect(note).toContain('first agreed is kept');
  });

  it('says when a revision replaces an earlier one', () => {
    expect(revisionEffect(line({ revisedMinor: 120_000 }), 90_000)).toContain('replaces the previous revision');
  });
});

describe('funds', () => {
  it('needs a code and a name, and refuses a duplicate', () => {
    expect(validateFund({ code: '', name: 'X' }, []).some((p) => p.field === 'code')).toBe(true);
    expect(validateFund({ code: 'F1', name: '' }, []).some((p) => p.field === 'name')).toBe(true);
    expect(validateFund({ code: 'F1', name: 'X' }, ['F1']).some((p) => p.message.includes('already used'))).toBe(true);
  });

  it('warns before moving money between the restricted and unrestricted columns', () => {
    const note = fundClassificationEffect('restricted', 'unrestricted', 12);
    expect(note).toContain('12 transactions');
    expect(note).toContain('already closed');
  });

  it('says nothing when the classification is unchanged, or nothing has gone through it', () => {
    expect(fundClassificationEffect('restricted', 'restricted', 12)).toBeNull();
    expect(fundClassificationEffect('restricted', 'unrestricted', 0)).toBeNull();
  });
});

describe('fixed asset classes', () => {
  it('turns a rate a year into a useful life, the way the audited rates read', () => {
    expect(lifeMonthsFromRate(25)).toBe(48);
    expect(lifeMonthsFromRate(20)).toBe(60);
  });

  it('and back again', () => {
    expect(rateFromLifeMonths(48)).toBe(25);
    expect(rateFromLifeMonths(60)).toBe(20);
  });

  it('refuses a rate that is not a rate', () => {
    expect(lifeMonthsFromRate(0)).toBeNull();
    expect(lifeMonthsFromRate(-5)).toBeNull();
    expect(lifeMonthsFromRate(120)).toBeNull();
    expect(rateFromLifeMonths(0)).toBeNull();
  });

  it('needs a name and a sensible rate', () => {
    expect(validateAssetCategory({ name: '', ratePct: 25 }, []).some((p) => p.field === 'name')).toBe(true);
    expect(validateAssetCategory({ name: 'Computers', ratePct: 0 }, []).some((p) => p.field === 'ratePct')).toBe(true);
    expect(validateAssetCategory({ name: 'Computers', ratePct: 25 }, [])).toEqual([]);
  });

  it('refuses a name another class already has, whatever the capitals', () => {
    expect(validateAssetCategory({ name: 'computers', ratePct: 25 }, ['Computers']).some((p) => p.field === 'name')).toBe(true);
  });
});

describe('tax rates', () => {
  it('starts at the Ghanaian rates', () => {
    expect(statutoryTaxRates).toEqual({ vatPct: 15, nhilPct: 2.5, getFundPct: 2.5, registrationThresholdMinor: 75_000_000 });
  });

  it('refuses a rate outside nil to a hundred', () => {
    expect(fieldsOf({ ...statutoryTaxRates, vatPct: -1 })).toContain('vatPct');
    expect(fieldsOf({ ...statutoryTaxRates, nhilPct: 101 })).toContain('nhilPct');
  });

  it('accepts the statutory rates unchanged', () => {
    expect(fieldsOf(statutoryTaxRates)).toEqual([]);
  });

  it('says what changing a rate does, and that posted journals are untouched', () => {
    const note = taxRateEffect(statutoryTaxRates, { ...statutoryTaxRates, vatPct: 17.5 });
    expect(note).toContain('VAT from 15% to 17.5%');
    expect(note).toContain('never recalculated');
  });

  it('says nothing when nothing changed', () => {
    expect(taxRateEffect(statutoryTaxRates, statutoryTaxRates)).toBeNull();
  });
});

describe('entities', () => {
  it('the type is fixed once the books are running', () => {
    expect(canChangeEntityType({ postings: 0 })).toBe(true);
    expect(canChangeEntityType({ postings: 1 })).toBe(false);
  });

  it('needs a name, and a year end written as a day and a short month', () => {
    expect(validateEntity({ name: '', financialYearEnd: '30 Sep', tin: '' }).some((p) => p.field === 'name')).toBe(true);
    expect(validateEntity({ name: 'X', financialYearEnd: 'September', tin: '' }).some((p) => p.field === 'financialYearEnd')).toBe(true);
    expect(validateEntity({ name: 'X', financialYearEnd: '30 Sep', tin: 'GH-1' })).toEqual([]);
    expect(validateEntity({ name: 'X', financialYearEnd: '', tin: '' })).toEqual([]);
  });
});
