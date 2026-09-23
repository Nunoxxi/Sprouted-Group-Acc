/**
 * The rules for editing a chart of accounts by hand.
 *
 * An account is not just a label: postings hang off it, and reports read it
 * through the ledger. So editing one is governed rather than free:
 *
 *  - A name can always be changed. A name is a label; nothing computes on it.
 *  - A type cannot be changed once anything has posted to it, because the
 *    trial balance, the profit and loss and the balance sheet all read the
 *    type, and changing it would silently reclassify history.
 *  - An account with postings is never deleted, only deactivated. One with
 *    nothing on it at all can go.
 *  - Some accounts the software itself posts to by code — the receivables
 *    control, the VAT accounts, deferred grant income, the accumulated fund.
 *    Those can be renamed, and nothing else: no new code, no deactivation, no
 *    merging away, no deletion. Break one and posting stops working.
 *
 * The protected list is not typed out here. It is read from the same
 * constants the posting logic uses, so a code the software depends on cannot
 * be left off it by accident.
 *
 * Pure: no I/O, no Prisma.
 */

import { assetAccounts } from './assets';
import { contractAccounts } from './contracts';
import { controlAccounts } from './documents';
import { fxAccounts } from './fx';
import { grantAccounts } from './grants';
import { momoAccounts } from './momo';
import { openingAccounts } from './opening';
import { liabilityAccounts, payrollAccounts } from './payroll';
import { tradingAccounts } from './trading';

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'COST_OF_SALES' | 'EXPENSE';

export const accountTypes: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'COST_OF_SALES', 'EXPENSE'];

export const accountTypeLabels: Record<AccountType, string> = {
  ASSET: 'Money and things we own',
  LIABILITY: 'Money we owe',
  EQUITY: 'Funds',
  INCOME: 'Money in',
  COST_OF_SALES: 'Direct costs',
  EXPENSE: 'Money out',
};

const looksLikeCode = (value: unknown): value is string => typeof value === 'string' && /^\d{3,6}$/.test(value);

/**
 * Every account code the application posts to by number. Assembled from the
 * posting logic's own constants, so it cannot fall out of step with them.
 */
export const protectedCodes: ReadonlySet<string> = new Set(
  [
    controlAccounts,
    fxAccounts,
    assetAccounts,
    grantAccounts,
    payrollAccounts,
    liabilityAccounts,
    momoAccounts,
    tradingAccounts,
    contractAccounts,
    openingAccounts,
  ].flatMap((group) => Object.values(group as Record<string, unknown>).filter(looksLikeCode)),
);

/** What the interface needs to know about one account before offering to edit it. */
export type AccountFacts = {
  code: string;
  type: AccountType;
  /** Postings on it. Anything above nil makes it permanent. */
  postings: number;
  /** Other rows pointing at it: bank accounts, items, budget lines, children. */
  references: number;
  isActive: boolean;
};

export type EditPermissions = {
  rename: boolean;
  changeCode: boolean;
  changeType: boolean;
  changeParent: boolean;
  deactivate: boolean;
  remove: boolean;
  mergeAway: boolean;
  /** Plain words for whatever is not allowed, to show beside the form. */
  reasons: string[];
};

/**
 * A fund account — the accumulated fund, a restricted fund balance — is
 * protected the same way a control account is. They are what the balance
 * sheet closes into.
 */
export function isProtected(facts: Pick<AccountFacts, 'code' | 'type'>): boolean {
  return protectedCodes.has(facts.code) || facts.type === 'EQUITY';
}

/**
 * What the person doing the editing is allowed to reach.
 *
 * `ownerPowers` is the line between correcting the chart and changing what
 * the accounts have already said. An Accountant adds an account and tidies
 * one nothing has posted to; touching an account with history behind it, or
 * taking one away, is the Owner's.
 */
export type Powers = { ownerPowers: boolean };

export function permissionsFor(facts: AccountFacts, powers: Powers = { ownerPowers: true }): EditPermissions {
  const locked = isProtected(facts);
  const posted = facts.postings > 0;
  const referenced = facts.references > 0;
  const owner = powers.ownerPowers;
  const reasons: string[] = [];

  if (locked) {
    reasons.push(
      facts.type === 'EQUITY'
        ? 'This is a fund account, which the balance sheet closes into. It can be renamed, but not renumbered, switched off or removed.'
        : 'The software posts to this account by its number — it is a control account. It can be renamed, but not renumbered, switched off or removed.',
    );
  }
  if (posted) {
    reasons.push(`${facts.postings} transaction${facts.postings === 1 ? '' : 's'} have been posted here, so it cannot be deleted or have its type changed. Switch it off instead and it will disappear from the lists while staying in the reports.`);
  }
  if (!posted && referenced) {
    reasons.push('Something else points at this account — a bank account, a stock item, a budget line or an account beneath it — so it cannot be deleted until that is changed.');
  }
  if (!owner && !locked) {
    reasons.push('Switching an account off, deleting one, merging two together, or renumbering one that already has transactions, is an Owner’s to do.');
  }

  return {
    rename: true,
    // Renumbering an account with history behind it changes what every closed
    // period reports, so it needs an Owner. An empty one is just a correction.
    changeCode: !locked && (owner || !posted),
    changeType: !posted,
    changeParent: !locked && (owner || !posted),
    deactivate: !locked && owner,
    remove: !locked && !posted && !referenced && owner,
    mergeAway: !locked && facts.isActive && owner,
    reasons,
  };
}

// --- validation ---------------------------------------------------------------------------

export type Invalid = { field: 'code' | 'name' | 'type' | 'parent'; message: string };

export type AccountDraft = {
  code: string;
  name: string;
  type: AccountType;
  category?: string | null;
  parentCode?: string | null;
};

/**
 * Check a new or edited account against the chart it is going into. `existing`
 * is every other account, so a clash or a loop is caught before it is written.
 */
export function validateAccount(
  draft: AccountDraft,
  existing: readonly { code: string; type: AccountType; parentCode?: string | null }[],
  original?: AccountFacts,
  powers: Powers = { ownerPowers: true },
): Invalid[] {
  const problems: Invalid[] = [];
  const code = draft.code.trim();
  const name = draft.name.trim();

  if (!/^[0-9]{3,6}$/.test(code)) {
    problems.push({ field: 'code', message: 'An account number is between three and six digits.' });
  }
  if (!name) {
    problems.push({ field: 'name', message: 'An account needs a name.' });
  }
  if (name.length > 120) {
    problems.push({ field: 'name', message: 'That name is too long; keep it under 120 characters.' });
  }
  if (!accountTypes.includes(draft.type)) {
    problems.push({ field: 'type', message: 'Choose what kind of account this is.' });
  }

  const clash = existing.find((row) => row.code === code && row.code !== original?.code);
  if (clash) {
    problems.push({ field: 'code', message: `${code} is already used by another account.` });
  }

  if (original) {
    const rules = permissionsFor(original, powers);
    if (code !== original.code && !rules.changeCode) {
      problems.push({
        field: 'code',
        message: isProtected(original)
          ? 'This account cannot be renumbered.'
          : 'This account already has transactions on it, so only an Owner can renumber it.',
      });
    }
    if (draft.type !== original.type && !rules.changeType) {
      problems.push({ field: 'type', message: 'This account already has transactions on it, so its kind cannot change — it would move history from one part of the accounts to another.' });
    }
  }

  const parent = draft.parentCode?.trim() || null;
  if (parent) {
    if (parent === code) {
      problems.push({ field: 'parent', message: 'An account cannot sit beneath itself.' });
    } else if (!existing.some((row) => row.code === parent)) {
      problems.push({ field: 'parent', message: `There is no account ${parent} to sit beneath.` });
    } else if (original && createsLoop(code, parent, existing)) {
      problems.push({ field: 'parent', message: 'That would put the account beneath one of its own children.' });
    } else {
      const above = existing.find((row) => row.code === parent);
      if (above && above.type !== draft.type) {
        problems.push({ field: 'parent', message: `Account ${parent} is a different kind of account, so this one cannot sit beneath it.` });
      }
    }
  }

  return problems;
}

function createsLoop(code: string, parentCode: string, existing: readonly { code: string; parentCode?: string | null }[]): boolean {
  const parentOf = new Map(existing.map((row) => [row.code, row.parentCode ?? null]));
  let walk: string | null = parentCode;
  const seen = new Set<string>();
  while (walk) {
    if (walk === code) return true;
    if (seen.has(walk)) return true;
    seen.add(walk);
    walk = parentOf.get(walk) ?? null;
  }
  return false;
}

// --- merging ------------------------------------------------------------------------------

export type MergeCheck = { ok: true } | { ok: false; error: string };

/**
 * Whether one account's transactions can be moved into another. A merge
 * rewrites which account history sits on, so it is only allowed between
 * accounts of the same kind — otherwise it would reclassify the past, which
 * is the thing the type rule above exists to prevent.
 */
export function canMerge(from: AccountFacts, into: AccountFacts): MergeCheck {
  if (from.code === into.code) return { ok: false, error: 'Choose a different account to merge into.' };
  if (isProtected(from)) return { ok: false, error: 'That account is one the software posts to by number, so it cannot be merged away.' };
  if (from.type !== into.type) {
    return { ok: false, error: `${from.code} and ${into.code} are different kinds of account. Merging them would move history from one part of the accounts to another.` };
  }
  if (!into.isActive) return { ok: false, error: 'The account being merged into is switched off. Switch it on first.' };
  return { ok: true };
}

// --- what a change will do to reports -------------------------------------------------------

/**
 * The warning shown before saving. It says what will change in the reports, in
 * plain words, so nobody discovers it afterwards.
 */
export function historicEffect(before: AccountFacts, draft: AccountDraft): string | null {
  if (before.postings === 0) return null;
  const notes: string[] = [];
  if (draft.code.trim() !== before.code) {
    notes.push(`every report that shows account ${before.code} will show ${draft.code.trim()} instead, including reports for periods already closed`);
  }
  if (draft.type !== before.type) {
    notes.push(`${before.postings} posted transaction${before.postings === 1 ? '' : 's'} would move from ${accountTypeLabels[before.type]} to ${accountTypeLabels[draft.type]}`);
  }
  if (notes.length === 0) return null;
  return `This account carries history: ${notes.join(', and ')}.`;
}

/** The same, for a merge. */
export function mergeEffect(from: AccountFacts, into: AccountFacts): string {
  return `${from.postings} posted transaction${from.postings === 1 ? '' : 's'} will move from ${from.code} to ${into.code}, and ${from.code} will be switched off. Reports for periods already closed will show the new account. The transactions themselves — their dates, their amounts and their journals — do not change.`;
}

// --- ordering -----------------------------------------------------------------------------

/** Sort by the order given, falling back to the account number. */
export function sortAccounts<T extends { code: string; sortOrder: number }>(accounts: readonly T[]): T[] {
  return [...accounts].sort((a, b) => (a.sortOrder - b.sortOrder) || a.code.localeCompare(b.code, 'en'));
}

/** Renumber a list into 10, 20, 30 … so a later insert has room between them. */
export function reorderedPositions(codesInOrder: readonly string[]): { code: string; sortOrder: number }[] {
  return codesInOrder.map((code, index) => ({ code, sortOrder: (index + 1) * 10 }));
}

// --- import and export ----------------------------------------------------------------------

export type ImportedRow = { code: string; name: string; type: AccountType; category: string | null; parentCode: string | null };
export type ImportOutcome = {
  rows: ImportedRow[];
  /** Lines that could not be read, with the reason, so nothing fails silently. */
  rejected: { line: number; raw: string; reason: string }[];
};

const headerAliases: Record<string, keyof ImportedRow> = {
  code: 'code', 'account code': 'code', 'account no': 'code', number: 'code',
  name: 'name', 'account name': 'name', description: 'name',
  type: 'type', 'account type': 'type',
  'sub-group': 'category', 'sub group': 'category', subgroup: 'category', group: 'category', category: 'category',
  parent: 'parentCode', 'parent account': 'parentCode', 'parent code': 'parentCode',
};

const typeAliases: Record<string, AccountType> = {
  asset: 'ASSET', assets: 'ASSET', 'current asset': 'ASSET', 'fixed asset': 'ASSET',
  liability: 'LIABILITY', liabilities: 'LIABILITY',
  equity: 'EQUITY', fund: 'EQUITY', funds: 'EQUITY', 'net assets': 'EQUITY',
  income: 'INCOME', revenue: 'INCOME',
  'cost of sales': 'COST_OF_SALES', cos: 'COST_OF_SALES', 'direct costs': 'COST_OF_SALES',
  expense: 'EXPENSE', expenses: 'EXPENSE', overhead: 'EXPENSE',
};

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells.map((value) => value.trim());
}

/**
 * Read a chart out of a spreadsheet saved as CSV. The header row names the
 * columns; anything it cannot read is handed back with its line number rather
 * than dropped.
 */
export function parseChartCsv(csv: string): ImportOutcome {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim() !== '');
  const rows: ImportedRow[] = [];
  const rejected: ImportOutcome['rejected'] = [];
  if (lines.length === 0) return { rows, rejected };

  const header = splitCsvLine(lines[0]).map((cell) => cell.toLowerCase());
  const columns = header.map((cell) => headerAliases[cell] ?? null);
  if (!columns.includes('code') || !columns.includes('name')) {
    return { rows, rejected: [{ line: 1, raw: lines[0], reason: 'The first row has to name the columns, and must include a code and a name.' }] };
  }

  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const pick = (field: keyof ImportedRow): string => {
      const at = columns.indexOf(field);
      return at >= 0 ? (cells[at] ?? '') : '';
    };
    const code = pick('code');
    const name = pick('name');
    const rawType = pick('type').toLowerCase();
    if (!code && !name) continue;
    if (!/^[0-9]{3,6}$/.test(code)) {
      rejected.push({ line: i + 1, raw: lines[i], reason: `"${code}" is not an account number of three to six digits.` });
      continue;
    }
    if (!name) {
      rejected.push({ line: i + 1, raw: lines[i], reason: 'No account name.' });
      continue;
    }
    const type = typeAliases[rawType];
    if (!type) {
      rejected.push({ line: i + 1, raw: lines[i], reason: rawType ? `"${pick('type')}" is not a kind of account.` : 'No account type.' });
      continue;
    }
    rows.push({ code, name, type, category: pick('category') || null, parentCode: pick('parentCode') || null });
  }
  return { rows, rejected };
}

/** The chart as CSV, in the order it is shown. */
export function chartToCsv(accounts: readonly { code: string; name: string; type: string; category: string | null; parentCode: string | null; isActive: boolean }[]): string {
  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const header = 'Code,Name,Type,Sub-group,Parent,Active';
  const body = accounts.map((row) =>
    [row.code, row.name, row.type, row.category ?? '', row.parentCode ?? '', row.isActive ? 'yes' : 'no'].map((cell) => escape(String(cell))).join(','),
  );
  return [header, ...body].join('\n');
}
