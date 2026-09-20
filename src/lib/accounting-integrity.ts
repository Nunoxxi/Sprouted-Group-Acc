/**
 * Accounting integrity invariants for Sprouted Group.
 *
 * These functions are pure and are exercised by the test suite. The statutory
 * tax rule they lean on lives in ghana-tax.ts, which the app shell also uses,
 * so the figures under test are the figures users see.
 */

export type AccountClass = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'COST_OF_SALES' | 'EXPENSE';

export interface LedgerLineInput {
  entityId: string;
  accountCode: string;
  amount: number; // pesewas, debit positive / credit negative
}

export interface JournalLike {
  entityId: string;
  lines: { amount: number; type: 'debit' | 'credit' }[];
}

export interface IntercompanyTransactionLike {
  reference: string;
  amount: number;
  fromEntityId: string;
  toEntityId: string;
  journalEntries: {
    entityId: string;
    side: { amount: number; type: 'debit' | 'credit' }[];
  }[];
}

/**
 * Invariant 1 — every journal entry is balanced: sum of debits equals sum of credits.
 */
export function journalEntriesBalance(entries: JournalLike[]): boolean {
  return entries.every((entry) => {
    const debits = entry.lines
      .filter((line) => line.type === 'debit')
      .reduce((total, line) => total + line.amount, 0);
    const credits = entry.lines
      .filter((line) => line.type === 'credit')
      .reduce((total, line) => total + line.amount, 0);
    return debits === credits;
  });
}

/**
 * Invariant 2 — per entity, total debits equal total credits across the whole ledger.
 */
export function ledgerBalancesPerEntity(
  lines: LedgerLineInput[],
  entityIds: string[],
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const entityId of entityIds) {
    const total = lines
      .filter((line) => line.entityId === entityId)
      .reduce((sum, line) => sum + line.amount, 0);
    result[entityId] = total === 0;
  }
  return result;
}

/**
 * Invariant 3 — the balance sheet balances per entity:
 * assets = liabilities + equity, where equity includes the accumulated
 * income-statement result (income less cost of sales and expenses).
 */
export function balanceSheetBalances(
  lines: LedgerLineInput[],
  accountTypes: Record<string, AccountClass>,
  entityIds: string[],
): Record<string, boolean> {
  const result: Record<string, boolean> = {};

  for (const entityId of entityIds) {
    const entityLines = lines.filter((line) => line.entityId === entityId);
    const sumOf = (type: AccountClass) =>
      entityLines
        .filter((line) => accountTypes[line.accountCode] === type)
        .reduce((sum, line) => sum + line.amount, 0);

    const assets = sumOf('ASSET');
    const liabilities = -sumOf('LIABILITY');
    const equityAccounts = -sumOf('EQUITY');
    const accumulatedResult = -(sumOf('INCOME') + sumOf('COST_OF_SALES') + sumOf('EXPENSE'));

    result[entityId] = assets - liabilities - equityAccounts - accumulatedResult === 0;
  }

  return result;
}

/**
 * Invariant 4 — every intercompany transaction is mirrored faithfully.
 *
 * A trade between two group entities is posted twice: the seller raises a
 * receivable, the buyer raises a payable. For the group to consolidate, those
 * two postings must describe the same trade — both entities posted, each side
 * internally balanced, and each side moving exactly the transaction amount.
 *
 * Note this is deliberately NOT a check that the pair balance is zero. An
 * unreciprocated sale from A to B is perfectly normal and leaves A owed money;
 * what must never happen is the two sides disagreeing about how much.
 */
export function intercompanyMirrorsMatch(
  transactions: IntercompanyTransactionLike[],
): boolean {
  return transactions.every((transaction) => {
    if (transaction.fromEntityId === transaction.toEntityId || transaction.amount <= 0) {
      return false;
    }

    const sides = new Map(transaction.journalEntries.map((entry) => [entry.entityId, entry.side]));
    const sellerSide = sides.get(transaction.fromEntityId);
    const buyerSide = sides.get(transaction.toEntityId);

    if (!sellerSide || !buyerSide || sides.size !== 2) {
      return false;
    }

    return [sellerSide, buyerSide].every((side) => {
      const debits = side
        .filter((line) => line.type === 'debit')
        .reduce((total, line) => total + line.amount, 0);
      const credits = side
        .filter((line) => line.type === 'credit')
        .reduce((total, line) => total + line.amount, 0);

      // Balanced in itself, and moving the amount the transaction claims.
      return debits === credits && debits === transaction.amount;
    });
  });
}

/**
 * Invariant 5 — trial balance nets to zero per entity (equivalent framing of
 * invariant 2, expressed as the accountant's check).
 */
export function trialBalanceNetsToZero(lines: LedgerLineInput[], entityId: string): boolean {
  return ledgerBalancesPerEntity(lines, [entityId])[entityId] === true;
}
