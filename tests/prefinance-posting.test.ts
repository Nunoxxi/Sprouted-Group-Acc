/**
 * Pre-finance postings.
 *
 * Every entry has to sum to nil, and the accounts have to be the ones the
 * chart actually contains. Beyond that, the cases worth stating in words are
 * the three ways a delivery can end and the two ways a bad advance can.
 */

import { describe, expect, it } from 'vitest';

import { preFinanceAccounts as preFinanceTemplates } from '@/lib/account-templates';
import { protectedCodes } from '@/lib/chart-edit';
import {
  advanceJournal,
  advanceWriteOffJournal,
  deliveryJournal,
  interestAccrualJournal,
  interestPaidJournal,
  isBalanced,
  preFinanceAccounts,
  provisionMovementJournal,
  shortfallCollectedJournal,
  trancheDrawnJournal,
  trancheRepaidJournal,
  type PreFinanceJournalLine,
} from '@/lib/prefinance-posting';

const names: Record<string, string> = {};
const BANK = '1001';
const INVENTORY = '1030';
const PAYABLES = '2001';

const total = (lines: readonly PreFinanceJournalLine[], type: 'debit' | 'credit'): number =>
  lines.filter((line) => line.type === type).reduce((sum, line) => sum + line.amount, 0);

const amountOn = (lines: readonly PreFinanceJournalLine[], code: string, type: 'debit' | 'credit'): number =>
  lines.filter((line) => line.accountCode === code && line.type === type).reduce((sum, line) => sum + line.amount, 0);

describe('the accounts exist in the chart the software seeds', () => {
  it('every code the posting logic names is in the manufacturing template', () => {
    const seeded = new Set(preFinanceTemplates.map((account) => account.code));
    for (const code of Object.values(preFinanceAccounts)) {
      expect(seeded.has(code), `${code} is posted to but never seeded`).toBe(true);
    }
  });

  it('and every one of them is protected from being renamed away or deleted', () => {
    for (const code of Object.values(preFinanceAccounts)) {
      expect(protectedCodes.has(code), `${code} can be edited out from under the posting logic`).toBe(true);
    }
  });
});

describe('borrowing', () => {
  it('a drawdown fills the bank and raises the debt', () => {
    const lines = trancheDrawnJournal(5_000_000_00, BANK, names);
    expect(isBalanced(lines)).toBe(true);
    expect(amountOn(lines, BANK, 'debit')).toBe(5_000_000_00);
    expect(amountOn(lines, preFinanceAccounts.loan, 'credit')).toBe(5_000_000_00);
  });

  it('a repayment reverses it', () => {
    const lines = trancheRepaidJournal(1_000_000_00, BANK, names);
    expect(isBalanced(lines)).toBe(true);
    expect(amountOn(lines, preFinanceAccounts.loan, 'debit')).toBe(1_000_000_00);
  });

  it('interest is a cost when it accrues, not when it is paid', () => {
    const accrued = interestAccrualJournal(45_000_00, names);
    expect(isBalanced(accrued)).toBe(true);
    expect(amountOn(accrued, preFinanceAccounts.interest, 'debit')).toBe(45_000_00);
    expect(amountOn(accrued, preFinanceAccounts.accruedInterest, 'credit')).toBe(45_000_00);

    // Paying it later touches no expense account: the cost was taken already.
    const paid = interestPaidJournal(45_000_00, BANK, names);
    expect(isBalanced(paid)).toBe(true);
    expect(amountOn(paid, preFinanceAccounts.interest, 'debit')).toBe(0);
    expect(amountOn(paid, preFinanceAccounts.accruedInterest, 'debit')).toBe(45_000_00);
  });

  it('nothing is posted for a nil or negative amount', () => {
    expect(trancheDrawnJournal(0, BANK, names)).toHaveLength(0);
    expect(interestAccrualJournal(-1, names)).toHaveLength(0);
  });
});

describe('advancing', () => {
  it('money to an aggregator is a receivable, not a cost and not stock', () => {
    const lines = advanceJournal(50_000_00, BANK, names);
    expect(isBalanced(lines)).toBe(true);
    expect(amountOn(lines, preFinanceAccounts.advances, 'debit')).toBe(50_000_00);
    expect(amountOn(lines, BANK, 'credit')).toBe(50_000_00);
    expect(lines.some((line) => line.accountCode.startsWith('5'))).toBe(false);
  });
});

describe('a load arriving against an advance', () => {
  it('brings stock in at what was settled, not at what was advanced', () => {
    const lines = deliveryJournal(
      {
        settledValueMinor: 47_000_00,
        advanceOutstandingMinor: 50_000_00,
        outcome: 'carry-forward',
        inventoryCode: INVENTORY,
        payableCode: PAYABLES,
      },
      names,
    );
    expect(isBalanced(lines)).toBe(true);
    expect(amountOn(lines, INVENTORY, 'debit')).toBe(47_000_00);
    // The other GHS 3,000 is still owed by the aggregator.
    expect(amountOn(lines, preFinanceAccounts.advances, 'credit')).toBe(47_000_00);
    expect(amountOn(lines, preFinanceAccounts.qualityVariance, 'debit')).toBe(0);
  });

  it('charges the shortfall to the season when it is squared off instead', () => {
    const lines = deliveryJournal(
      {
        settledValueMinor: 47_000_00,
        advanceOutstandingMinor: 50_000_00,
        outcome: 'square',
        inventoryCode: INVENTORY,
        payableCode: PAYABLES,
      },
      names,
    );
    expect(isBalanced(lines)).toBe(true);
    expect(amountOn(lines, INVENTORY, 'debit')).toBe(47_000_00);
    expect(amountOn(lines, preFinanceAccounts.qualityVariance, 'debit')).toBe(3_000_00);
    // The advance is cleared in full: nothing is still owed.
    expect(amountOn(lines, preFinanceAccounts.advances, 'credit')).toBe(50_000_00);
  });

  it('owes the aggregator the difference when the load beat the basis', () => {
    const lines = deliveryJournal(
      {
        settledValueMinor: 52_000_00,
        advanceOutstandingMinor: 50_000_00,
        outcome: 'pay-top-up',
        inventoryCode: INVENTORY,
        payableCode: PAYABLES,
      },
      names,
    );
    expect(isBalanced(lines)).toBe(true);
    expect(amountOn(lines, INVENTORY, 'debit')).toBe(52_000_00);
    expect(amountOn(lines, preFinanceAccounts.advances, 'credit')).toBe(50_000_00);
    expect(amountOn(lines, PAYABLES, 'credit')).toBe(2_000_00);
  });

  it('settles several loads against one advance without over-clearing it', () => {
    const first = deliveryJournal(
      { settledValueMinor: 20_000_00, advanceOutstandingMinor: 50_000_00, outcome: 'carry-forward', inventoryCode: INVENTORY, payableCode: PAYABLES },
      names,
    );
    const second = deliveryJournal(
      { settledValueMinor: 35_000_00, advanceOutstandingMinor: 30_000_00, outcome: 'pay-top-up', inventoryCode: INVENTORY, payableCode: PAYABLES },
      names,
    );
    expect(isBalanced(first)).toBe(true);
    expect(isBalanced(second)).toBe(true);
    // 20,000 then 30,000 clears the 50,000 exactly; the extra 5,000 is owed.
    expect(amountOn(first, preFinanceAccounts.advances, 'credit')).toBe(20_000_00);
    expect(amountOn(second, preFinanceAccounts.advances, 'credit')).toBe(30_000_00);
    expect(amountOn(second, PAYABLES, 'credit')).toBe(5_000_00);
  });

  it('a shortfall collected in cash clears the rest of the advance', () => {
    const lines = shortfallCollectedJournal(3_000_00, BANK, names);
    expect(isBalanced(lines)).toBe(true);
    expect(amountOn(lines, BANK, 'debit')).toBe(3_000_00);
    expect(amountOn(lines, preFinanceAccounts.advances, 'credit')).toBe(3_000_00);
  });
});

describe('providing against advances that have gone quiet', () => {
  it('posts the movement, so running it twice does not charge twice', () => {
    const first = provisionMovementJournal(10_000_00, 0, names);
    expect(amountOn(first, preFinanceAccounts.provisionCharge, 'debit')).toBe(10_000_00);

    const again = provisionMovementJournal(10_000_00, 10_000_00, names);
    expect(again).toHaveLength(0);
  });

  it('reverses when the required provision falls', () => {
    const lines = provisionMovementJournal(4_000_00, 10_000_00, names);
    expect(isBalanced(lines)).toBe(true);
    expect(amountOn(lines, preFinanceAccounts.advanceProvision, 'debit')).toBe(6_000_00);
    expect(amountOn(lines, preFinanceAccounts.provisionCharge, 'credit')).toBe(6_000_00);
  });
});

describe('writing an advance off', () => {
  it('uses what was already provided before charging anything new', () => {
    const lines = advanceWriteOffJournal(10_000_00, 10_000_00, names);
    expect(isBalanced(lines)).toBe(true);
    expect(amountOn(lines, preFinanceAccounts.advanceProvision, 'debit')).toBe(10_000_00);
    // Nothing fresh: the loss was taken when it looked doubtful.
    expect(amountOn(lines, preFinanceAccounts.qualityVariance, 'debit')).toBe(0);
  });

  it('charges only the part no provision covered', () => {
    const lines = advanceWriteOffJournal(10_000_00, 4_000_00, names);
    expect(isBalanced(lines)).toBe(true);
    expect(amountOn(lines, preFinanceAccounts.advanceProvision, 'debit')).toBe(4_000_00);
    expect(amountOn(lines, preFinanceAccounts.qualityVariance, 'debit')).toBe(6_000_00);
    expect(amountOn(lines, preFinanceAccounts.advances, 'credit')).toBe(10_000_00);
  });

  it('never charges more than the advance, however much was provided', () => {
    const lines = advanceWriteOffJournal(10_000_00, 25_000_00, names);
    expect(isBalanced(lines)).toBe(true);
    expect(total(lines, 'debit')).toBe(10_000_00);
  });
});
