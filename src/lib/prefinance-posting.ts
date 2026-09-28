/**
 * Turning pre-finance events into balanced journal entries.
 *
 * The arithmetic is in src/lib/prefinance.ts; this file only says which
 * accounts each result lands on. Kept apart because the two change for
 * different reasons: the sums change when terms change, the accounts change
 * when the chart does.
 *
 * The shape of the money, in the order it happens:
 *
 *   draw      bank up, Pre-Finance Loan up          — borrowed, not earned
 *   advance   Aggregator Advances up, bank down     — owed to us, nothing held
 *   deliver   inventory up, Aggregator Advances down — the nuts arrive
 *   accrue    Pre-Finance Interest up, Accrued Loan Interest up
 *   repay     Pre-Finance Loan down, bank down
 *
 * A delivery rarely lands exactly on the advance, which is the whole reason
 * quality terms exist. Three endings are possible and each is a different
 * entry: the balance carries forward against the next load, the shortfall is
 * written off as a cost of the season, or the load was worth more and the
 * difference is owed back to the aggregator.
 *
 * Pure: no I/O, no Prisma. Every function returns lines that sum to nil.
 */

import type { SettlementOutcome } from './prefinance';

export const preFinanceAccounts = {
  /** Cash out to an aggregator: a receivable with nothing held as security. */
  advances: '1075',
  /** Contra-asset. Sits against 1075 so the gross and the provision both show. */
  advanceProvision: '1076',
  /** Principal drawn and not yet repaid. */
  loan: '2080',
  /** Interest accrued and not yet paid. */
  accruedInterest: '2085',
  /** A shortfall accepted rather than carried forward or collected. */
  qualityVariance: '5065',
  /** The charge that creates the provision on 1076. */
  provisionCharge: '5070',
  /** Interest as a cost of the season. */
  interest: '8010',
  /**
   * Where delivered nuts land. Already in the manufacturing chart; named here
   * because this is now a code the software posts to by number, which is what
   * makes an account protected from being renumbered or switched off.
   */
  rawMaterials: '1030',
} as const;

export type PreFinanceJournalLine = {
  accountCode: string;
  accountName: string;
  amount: number;
  type: 'debit' | 'credit';
};

const nameOf = (names: Record<string, string>, code: string, fallback: string): string => names[code] ?? fallback;

const debit = (names: Record<string, string>, code: string, fallback: string, amount: number): PreFinanceJournalLine => ({
  accountCode: code,
  accountName: nameOf(names, code, fallback),
  amount,
  type: 'debit',
});

const credit = (names: Record<string, string>, code: string, fallback: string, amount: number): PreFinanceJournalLine => ({
  accountCode: code,
  accountName: nameOf(names, code, fallback),
  amount,
  type: 'credit',
});

// --- borrowing ----------------------------------------------------------------------------------

/** A tranche drawn down: the bank account fills, and the debt with it. */
export function trancheDrawnJournal(
  amountMinor: number,
  bankCode: string,
  names: Record<string, string>,
): PreFinanceJournalLine[] {
  if (amountMinor <= 0) return [];
  return [
    debit(names, bankCode, 'Bank', amountMinor),
    credit(names, preFinanceAccounts.loan, 'Pre-Finance Loan', amountMinor),
  ];
}

/** Principal repaid. Interest is a separate entry, because it is a separate cost. */
export function trancheRepaidJournal(
  amountMinor: number,
  bankCode: string,
  names: Record<string, string>,
): PreFinanceJournalLine[] {
  if (amountMinor <= 0) return [];
  return [
    debit(names, preFinanceAccounts.loan, 'Pre-Finance Loan', amountMinor),
    credit(names, bankCode, 'Bank', amountMinor),
  ];
}

/**
 * Interest for a period, charged before it is paid.
 *
 * Accrued rather than recognised on payment so that a cycle carries the
 * financing it actually consumed — the whole point of measuring margin per
 * cycle is spoilt if the interest lands in whichever month the lender happens
 * to collect.
 */
export function interestAccrualJournal(amountMinor: number, names: Record<string, string>): PreFinanceJournalLine[] {
  if (amountMinor <= 0) return [];
  return [
    debit(names, preFinanceAccounts.interest, 'Pre-Finance Interest', amountMinor),
    credit(names, preFinanceAccounts.accruedInterest, 'Accrued Loan Interest', amountMinor),
  ];
}

/** Interest actually paid, clearing what was accrued. */
export function interestPaidJournal(
  amountMinor: number,
  bankCode: string,
  names: Record<string, string>,
): PreFinanceJournalLine[] {
  if (amountMinor <= 0) return [];
  return [
    debit(names, preFinanceAccounts.accruedInterest, 'Accrued Loan Interest', amountMinor),
    credit(names, bankCode, 'Bank', amountMinor),
  ];
}

// --- advancing and delivering -------------------------------------------------------------------

/** Money to an aggregator. Not a cost, and not stock: a debt owed to us. */
export function advanceJournal(
  amountMinor: number,
  bankCode: string,
  names: Record<string, string>,
): PreFinanceJournalLine[] {
  if (amountMinor <= 0) return [];
  return [
    debit(names, preFinanceAccounts.advances, 'Aggregator Advances', amountMinor),
    credit(names, bankCode, 'Bank', amountMinor),
  ];
}

/**
 * A load arriving against an advance.
 *
 * Stock comes in at what was actually settled, never at what was advanced.
 * Paying GHS 50,000 for nuts worth GHS 47,000 does not make them worth
 * GHS 50,000, and carrying them in at the advance would overstate inventory
 * and understate the problem.
 *
 * `outcome` decides what happens to the difference:
 *
 *  - `carry-forward` — the aggregator still owes it; 1075 keeps the balance
 *  - `square` — accepted and charged to the season, which is what the quality
 *    variance account is for
 *  - `pay-top-up` — the load beat the basis and is worth more than the
 *    advance; the extra is owed to the aggregator
 *  - `collect-shortfall` — cash coming back is a separate receipt, so here it
 *    behaves as carry-forward until the money arrives
 */
export function deliveryJournal(
  input: {
    settledValueMinor: number;
    /** What is still outstanding on the advance before this load. */
    advanceOutstandingMinor: number;
    outcome: SettlementOutcome;
    inventoryCode: string;
    /** Where a top-up would be paid from, or owed to. */
    payableCode: string;
  },
  names: Record<string, string>,
): PreFinanceJournalLine[] {
  const { settledValueMinor, advanceOutstandingMinor, outcome, inventoryCode, payableCode } = input;
  if (settledValueMinor <= 0) return [];

  const clearedFromAdvance = Math.min(settledValueMinor, advanceOutstandingMinor);
  const lines: PreFinanceJournalLine[] = [
    debit(names, inventoryCode, 'Raw Material Inventory', settledValueMinor),
    credit(names, preFinanceAccounts.advances, 'Aggregator Advances', clearedFromAdvance),
  ];

  // Worth more than was advanced. However the outcome is described, the money
  // is owed to the aggregator until it is paid, so it goes to payables either
  // way; the outcome only decides how quickly it leaves.
  const owedBack = settledValueMinor - clearedFromAdvance;
  if (owedBack > 0) {
    lines.push(credit(names, payableCode, 'Trade Payables', owedBack));
  }

  // Worth less, and the shortfall is being accepted rather than chased.
  if (outcome === 'square') {
    const shortfall = advanceOutstandingMinor - clearedFromAdvance;
    if (shortfall > 0) {
      lines.push(debit(names, preFinanceAccounts.qualityVariance, 'Quality Settlement Variance', shortfall));
      lines.push(credit(names, preFinanceAccounts.advances, 'Aggregator Advances', shortfall));
    }
  }

  return lines;
}

/** A shortfall collected in cash rather than carried or written off. */
export function shortfallCollectedJournal(
  amountMinor: number,
  bankCode: string,
  names: Record<string, string>,
): PreFinanceJournalLine[] {
  if (amountMinor <= 0) return [];
  return [
    debit(names, bankCode, 'Bank', amountMinor),
    credit(names, preFinanceAccounts.advances, 'Aggregator Advances', amountMinor),
  ];
}

// --- what an old advance is worth ----------------------------------------------------------------

/**
 * Providing against advances that have aged past the threshold.
 *
 * Posted as the movement to the required provision rather than the provision
 * itself, so running it twice in a month does not double the charge. A fall in
 * the required figure reverses, which is why the lines flip rather than being
 * refused.
 */
export function provisionMovementJournal(
  requiredMinor: number,
  alreadyProvidedMinor: number,
  names: Record<string, string>,
): PreFinanceJournalLine[] {
  const movement = requiredMinor - alreadyProvidedMinor;
  if (movement === 0) return [];
  if (movement > 0) {
    return [
      debit(names, preFinanceAccounts.provisionCharge, 'Aggregator Advance Provision', movement),
      credit(names, preFinanceAccounts.advanceProvision, 'Provision against Aggregator Advances', movement),
    ];
  }
  return [
    debit(names, preFinanceAccounts.advanceProvision, 'Provision against Aggregator Advances', -movement),
    credit(names, preFinanceAccounts.provisionCharge, 'Aggregator Advance Provision', -movement),
  ];
}

/**
 * Writing an advance off for good.
 *
 * Whatever was already provided against it is used first, and only the
 * uncovered remainder is a fresh cost — otherwise the same loss would be
 * charged twice, once when it looked doubtful and again when it was certain.
 */
export function advanceWriteOffJournal(
  amountMinor: number,
  providedMinor: number,
  names: Record<string, string>,
): PreFinanceJournalLine[] {
  if (amountMinor <= 0) return [];
  const covered = Math.min(providedMinor, amountMinor);
  const uncovered = amountMinor - covered;
  const lines: PreFinanceJournalLine[] = [];
  if (covered > 0) {
    lines.push(debit(names, preFinanceAccounts.advanceProvision, 'Provision against Aggregator Advances', covered));
  }
  if (uncovered > 0) {
    lines.push(debit(names, preFinanceAccounts.qualityVariance, 'Quality Settlement Variance', uncovered));
  }
  lines.push(credit(names, preFinanceAccounts.advances, 'Aggregator Advances', amountMinor));
  return lines;
}

/** Every line sums to nil, which is the one thing that must never be wrong. */
export function isBalanced(lines: readonly PreFinanceJournalLine[]): boolean {
  const debits = lines.filter((line) => line.type === 'debit').reduce((sum, line) => sum + line.amount, 0);
  const credits = lines.filter((line) => line.type === 'credit').reduce((sum, line) => sum + line.amount, 0);
  return debits === credits;
}
