/**
 * Opening balances: the trial balance must balance in functional currency
 * before it posts; control accounts are redirected to suspense; detail
 * imports post against suspense; the checklist refuses go-live while
 * suspense is not zero. Pure.
 */

import { describe, expect, it } from 'vitest';

import { checkTrialBalance, controlFigure, detailJournal, goLiveChecklist, openingAccounts, trialBalanceJournal, type TrialBalanceRow } from '@/lib/opening';

const chart = new Set(['1001', '1002', '1010', '1030', '1060', '1070', '2001', '3001', '3005', '3090']);
const names = { '1001': 'Cash', '1002': 'USD bank', '1010': 'Trade Receivables', '1030': 'Raw Materials Inventory', '2001': 'Trade Payables', '3001': 'Share Capital', '3005': 'Retained Earnings', '3090': 'Opening Balance Suspense' };
const row = (r: number, accountCode: string, amountMinor: number, currency: 'GHS' | 'USD' = 'GHS', rate = '1.0'): TrialBalanceRow => ({ row: r, accountCode, currency, amountMinor, rate, note: '' });

describe('the trial balance', () => {
  it('balances in functional currency, converting foreign balances at the cut-over rate', () => {
    const check = checkTrialBalance(
      [row(2, '1001', 100_000_00), row(3, '1002', 10_000_00, 'USD', '12.5'), row(4, '1010', 50_000_00), row(5, '1030', 80_000_00), row(6, '2001', -30_000_00), row(7, '3001', -200_000_00), row(8, '3005', -125_000_00)],
      chart,
      'GHS',
    );
    expect(check.errors).toEqual([]);
    expect(check.functionalRows[1]).toMatchObject({ accountCode: '1002', amountMinor: 125_000_00, currency: 'USD', txnAmountMinor: 10_000_00, rate: '12.5' });
    expect(check.debitsMinor).toBe(355_000_00);
    expect(check.creditsMinor).toBe(355_000_00);
    expect(check.balances).toBe(true);
  });

  it('refuses an unbalanced trial balance, a foreign row without a rate, an unknown code, and the suspense account itself', () => {
    const check = checkTrialBalance([row(2, '1001', 100_00), row(3, '1002', 10_00, 'USD', '1.0'), row(4, '9999', -50_00), row(5, '3090', -70_00)], chart, 'GHS');
    expect(check.balances).toBe(false);
    expect(check.errors.map((e) => e.row)).toEqual([3, 4, 5]);
  });

  it('posts every account at its balance except the controls, which go to suspense', () => {
    const check = checkTrialBalance([row(2, '1001', 100_000_00), row(3, '1010', 50_000_00), row(4, '1030', 80_000_00), row(5, '2001', -30_000_00), row(6, '3005', -200_000_00)], chart, 'GHS');
    const lines = trialBalanceJournal(check.functionalRows, new Set(['1010', '1030', '2001', '1060', '1070']), names);
    expect(lines.map((l) => [l.accountCode, l.type, l.amount])).toEqual([['1001', 'debit', 100_000_00], ['3005', 'credit', 200_000_00], ['3090', 'debit', 100_000_00]]);
    // suspense = 50,000 + 80,000 − 30,000: the net of the controls, so the journal balances.
    expect(lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0)).toBe(lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0));
    expect(controlFigure(check.functionalRows, new Set(['1010']))).toBe(50_000_00);
    expect(controlFigure(check.functionalRows, new Set(['2001']))).toBe(-30_000_00);
  });
});

describe('detail imports', () => {
  it('post to the control account against suspense, the right way round', () => {
    expect(detailJournal('1010', 12_000_00, true, names).map((l) => [l.accountCode, l.type])).toEqual([['1010', 'debit'], ['3090', 'credit']]);
    expect(detailJournal('2001', 5_000_00, false, names).map((l) => [l.accountCode, l.type])).toEqual([['3090', 'debit'], ['2001', 'credit']]);
    expect(detailJournal('1010', 0, true, names)).toEqual([]);
  });

  it('suspense nets to zero exactly when the detail equals the trial balance', () => {
    // TB: receivables 50,000 → suspense debit 50,000. Two invoices 30,000 + 20,000 → suspense credit 50,000.
    let suspense = 50_000_00;
    for (const amount of [30_000_00, 20_000_00]) for (const l of detailJournal('1010', amount, true, names)) if (l.accountCode === openingAccounts.suspense) suspense += l.type === 'debit' ? l.amount : -l.amount;
    expect(suspense).toBe(0);
    // One invoice short by 5,000 leaves 5,000 in suspense — visible, never absorbed.
    let short = 50_000_00;
    for (const l of detailJournal('1010', 45_000_00, true, names)) if (l.accountCode === openingAccounts.suspense) short += l.type === 'debit' ? l.amount : -l.amount;
    expect(short).toBe(5_000_00);
  });
});

describe('the go-live checklist', () => {
  const base = {
    cutOverDate: '2026-10-01', liveAt: null, trialBalancePosted: true, trialBalanceBalances: true,
    controls: [{ label: 'Receivables', trialBalanceMinor: 50_000_00, detailMinor: 50_000_00, differenceMinor: 0, reconciles: true }],
    suspenseMinor: 0, foreignRowsWithoutRate: 0, contractsPosted: false, contractsCount: 0,
  };

  it('ticks each item as it reconciles and allows go-live only when suspense is zero', () => {
    const ok = goLiveChecklist(base);
    expect(ok.items.every((i) => i.done)).toBe(true);
    expect(ok.canGoLive).toBe(true);
    const bad = goLiveChecklist({ ...base, controls: [{ label: 'Receivables', trialBalanceMinor: 50_000_00, detailMinor: 45_000_00, differenceMinor: 5_000_00, reconciles: false }], suspenseMinor: 5_000_00 });
    expect(bad.items.find((i) => i.key === 'Receivables')?.done).toBe(false);
    expect(bad.items.find((i) => i.key === 'suspense')).toMatchObject({ done: false, detail: '5000.00 in suspense — the detail does not match the trial balance.' });
    expect(bad.canGoLive).toBe(false);
  });

  it('contracts are optional; an entity already live cannot go live again', () => {
    expect(goLiveChecklist({ ...base, contractsCount: 0, contractsPosted: false }).canGoLive).toBe(true);
    expect(goLiveChecklist({ ...base, liveAt: '2026-10-01T00:00:00Z' }).canGoLive).toBe(false);
    expect(goLiveChecklist({ ...base, cutOverDate: null }).canGoLive).toBe(false);
  });
});
