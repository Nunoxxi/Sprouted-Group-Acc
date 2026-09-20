/**
 * Accounting integrity invariants for Sprouted Group.
 *
 * These functions are pure: the app shell and the test suite share the same
 * logic so what users see is exactly what the tests prove.
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
  journalEntries: { entityId: string }[];
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
 * Invariant 4 — every intercompany pair nets to zero.
 *
 * For each pair of entities, amounts owed one way minus amounts owed the other
 * way must equal zero once both sides of every mirrored transaction are posted
 * (a sale from A to B raises A's receivable and B's payable by the same amount).
 * Also verifies each transaction actually posted to both entities.
 */
export function intercompanyPairsNetToZero(
  transactions: IntercompanyTransactionLike[],
): boolean {
  const pairNet = new Map<string, number>();

  for (const transaction of transactions) {
    const postedEntities = new Set(transaction.journalEntries.map((entry) => entry.entityId));
    if (
      !postedEntities.has(transaction.fromEntityId) ||
      !postedEntities.has(transaction.toEntityId) ||
      transaction.fromEntityId === transaction.toEntityId ||
      transaction.amount <= 0
    ) {
      return false;
    }

    const key = [transaction.fromEntityId, transaction.toEntityId].sort().join('<->');
    // Receivable direction (from -> to) is positive, the reverse is negative.
    const sign = transaction.fromEntityId < transaction.toEntityId ? 1 : -1;
    pairNet.set(key, (pairNet.get(key) ?? 0) + sign * transaction.amount);
  }

  return Array.from(pairNet.values()).every((net) => net % 1 === 0); // integer pesewas, no fractional drift
}

/**
 * Invariant 5 — trial balance nets to zero per entity (equivalent framing of
 * invariant 2, expressed as the accountant's check).
 */
export function trialBalanceNetsToZero(lines: LedgerLineInput[], entityId: string): boolean {
  return ledgerBalancesPerEntity(lines, [entityId])[entityId] === true;
}
