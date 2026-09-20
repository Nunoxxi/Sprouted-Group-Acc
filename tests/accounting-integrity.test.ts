import { describe, expect, it } from 'vitest';

import {
  balanceSheetBalances,
  intercompanyPairsNetToZero,
  journalEntriesBalance,
  ledgerBalancesPerEntity,
  trialBalanceNetsToZero,
  type IntercompanyTransactionLike,
} from '@/lib/accounting-integrity';
import { accountTypesMap, entityIds, ledgerLines } from '@/lib/report-data';

const accountTypes = accountTypesMap();

/**
 * Build the journal entries the app actually generates for one document and
 * assert each is balanced — this mirrors buildJournalEntries in the shell.
 */
function documentJournal(base: number, kind: 'sale' | 'purchase') {
  const vat = Math.round(base * 0.15);
  const nhil = Math.round(base * 0.025);
  const getFund = Math.round(base * 0.025);
  const total = base + vat + nhil + getFund;

  if (kind === 'sale') {
    return {
      entityId: 'sprouted-roots',
      lines: [
        { amount: total, type: 'debit' as const },
        { amount: base, type: 'credit' as const },
        { amount: vat, type: 'credit' as const },
        { amount: nhil, type: 'credit' as const },
        { amount: getFund, type: 'credit' as const },
      ],
    };
  }

  const wht = Math.round(total * 0.05);
  return {
    entityId: 'sprouted-roots',
    lines: [
      { amount: base, type: 'debit' as const },
      { amount: vat, type: 'debit' as const },
      { amount: nhil, type: 'debit' as const },
      { amount: getFund, type: 'debit' as const },
      { amount: total - wht, type: 'credit' as const },
      { amount: wht, type: 'credit' as const },
    ],
  };
}

describe('books always balance', () => {
  it('every generated document journal has debits equal to credits', () => {
    const journals = [
      documentJournal(1500000, 'sale'),
      documentJournal(2200000, 'sale'),
      documentJournal(1200000, 'purchase'),
      documentJournal(456000, 'purchase'),
    ];
    expect(journalEntriesBalance(journals)).toBe(true);
  });

  it('total debits equal total credits per entity across the whole ledger', () => {
    const result = ledgerBalancesPerEntity(ledgerLines, entityIds);
    for (const entityId of entityIds) {
      expect(result[entityId], `ledger out of balance for ${entityId}`).toBe(true);
    }
  });

  it('trial balance nets to zero for each entity', () => {
    for (const entityId of entityIds) {
      expect(trialBalanceNetsToZero(ledgerLines, entityId), `trial balance non-zero for ${entityId}`).toBe(true);
    }
  });

  it('the balance sheet balances per entity (assets = liabilities + equity)', () => {
    const result = balanceSheetBalances(ledgerLines, accountTypes, entityIds);
    for (const entityId of entityIds) {
      expect(result[entityId], `balance sheet out of balance for ${entityId}`).toBe(true);
    }
  });

  it('every intercompany pair nets to zero and posts to both entities', () => {
    const transactions: IntercompanyTransactionLike[] = [
      {
        reference: 'IC-2026-001',
        amount: 128400,
        fromEntityId: 'sprouted-roots',
        toEntityId: 'sprouted-crafts',
        journalEntries: [{ entityId: 'sprouted-roots' }, { entityId: 'sprouted-crafts' }],
      },
      {
        reference: 'IC-2026-002',
        amount: 68000,
        fromEntityId: 'sprouted-crafts',
        toEntityId: 'oikazi',
        journalEntries: [{ entityId: 'sprouted-crafts' }, { entityId: 'oikazi' }],
      },
    ];
    expect(intercompanyPairsNetToZero(transactions)).toBe(true);
  });

  it('rejects an intercompany transaction missing one side', () => {
    const broken: IntercompanyTransactionLike[] = [
      {
        reference: 'IC-2026-003',
        amount: 50000,
        fromEntityId: 'sprouted-roots',
        toEntityId: 'sprouted-crafts',
        journalEntries: [{ entityId: 'sprouted-roots' }], // mirror never posted
      },
    ];
    expect(intercompanyPairsNetToZero(broken)).toBe(false);
  });

  it('detects an out-of-balance journal entry', () => {
    const bad = [
      {
        entityId: 'sprouted-roots',
        lines: [
          { amount: 1000, type: 'debit' as const },
          { amount: 999, type: 'credit' as const },
        ],
      },
    ];
    expect(journalEntriesBalance(bad)).toBe(false);
  });
});
