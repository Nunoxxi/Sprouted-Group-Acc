/**
 * Editing the chart of accounts by hand: what may be changed, what may not,
 * and why. The rules exist to stop somebody reclassifying history or breaking
 * an account the software posts to by number.
 */

import { describe, expect, it } from 'vitest';

import { controlAccounts } from '@/lib/documents';
import { fxAccounts } from '@/lib/fx';
import {
  canMerge,
  chartToCsv,
  historicEffect,
  isProtected,
  mergeEffect,
  parseChartCsv,
  permissionsFor,
  protectedCodes,
  reorderedPositions,
  sortAccounts,
  validateAccount,
  type AccountFacts,
} from '@/lib/chart-edit';

const facts = (over: Partial<AccountFacts> = {}): AccountFacts => ({
  code: '7050',
  type: 'EXPENSE',
  postings: 0,
  references: 0,
  isActive: true,
  ...over,
});

describe('which accounts the software depends on', () => {
  it('knows the ones it posts to by number', () => {
    expect(protectedCodes.has(controlAccounts.receivables)).toBe(true);
    expect(protectedCodes.has(controlAccounts.vatOutput)).toBe(true);
    expect(protectedCodes.has(fxAccounts.gain)).toBe(true);
    expect(protectedCodes.has(fxAccounts.loss)).toBe(true);
  });

  it('leaves an ordinary expense account alone', () => {
    expect(protectedCodes.has('7050')).toBe(false);
    expect(isProtected({ code: '7050', type: 'EXPENSE' })).toBe(false);
  });

  it('protects every fund account, because the balance sheet closes into it', () => {
    expect(isProtected({ code: '3001', type: 'EQUITY' })).toBe(true);
    expect(isProtected({ code: '3020', type: 'EQUITY' })).toBe(true);
  });
});

describe('what may be changed', () => {
  it('a fresh account can be changed in every way', () => {
    const rules = permissionsFor(facts());
    expect(rules).toMatchObject({ rename: true, changeCode: true, changeType: true, deactivate: true, remove: true, mergeAway: true });
    expect(rules.reasons).toEqual([]);
  });

  it('renaming is always allowed, whatever else is true', () => {
    for (const f of [facts(), facts({ postings: 40 }), facts({ code: controlAccounts.receivables, type: 'ASSET' }), facts({ type: 'EQUITY' })]) {
      expect(permissionsFor(f).rename).toBe(true);
    }
  });

  it('once anything has posted, the type is fixed and it cannot be deleted', () => {
    const rules = permissionsFor(facts({ postings: 1 }));
    expect(rules.changeType).toBe(false);
    expect(rules.remove).toBe(false);
    expect(rules.deactivate).toBe(true);
    expect(rules.reasons.join(' ')).toContain('1 transaction');
  });

  it('a control account can be renamed and nothing else', () => {
    const rules = permissionsFor(facts({ code: controlAccounts.receivables, type: 'ASSET' }));
    expect(rules).toMatchObject({ rename: true, changeCode: false, deactivate: false, remove: false, mergeAway: false });
    expect(rules.reasons.join(' ')).toContain('control account');
  });

  it('an account nothing has posted to but something points at cannot be deleted', () => {
    const rules = permissionsFor(facts({ references: 1 }));
    expect(rules.remove).toBe(false);
    expect(rules.reasons.join(' ')).toContain('points at this account');
  });
});

describe('what an Accountant may do, as against an Owner', () => {
  const asAccountant = { ownerPowers: false };

  it('can add and rename freely', () => {
    expect(validateAccount({ code: '7060', name: 'Cleaning', type: 'EXPENSE' }, [], undefined, asAccountant)).toEqual([]);
    expect(permissionsFor(facts({ postings: 12 }), asAccountant).rename).toBe(true);
  });

  it('can correct an account nothing has posted to', () => {
    const rules = permissionsFor(facts({ postings: 0 }), asAccountant);
    expect(rules.changeCode).toBe(true);
    expect(rules.changeType).toBe(true);
    expect(rules.changeParent).toBe(true);
  });

  it('cannot switch one off, delete one or merge one away', () => {
    const rules = permissionsFor(facts({ postings: 0 }), asAccountant);
    expect(rules).toMatchObject({ deactivate: false, remove: false, mergeAway: false });
    expect(rules.reasons.join(' ')).toContain('Owner');
  });

  it('cannot renumber an account that already carries history', () => {
    const rules = permissionsFor(facts({ postings: 3 }), asAccountant);
    expect(rules.changeCode).toBe(false);
    const problems = validateAccount({ code: '7099', name: 'Cleaning', type: 'EXPENSE' }, [{ code: '7050', type: 'EXPENSE', parentCode: null }], facts({ code: '7050', postings: 3 }), asAccountant);
    expect(problems.some((p) => p.field === 'code' && p.message.includes('Owner'))).toBe(true);
  });

  it('an Owner can do all of that', () => {
    const rules = permissionsFor(facts({ postings: 3 }));
    expect(rules).toMatchObject({ changeCode: true, deactivate: true, mergeAway: true });
  });

  it('neither of them can touch a control account beyond its name', () => {
    for (const powers of [{ ownerPowers: true }, { ownerPowers: false }]) {
      const rules = permissionsFor(facts({ code: controlAccounts.receivables, type: 'ASSET' }), powers);
      expect(rules).toMatchObject({ rename: true, changeCode: false, deactivate: false, remove: false });
    }
  });
});

describe('validating an account', () => {
  const chart = [
    { code: '1001', type: 'ASSET' as const, parentCode: null },
    { code: '7050', type: 'EXPENSE' as const, parentCode: null },
    { code: '7055', type: 'EXPENSE' as const, parentCode: '7050' },
  ];

  it('accepts a sound new account', () => {
    expect(validateAccount({ code: '7060', name: 'Cleaning', type: 'EXPENSE' }, chart)).toEqual([]);
  });

  it('refuses a number that is not three to six digits', () => {
    expect(validateAccount({ code: '70', name: 'X', type: 'EXPENSE' }, chart)[0].field).toBe('code');
    expect(validateAccount({ code: '70A5', name: 'X', type: 'EXPENSE' }, chart)[0].field).toBe('code');
  });

  it('refuses a number already in use', () => {
    const problems = validateAccount({ code: '7050', name: 'Something else', type: 'EXPENSE' }, chart);
    expect(problems.some((p) => p.message.includes('already used'))).toBe(true);
  });

  it('refuses an empty name', () => {
    expect(validateAccount({ code: '7060', name: '   ', type: 'EXPENSE' }, chart).some((p) => p.field === 'name')).toBe(true);
  });

  it('refuses a type change once posted, and says why in plain words', () => {
    const problems = validateAccount({ code: '7050', name: 'Cleaning', type: 'ASSET' }, chart, facts({ code: '7050', postings: 3 }));
    expect(problems[0].field).toBe('type');
    expect(problems[0].message).toContain('history');
  });

  it('allows a type change while nothing has posted', () => {
    expect(validateAccount({ code: '7050', name: 'Cleaning', type: 'ASSET' }, chart, facts({ code: '7050', postings: 0 }))).toEqual([]);
  });

  it('refuses renumbering a control account', () => {
    const original = facts({ code: controlAccounts.receivables, type: 'ASSET' });
    const problems = validateAccount({ code: '1099', name: 'Receivables', type: 'ASSET' }, [{ code: controlAccounts.receivables, type: 'ASSET', parentCode: null }], original);
    expect(problems.some((p) => p.field === 'code')).toBe(true);
  });

  it('refuses an account that sits beneath itself, or beneath its own child', () => {
    expect(validateAccount({ code: '7050', name: 'X', type: 'EXPENSE', parentCode: '7050' }, chart, facts({ code: '7050' })).some((p) => p.field === 'parent')).toBe(true);
    expect(validateAccount({ code: '7050', name: 'X', type: 'EXPENSE', parentCode: '7055' }, chart, facts({ code: '7050' })).some((p) => p.field === 'parent')).toBe(true);
  });

  it('refuses a parent that does not exist, or is a different kind of account', () => {
    expect(validateAccount({ code: '7060', name: 'X', type: 'EXPENSE', parentCode: '9999' }, chart).some((p) => p.field === 'parent')).toBe(true);
    expect(validateAccount({ code: '7060', name: 'X', type: 'EXPENSE', parentCode: '1001' }, chart).some((p) => p.field === 'parent')).toBe(true);
  });
});

describe('merging one account into another', () => {
  it('allows two ordinary accounts of the same kind', () => {
    expect(canMerge(facts({ code: '7050', postings: 4 }), facts({ code: '7055' }))).toEqual({ ok: true });
  });

  it('refuses different kinds, because it would move history between reports', () => {
    const result = canMerge(facts({ code: '7050' }), facts({ code: '1001', type: 'ASSET' }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('different kinds');
  });

  it('refuses merging a control account away', () => {
    const result = canMerge(facts({ code: controlAccounts.receivables, type: 'ASSET' }), facts({ code: '1099', type: 'ASSET' }));
    expect(result.ok).toBe(false);
  });

  it('refuses merging into a switched-off account', () => {
    expect(canMerge(facts({ code: '7050' }), facts({ code: '7055', isActive: false })).ok).toBe(false);
  });

  it('refuses merging an account into itself', () => {
    expect(canMerge(facts({ code: '7050' }), facts({ code: '7050' })).ok).toBe(false);
  });

  it('says what a merge will do before it happens', () => {
    const note = mergeEffect(facts({ code: '7050', postings: 4 }), facts({ code: '7055' }));
    expect(note).toContain('4 posted transactions will move from 7050 to 7055');
    expect(note).toContain('do not change');
  });
});

describe('warning before a change that reaches the reports', () => {
  it('says nothing when the account is empty', () => {
    expect(historicEffect(facts(), { code: '7060', name: 'X', type: 'ASSET' })).toBeNull();
  });

  it('names what moves when the type changes under history', () => {
    const note = historicEffect(facts({ postings: 9 }), { code: '7050', name: 'X', type: 'ASSET' });
    expect(note).toContain('9 posted transactions');
    expect(note).toContain('Money out');
  });

  it('warns that closed periods will show the new number', () => {
    const note = historicEffect(facts({ postings: 2 }), { code: '7099', name: 'X', type: 'EXPENSE' });
    expect(note).toContain('already closed');
  });

  it('says nothing when only the name changed', () => {
    expect(historicEffect(facts({ postings: 2 }), { code: '7050', name: 'A better name', type: 'EXPENSE' })).toBeNull();
  });
});

describe('ordering', () => {
  it('falls back to the account number when nothing has been ordered', () => {
    const rows = sortAccounts([
      { code: '7050', sortOrder: 0 },
      { code: '1001', sortOrder: 0 },
      { code: '2001', sortOrder: 0 },
    ]);
    expect(rows.map((r) => r.code)).toEqual(['1001', '2001', '7050']);
  });

  it('puts an ordered account where it was put', () => {
    const rows = sortAccounts([
      { code: '1001', sortOrder: 20 },
      { code: '7050', sortOrder: 10 },
    ]);
    expect(rows.map((r) => r.code)).toEqual(['7050', '1001']);
  });

  it('renumbers in tens, so there is room to insert later', () => {
    expect(reorderedPositions(['1001', '2001', '7050'])).toEqual([
      { code: '1001', sortOrder: 10 },
      { code: '2001', sortOrder: 20 },
      { code: '7050', sortOrder: 30 },
    ]);
  });
});

describe('importing a chart from a spreadsheet', () => {
  it('reads codes, names, types, sub-groups and parents', () => {
    const { rows, rejected } = parseChartCsv('Code,Name,Type,Sub-group,Parent\n1001,Bank,Asset,Current Assets,\n7050,General Expenses,Expense,,7000\n');
    expect(rejected).toEqual([]);
    expect(rows).toEqual([
      { code: '1001', name: 'Bank', type: 'ASSET', category: 'Current Assets', parentCode: null },
      { code: '7050', name: 'General Expenses', type: 'EXPENSE', category: null, parentCode: '7000' },
    ]);
  });

  it('accepts the words an accountant actually writes', () => {
    const { rows } = parseChartCsv('Account No,Account Name,Account Type\n3001,Accumulated Fund,Net Assets\n5001,Training,Direct Costs\n');
    expect(rows.map((r) => r.type)).toEqual(['EQUITY', 'COST_OF_SALES']);
  });

  it('hands back what it could not read, with the line number', () => {
    const { rows, rejected } = parseChartCsv('Code,Name,Type\n1001,Bank,Asset\nXX,Broken,Asset\n1002,,Asset\n1003,No type,\n');
    expect(rows).toHaveLength(1);
    expect(rejected.map((r) => r.line)).toEqual([3, 4, 5]);
    expect(rejected[0].reason).toContain('not an account number');
    expect(rejected[1].reason).toContain('No account name');
    expect(rejected[2].reason).toContain('No account type');
  });

  it('refuses a file with no header naming the columns', () => {
    const { rejected } = parseChartCsv('1001,Bank,Asset\n');
    expect(rejected[0].reason).toContain('name the columns');
  });

  it('copes with quoted names holding commas', () => {
    const { rows } = parseChartCsv('Code,Name,Type\n7050,"Repairs, maintenance and cleaning",Expense\n');
    expect(rows[0].name).toBe('Repairs, maintenance and cleaning');
  });

  it('reads back what it wrote', () => {
    const csv = chartToCsv([
      { code: '7050', name: 'Repairs, maintenance', type: 'EXPENSE', category: null, parentCode: null, isActive: true },
    ]);
    expect(csv.split('\n')[0]).toBe('Code,Name,Type,Sub-group,Parent,Active');
    expect(parseChartCsv(csv).rows[0]).toMatchObject({ code: '7050', name: 'Repairs, maintenance', type: 'EXPENSE' });
  });
});
