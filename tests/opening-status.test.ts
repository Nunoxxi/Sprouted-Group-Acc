/**
 * The opening-balance reconciliation read from the ledger: each control's
 * trial-balance figure against what its account holds, and the suspense
 * balance. The database is a fake that honours the filters the reader uses,
 * so this pins the figures, not the number of queries.
 */
import { describe, expect, it, vi } from 'vitest';

type Line = { accountId: string; direction: 'MONEY_IN' | 'MONEY_OUT'; amountMinor: bigint };

const accounts = [
  { id: 'a-recv', entityId: 'e1', code: '1010', category: 'receivables' },
  { id: 'a-pay', entityId: 'e1', code: '2001', category: 'payables' },
  { id: 'a-float', entityId: 'e1', code: '1060', category: 'floats' },
  { id: 'a-susp', entityId: 'e1', code: '3090', category: 'equity' },
  { id: 'a-stock1', entityId: 'e1', code: '1200', category: 'inventory' },
  { id: 'a-stock2', entityId: 'e1', code: '1201', category: 'inventory' },
  { id: 'a-sales', entityId: 'e1', code: '4000', category: 'income' },
  // Another entity's receivables: must never be counted.
  { id: 'b-recv', entityId: 'e2', code: '1010', category: 'receivables' },
];

const lines: Line[] = [
  { accountId: 'a-recv', direction: 'MONEY_IN', amountMinor: 5000n },
  { accountId: 'a-recv', direction: 'MONEY_OUT', amountMinor: 1000n },
  { accountId: 'a-pay', direction: 'MONEY_OUT', amountMinor: 3000n },
  { accountId: 'a-susp', direction: 'MONEY_OUT', amountMinor: 4000n },
  { accountId: 'a-susp', direction: 'MONEY_IN', amountMinor: 200n },
  { accountId: 'a-stock1', direction: 'MONEY_IN', amountMinor: 2500n },
  { accountId: 'a-stock2', direction: 'MONEY_IN', amountMinor: 500n },
  { accountId: 'a-stock2', direction: 'MONEY_OUT', amountMinor: 200n },
  { accountId: 'a-sales', direction: 'MONEY_OUT', amountMinor: 9999n },
  { accountId: 'b-recv', direction: 'MONEY_IN', amountMinor: 777n },
];

const trialBalanceRows = [
  { accountCode: '1010', functionalMinor: 4000 },
  { accountCode: '2001', functionalMinor: -3000 },
  { accountCode: '1200', functionalMinor: 2000 },
  { accountCode: '1201', functionalMinor: 800 },
  // Farmer advances in the trial balance with no detail behind them.
  { accountCode: '1070', functionalMinor: 700 },
];

type AccountWhere = { entityId: string; OR?: ({ code: { in: string[] } } | { category: string })[]; code?: { in: string[] }; category?: string };
const matches = (a: (typeof accounts)[number], where: AccountWhere) => {
  const one = (w: { code?: { in: string[] }; category?: string }) => (!w.code || w.code.in.includes(a.code)) && (w.category === undefined || w.category === a.category);
  return a.entityId === where.entityId && one(where) && (!where.OR || where.OR.some(one));
};

const prismaFake = {
  entity: { findUniqueOrThrow: async () => ({ id: 'e1', cutOverDate: new Date('2026-01-01T00:00:00Z'), liveAt: null }) },
  openingBatch: {
    findMany: async () => [
      {
        id: 'tb',
        section: 'TRIAL_BALANCE',
        status: 'POSTED',
        fileName: 'tb.xlsx',
        rowCount: trialBalanceRows.length,
        postedAt: new Date('2026-01-02T00:00:00Z'),
        createdAt: new Date('2026-01-02T00:00:00Z'),
        createdBy: { name: 'Ama' },
        journalEntry: { id: 'j' },
        rowsJson: JSON.stringify(trialBalanceRows),
      },
    ],
  },
  account: {
    findMany: async ({ where }: { where: AccountWhere }) => accounts.filter((a) => matches(a, where)),
  },
  journalLine: {
    groupBy: async ({ by, where }: { by: ('accountId' | 'direction')[]; where: { accountId: { in: string[] } } }) => {
      const groups = new Map<string, { accountId: string; direction: string; _sum: { amountMinor: bigint } }>();
      for (const line of lines.filter((l) => where.accountId.in.includes(l.accountId))) {
        const key = by.map((k) => line[k]).join('|');
        const group = groups.get(key) ?? { accountId: line.accountId, direction: line.direction, _sum: { amountMinor: 0n } };
        group._sum.amountMinor += line.amountMinor;
        groups.set(key, group);
      }
      return [...groups.values()];
    },
  },
  salesContract: { count: async () => 2 },
};

vi.mock('@/lib/prisma', () => ({ prisma: prismaFake }));

const { openingStatus } = await import('@/lib/data/opening');

describe('openingStatus', () => {
  it('reconciles each control against its account, and reads suspense from the ledger', async () => {
    const status = await openingStatus('e1');
    expect(status.controls).toEqual([
      { label: 'Receivables', trialBalanceMinor: 4000, detailMinor: 4000, differenceMinor: 0, reconciles: true },
      { label: 'Payables', trialBalanceMinor: -3000, detailMinor: -3000, differenceMinor: 0, reconciles: true },
      { label: 'Stock', trialBalanceMinor: 2800, detailMinor: 2800, differenceMinor: 0, reconciles: true },
      { label: 'Farmer advances', trialBalanceMinor: 700, detailMinor: 0, differenceMinor: 700, reconciles: false },
    ]);
    expect(status.suspenseMinor).toBe(-3800);
    expect(status.trialBalancePosted).toBe(true);
    expect(status.contractsCount).toBe(2);
    expect(status.cutOverDate).toBe('2026-01-01');
    expect(status.batches).toHaveLength(1);
  });
});
