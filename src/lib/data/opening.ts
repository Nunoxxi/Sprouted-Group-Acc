/**
 * Opening-balance readers: the uploaded batches, the control
 * reconciliations, and the suspense balance — all from the ledger and the
 * detail the imports wrote, never from a stored summary.
 */

import type { JournalEntry, OpeningBatch, OpeningSection as PrismaOpeningSection, User } from '@prisma/client';

import { inventoryAccountCategory } from '../inventory';
import { openingAccounts, type ControlReconciliation, type OpeningSection } from '../opening';
import { prisma } from '../prisma';
import { toMinor } from './money';
import type { OpeningBatchRecord, OpeningStatusRecord } from './types';

const sectionToRecord: Record<PrismaOpeningSection, OpeningSection> = {
  TRIAL_BALANCE: 'trial-balance',
  INVOICES: 'invoices',
  BILLS: 'bills',
  STOCK: 'stock',
  FLOATS: 'floats',
  FARMER_ADVANCES: 'farmer-advances',
  CONTRACTS: 'contracts',
};
export const sectionToPrisma: Record<OpeningSection, PrismaOpeningSection> = {
  'trial-balance': 'TRIAL_BALANCE',
  invoices: 'INVOICES',
  bills: 'BILLS',
  stock: 'STOCK',
  floats: 'FLOATS',
  'farmer-advances': 'FARMER_ADVANCES',
  contracts: 'CONTRACTS',
};

export function batchRecord(row: OpeningBatch & { createdBy: Pick<User, 'name'> | null; journalEntry: Pick<JournalEntry, 'id'> | null }): OpeningBatchRecord {
  return {
    id: row.id,
    section: sectionToRecord[row.section],
    fileName: row.fileName,
    rowCount: row.rowCount,
    status: row.status === 'POSTED' ? 'posted' : 'draft',
    postedAt: row.postedAt ? row.postedAt.toISOString() : null,
    createdByName: row.createdBy?.name ?? '',
    createdAt: row.createdAt.toISOString(),
    rows: JSON.parse(row.rowsJson) as unknown[],
  };
}

export const batchInclude = { createdBy: { select: { name: true } }, journalEntry: { select: { id: true } } } as const;

/** Balance of one account from the journal lines: money in less money out. */
async function balanceOf(entityId: string, codes: string[]): Promise<number> {
  if (codes.length === 0) return 0;
  const accounts = await prisma.account.findMany({ where: { entityId, code: { in: codes } }, select: { id: true } });
  if (accounts.length === 0) return 0;
  const sums = await prisma.journalLine.groupBy({ by: ['direction'], where: { accountId: { in: accounts.map((a) => a.id) } }, _sum: { amountMinor: true } });
  return sums.reduce((total, row) => total + (row.direction === 'MONEY_IN' ? 1 : -1) * toMinor(row._sum.amountMinor ?? 0n), 0);
}

/**
 * The control reconciliations: what the trial balance said (the control's
 * share of suspense, which the detail then clears) against what the detail
 * actually is. Both sides are read from the ledger, so a reconciled line
 * means the two postings cancelled exactly.
 */
export async function openingStatus(entityId: string): Promise<OpeningStatusRecord> {
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
  const batches = await prisma.openingBatch.findMany({ where: { entityId }, include: batchInclude, orderBy: { createdAt: 'desc' } });
  const posted = batches.filter((b) => b.status === 'POSTED');
  const tbBatch = posted.find((b) => b.section === 'TRIAL_BALANCE');

  const inventoryAccounts = await prisma.account.findMany({ where: { entityId, category: inventoryAccountCategory }, select: { code: true } });
  const inventoryCodes = inventoryAccounts.map((a) => a.code);

  // The trial-balance figure for a control is what its rows said; the detail is what the control account now holds.
  const tbRows = tbBatch ? (JSON.parse(tbBatch.rowsJson) as { accountCode: string; functionalMinor: number }[]) : [];
  const tbFigure = (codes: string[]) => tbRows.filter((r) => codes.includes(r.accountCode)).reduce((s, r) => s + r.functionalMinor, 0);

  const controlSpecs: { label: string; codes: string[]; sign: 1 | -1 }[] = [
    { label: 'Receivables', codes: [openingAccounts.receivables], sign: 1 },
    { label: 'Payables', codes: [openingAccounts.payables], sign: -1 },
    { label: 'Stock', codes: inventoryCodes, sign: 1 },
    { label: 'Agent floats', codes: [openingAccounts.agentFloats], sign: 1 },
    { label: 'Farmer advances', codes: [openingAccounts.farmerAdvances], sign: 1 },
  ];
  const controls: ControlReconciliation[] = [];
  for (const spec of controlSpecs) {
    const trialBalanceMinor = tbFigure(spec.codes);
    const detailMinor = await balanceOf(entityId, spec.codes);
    if (trialBalanceMinor === 0 && detailMinor === 0) continue;
    const differenceMinor = trialBalanceMinor - detailMinor;
    controls.push({ label: spec.label, trialBalanceMinor, detailMinor, differenceMinor, reconciles: differenceMinor === 0 });
  }

  const contracts = await prisma.salesContract.count({ where: { entityId } });
  return {
    cutOverDate: entity.cutOverDate ? entity.cutOverDate.toISOString().slice(0, 10) : null,
    liveAt: entity.liveAt ? entity.liveAt.toISOString() : null,
    batches: batches.map(batchRecord),
    controls,
    trialBalancePosted: !!tbBatch,
    suspenseMinor: await balanceOf(entityId, [openingAccounts.suspense]),
    contractsPosted: posted.some((b) => b.section === 'CONTRACTS'),
    contractsCount: contracts,
  };
}

export async function loadOpeningData(entityIds: string[]) {
  const entries = await Promise.all(entityIds.map(async (id) => [id, await openingStatus(id)] as const));
  return { openingByEntity: Object.fromEntries(entries) };
}
