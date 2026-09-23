'use server';

/**
 * Server Functions for mobile money and farmer payments: farmers, their
 * pre-season advances, bulk payment batches, and mobile money statement
 * imports with their column mappings.
 *
 * Same contract as documents.ts: authorize first through src/lib/dal.ts,
 * scope every query by entity, and write each change with its journal and
 * audit event in one transaction.
 *
 * Where the fee is posted, once: a statement import books every fee, levy
 * and charge line it reads, in one journal against the wallet. A batch
 * settled from a statement line therefore posts the payment only. A batch
 * marked paid by hand, with no statement behind it, books its own fee —
 * and when that statement later arrives, its fee posts with the import, so
 * do not mark a batch paid by hand if the statement is coming.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { advanceInclude, batchInclude, bankKindToPrisma, farmerAdvanceRecord, farmerInclude, farmerRecord, paymentBatchRecord, statementImportInclude, statementImportRecord, statementMappingRecord } from '@/lib/data/momo';
import { entityTypeOf } from '@/lib/data/mappers';
import { fromMinor, toMinor } from '@/lib/data/money';
import { StockRefusal } from '@/lib/data/stock';
import { purchaseInclude, purchaseRecord } from '@/lib/data/trading';
import type { AgentPurchaseRecord, FarmerAdvanceRecord, FarmerRecord, PaymentBatchRecord, StatementImportRecord, StatementMappingRecord } from '@/lib/data/types';
import { periodOf } from '@/lib/documents';
import { formatKg } from '@/lib/inventory';
import {
  batchSettlementJournal,
  chargesJournal,
  defaultMappings,
  disbursementCsv,
  matchBatch,
  momoAccounts,
  parseStatement,
  type BankAccountKind,
  type StatementMapping,
} from '@/lib/momo';
import { decryptField, encryptField } from '@/lib/pii-crypto';
import { holdsStock, type TradingJournalLine } from '@/lib/trading';
import { prisma } from '@/lib/prisma';

import type { ActionResult } from './documents';

function fail<T>(error: string): ActionResult<T> {
  return { ok: false, error };
}

async function withEntityAccess<T>(entityId: string, permission: Permission, run: (principal: Principal) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let principal: Principal;
  try {
    principal = await requireEntityAccess(entityId, permission);
  } catch (error) {
    const failure = authorizationFailure(error);
    if (failure) return failure;
    throw error;
  }
  return run(principal);
}

async function refusable<T>(run: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof StockRefusal) return fail(error.message);
    throw error;
  }
}

type Tx = Prisma.TransactionClient;

function dateOf(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new StockRefusal('Date must be YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new StockRefusal('That is not a real date.');
  return date;
}

async function requireOpenPeriod(tx: Tx, entityId: string, date: string) {
  const period = periodOf(date);
  if (await tx.taxPeriodFiling.findUnique({ where: { entityId_period: { entityId, period } } })) {
    throw new StockRefusal(`Period ${period} has been filed. Date this in an open period.`);
  }
}

async function namesFor(tx: Tx, entityId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await tx.account.findMany({ where: { entityId }, select: { code: true, name: true } })).map((a) => [a.code, a.name]));
}

/** A PAYMENT journal in the functional currency. Null when there is nothing to post. */
async function postJournal(tx: Tx, entityId: string, lines: TradingJournalLine[], date: string, reference: string, description: string, principal: Principal): Promise<string | null> {
  if (lines.length === 0) return null;
  const debits = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
  if (debits !== credits) throw new Error('Payment journal does not balance; refusing to post');
  const accounts = await tx.account.findMany({ where: { entityId, code: { in: lines.map((l) => l.accountCode) } }, select: { id: true, code: true } });
  const idOf = new Map(accounts.map((a) => [a.code, a.id]));
  for (const line of lines) if (!idOf.has(line.accountCode)) throw new StockRefusal(`Account ${line.accountCode} is not in this entity's chart.`);
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const entry = await tx.journalEntry.create({
    data: {
      entityId, kind: 'PAYMENT', reference, description, postedAt: dateOf(date), postedById: principal.userId,
      lines: { create: lines.map((line) => ({ entityId, accountId: idOf.get(line.accountCode) as string, txnCurrency: entity.functionalCurrency, txnAmountMinor: fromMinor(line.amount), rate: new Prisma.Decimal(1), amountMinor: fromMinor(line.amount), direction: line.type === 'debit' ? ('MONEY_IN' as const) : ('MONEY_OUT' as const) })) },
    },
    select: { id: true },
  });
  return entry.id;
}

async function walletCode(tx: Tx, entityId: string, bankAccountId: string): Promise<{ code: string; name: string; currency: string }> {
  const bank = await tx.bankAccount.findFirst({ where: { id: bankAccountId, entityId, isActive: true }, include: { account: { select: { code: true } } } });
  if (!bank) throw new StockRefusal('Unknown wallet or bank account for this entity.');
  return { code: bank.account.code, name: bank.name, currency: bank.currency };
}

// --- farmers ------------------------------------------------------------------------------------

export type FarmerInput = { id?: string; name: string; phone?: string; community?: string; district?: string; walletNumber?: string; isActive?: boolean };

/** Add or edit a farmer. Names are unique per entity: two Kofi Mensahs need distinguishing. */
export async function saveFarmer(entityId: string, input: FarmerInput): Promise<ActionResult<FarmerRecord>> {
  return withEntityAccess(entityId, 'stock:enter', (principal) =>
    refusable(async () => {
      const name = String(input.name ?? '').trim();
      if (!name) return fail("Give the farmer's name.");
      const data = {
        name,
        phone: encryptField('Farmer.phone', input.phone?.trim()),
        community: input.community?.trim() || null,
        district: input.district?.trim() || null,
        walletNumber: encryptField('Farmer.walletNumber', input.walletNumber?.trim()),
        isActive: input.isActive ?? true,
      };
      const row = await prisma.$transaction(async (tx) => {
        const clash = await tx.farmer.findFirst({ where: { entityId, name, ...(input.id ? { NOT: { id: input.id } } : {}) }, select: { id: true } });
        if (clash) throw new StockRefusal(`${name} is already on the farmer list.`);
        const saved = input.id
          ? await tx.farmer.update({ where: { id: (await tx.farmer.findFirstOrThrow({ where: { id: input.id, entityId }, select: { id: true } })).id }, data, include: farmerInclude })
          : await tx.farmer.create({ data: { entityId, ...data }, include: farmerInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'farmer', resourceRef: name, summary: `Farmer ${input.id ? 'updated' : 'added'}: ${name}${data.community ? ` (${data.community})` : ''}` }, tx);
        return saved;
      });
      refresh();
      return { ok: true, value: farmerRecord(row) };
    }),
  );
}

// --- pre-season advances ------------------------------------------------------------------------

export type AdvanceInput = { farmerId: string; date: string; amountMinor: number; bankAccountId: string; note?: string };

/**
 * Cash or mobile money advanced to a farmer before the season: a receivable
 * (Dr Farmer Advances / Cr the wallet it came from), recovered from what we
 * later owe them for produce.
 */
export async function recordFarmerAdvance(entityId: string, input: AdvanceInput): Promise<ActionResult<FarmerAdvanceRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const amountMinor = Math.round(Number(input.amountMinor));
      if (!(amountMinor > 0)) return fail('The advance must be more than zero.');
      const row = await prisma.$transaction(async (tx) => {
        await requireOpenPeriod(tx, entityId, input.date);
        const farmer = await tx.farmer.findFirst({ where: { id: input.farmerId, entityId, isActive: true } });
        if (!farmer) throw new StockRefusal('Unknown farmer.');
        const wallet = await walletCode(tx, entityId, input.bankAccountId);
        const names = await namesFor(tx, entityId);
        const journalId = await postJournal(
          tx, entityId,
          [
            { accountCode: momoAccounts.farmerAdvances, accountName: names[momoAccounts.farmerAdvances] ?? 'Farmer Advances', amount: amountMinor, type: 'debit' },
            { accountCode: wallet.code, accountName: names[wallet.code] ?? wallet.name, amount: amountMinor, type: 'credit' },
          ],
          input.date, `ADV ${farmer.name}`, `Pre-season advance to ${farmer.name} from ${wallet.name}`, principal,
        );
        const advance = await tx.farmerAdvance.create({
          data: { entityId, farmerId: farmer.id, farmerName: farmer.name, community: farmer.community, district: farmer.district, date: dateOf(input.date), amountMinor: fromMinor(amountMinor), journalEntryId: journalId, note: input.note?.trim() || null, createdById: principal.userId },
          include: advanceInclude,
        });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'farmer-advance', resourceRef: farmer.name, summary: `Advance of ${(amountMinor / 100).toFixed(2)} to ${farmer.name} from ${wallet.name}`, metadata: { journalEntryId: journalId, farmerId: farmer.id } }, tx);
        return advance;
      });
      refresh();
      return { ok: true, value: farmerAdvanceRecord(row) };
    }),
  );
}

// --- payment batches ------------------------------------------------------------------------------

/** The next reference for this entity: MP-0001, MP-0002 … */
async function nextBatchReference(tx: Tx, entityId: string): Promise<string> {
  const last = await tx.farmerPaymentBatch.findFirst({ where: { entityId }, orderBy: { createdAt: 'desc' }, select: { reference: true } });
  const previous = last ? Number(/(\d+)$/.exec(last.reference)?.[1] ?? 0) : 0;
  return `MP-${String(previous + 1).padStart(4, '0')}`;
}

export type BatchInput = { date: string; bankAccountId: string; purchaseIds: string[]; note?: string };

/**
 * One batch covering many farmers: every purchase named must be posted, left
 * payable, and not already in a batch. Each farmer's net payable becomes one
 * line. Nothing posts here — the ledger moves when the money does.
 */
export async function createPaymentBatch(entityId: string, input: BatchInput): Promise<ActionResult<PaymentBatchRecord>> {
  return withEntityAccess(entityId, 'document:draft', (principal) =>
    refusable(async () => {
      const ids = [...new Set((input.purchaseIds ?? []).filter(Boolean))].slice(0, 500);
      if (ids.length === 0) return fail('Choose at least one purchase to pay.');
      const row = await prisma.$transaction(async (tx) => {
        await walletCode(tx, entityId, input.bankAccountId);
        dateOf(input.date);
        const purchases = await tx.agentPurchase.findMany({
          where: { id: { in: ids }, entityId, status: 'POSTED', settlement: 'PAYABLE' },
          include: { farmer: { select: { id: true, name: true, walletNumber: true } }, payments: { select: { amountMinor: true } } },
        });
        if (purchases.length !== ids.length) throw new StockRefusal('Some of those purchases are not posted, were paid by the agent, or belong to another entity.');
        const lines = purchases.map((purchase) => {
          if (!purchase.farmer) throw new StockRefusal(`The purchase from ${purchase.farmerName} is not linked to a farmer record.`);
          const outstanding = toMinor(purchase.payableMinor) - purchase.payments.reduce((s, p) => s + toMinor(p.amountMinor), 0);
          if (outstanding <= 0) throw new StockRefusal(`${purchase.farmerName} has already been paid for the purchase of ${purchase.date.toISOString().slice(0, 10)}.`);
          const wallet = decryptField('Farmer.walletNumber', purchase.farmer.walletNumber);
          return { purchaseId: purchase.id, farmerId: purchase.farmer.id, amountMinor: outstanding, walletNumber: encryptField('FarmerPayment.walletNumber', wallet) };
        });
        const totalMinor = lines.reduce((s, l) => s + l.amountMinor, 0);
        const reference = await nextBatchReference(tx, entityId);
        const batch = await tx.farmerPaymentBatch.create({
          data: {
            entityId, reference, date: dateOf(input.date), bankAccountId: input.bankAccountId, totalMinor: fromMinor(totalMinor), note: input.note?.trim() || null, createdById: principal.userId,
            payments: { create: lines.map((line) => ({ entityId, farmerId: line.farmerId, purchaseId: line.purchaseId, amountMinor: fromMinor(line.amountMinor), walletNumber: line.walletNumber })) },
          },
          include: batchInclude,
        });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'payment-batch', resourceRef: reference, summary: `Payment batch ${reference}: ${lines.length} farmer${lines.length === 1 ? '' : 's'}, ${(totalMinor / 100).toFixed(2)}`, metadata: { purchaseIds: ids } }, tx);
        return batch;
      });
      refresh();
      return { ok: true, value: paymentBatchRecord(row) };
    }),
  );
}

export type BatchExport = { fileName: string; csv: string; batch: PaymentBatchRecord };

/** The file for bulk disbursement. Every payee needs a wallet number, or there is nothing to send to. */
export async function exportPaymentBatch(entityId: string, batchId: string): Promise<ActionResult<BatchExport>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const result = await prisma.$transaction(async (tx) => {
        const batch = await tx.farmerPaymentBatch.findFirst({ where: { id: batchId, entityId }, include: batchInclude });
        if (!batch) throw new StockRefusal('Unknown payment batch.');
        if (batch.status === 'PAID') throw new StockRefusal(`${batch.reference} has already been paid.`);
        const missing = batch.payments.filter((p) => !decryptField('FarmerPayment.walletNumber', p.walletNumber)?.trim()).map((p) => p.farmer.name);
        if (missing.length) throw new StockRefusal(`No wallet number for ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}. Add it on the farmer.`);
        const csv = disbursementCsv(
          batch.reference,
          batch.payments.map((p) => ({ farmerName: p.farmer.name, walletNumber: decryptField('FarmerPayment.walletNumber', p.walletNumber) ?? '', amountMinor: toMinor(p.amountMinor), reference: p.paymentRef ?? '' })),
        );
        const updated = await tx.farmerPaymentBatch.update({ where: { id: batch.id }, data: { status: 'EXPORTED', exportedAt: new Date() }, include: batchInclude });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'payment-batch', resourceRef: batch.reference, summary: `Payment batch ${batch.reference} exported for disbursement: ${batch.payments.length} farmers, ${(toMinor(batch.totalMinor) / 100).toFixed(2)}` }, tx);
        return { fileName: `${entityId}-${batch.reference}.csv`, csv, batch: paymentBatchRecord(updated) };
      });
      refresh();
      return { ok: true, value: result };
    }),
  );
}

/**
 * The batch cleared: farmers' payables go, the wallet pays out. The fee is
 * posted here only when no statement will bring it (see the file header).
 */
async function settleBatch(tx: Tx, entityId: string, batchId: string, date: string, feeMinor: number, postFee: boolean, principal: Principal, note: string) {
  const batch = await tx.farmerPaymentBatch.findFirst({ where: { id: batchId, entityId }, include: { payments: true, bankAccount: { include: { account: { select: { code: true } } } } } });
  if (!batch) throw new StockRefusal('Unknown payment batch.');
  if (batch.status === 'PAID') throw new StockRefusal(`${batch.reference} has already been settled.`);
  await requireOpenPeriod(tx, entityId, date);
  const totalMinor = toMinor(batch.totalMinor);
  const names = await namesFor(tx, entityId);
  const journalId = await postJournal(
    tx, entityId,
    batchSettlementJournal(totalMinor, postFee ? feeMinor : 0, batch.bankAccount.account.code, names),
    date, batch.reference, `${batch.payments.length} farmer payment${batch.payments.length === 1 ? '' : 's'} from ${batch.bankAccount.name}${note ? ` — ${note}` : ''}`, principal,
  );
  const updated = await tx.farmerPaymentBatch.update({
    where: { id: batch.id },
    data: { status: 'PAID', paidAt: new Date(), paidById: principal.userId, feeMinor: fromMinor(feeMinor), journalEntryId: journalId },
    include: batchInclude,
  });
  await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'payment-batch', resourceRef: batch.reference, summary: `Payment batch ${batch.reference} settled: ${(totalMinor / 100).toFixed(2)} to ${batch.payments.length} farmer${batch.payments.length === 1 ? '' : 's'} from ${batch.bankAccount.name}${feeMinor ? `, fee ${(feeMinor / 100).toFixed(2)}` : ''}`, metadata: { journalEntryId: journalId, feeMinor, feePostedHere: postFee } }, tx);
  return updated;
}

export type SettleInput = { date: string; feeMinor?: number };

/** Mark a batch paid without a statement: it posts its own fee. */
export async function markBatchPaid(entityId: string, batchId: string, input: SettleInput): Promise<ActionResult<PaymentBatchRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const feeMinor = Math.max(0, Math.round(Number(input.feeMinor ?? 0)));
      const row = await prisma.$transaction((tx) => settleBatch(tx, entityId, batchId, input.date, feeMinor, true, principal, 'marked paid'));
      refresh();
      return { ok: true, value: paymentBatchRecord(row) };
    }),
  );
}

// --- statement mappings ---------------------------------------------------------------------------

export type MappingInput = {
  id?: string;
  name: string;
  dateColumn: string;
  descriptionColumn: string;
  referenceColumn?: string;
  amountColumn?: string;
  moneyInColumn?: string;
  moneyOutColumn?: string;
  feeColumn?: string;
  levyColumn?: string;
  balanceColumn?: string;
  chargeKeywords?: string;
  dateFormat?: string;
};

export async function saveStatementMapping(entityId: string, input: MappingInput): Promise<ActionResult<StatementMappingRecord>> {
  return withEntityAccess(entityId, 'rates:manage', (principal) =>
    refusable(async () => {
      const name = String(input.name ?? '').trim();
      if (!name) return fail('Give the mapping a name.');
      if (!input.dateColumn?.trim() || !input.descriptionColumn?.trim()) return fail('Name the date and description columns as they appear in the file.');
      if (!input.amountColumn?.trim() && !input.moneyInColumn?.trim() && !input.moneyOutColumn?.trim()) return fail('Name an amount column, or the money in and money out columns.');
      const data = {
        name,
        dateColumn: input.dateColumn.trim(),
        descriptionColumn: input.descriptionColumn.trim(),
        referenceColumn: input.referenceColumn?.trim() || null,
        amountColumn: input.amountColumn?.trim() || null,
        moneyInColumn: input.moneyInColumn?.trim() || null,
        moneyOutColumn: input.moneyOutColumn?.trim() || null,
        feeColumn: input.feeColumn?.trim() || null,
        levyColumn: input.levyColumn?.trim() || null,
        balanceColumn: input.balanceColumn?.trim() || null,
        chargeKeywords: input.chargeKeywords?.trim() || null,
        dateFormat: input.dateFormat?.trim() || 'YYYY-MM-DD',
      };
      const row = await prisma.$transaction(async (tx) => {
        if (input.id) await tx.statementMapping.findFirstOrThrow({ where: { id: input.id, entityId }, select: { id: true } });
        const saved = input.id
          ? await tx.statementMapping.update({ where: { id: input.id }, data })
          : await tx.statementMapping.create({ data: { entityId, ...data } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'statement-mapping', resourceRef: name, summary: `Statement mapping ${input.id ? 'updated' : 'added'}: ${name}` }, tx);
        return saved;
      });
      refresh();
      return { ok: true, value: statementMappingRecord(row) };
    }),
  );
}

/** Add the mappings the Ghanaian providers' exports need, skipping any already there. */
export async function addDefaultStatementMappings(entityId: string): Promise<ActionResult<StatementMappingRecord[]>> {
  return withEntityAccess(entityId, 'rates:manage', (principal) =>
    refusable(async () => {
      const rows = await prisma.$transaction(async (tx) => {
        const existing = new Set((await tx.statementMapping.findMany({ where: { entityId }, select: { name: true } })).map((m) => m.name));
        const added = [];
        for (const mapping of defaultMappings) {
          if (existing.has(mapping.name)) continue;
          added.push(
            await tx.statementMapping.create({
              data: {
                entityId, name: mapping.name, dateColumn: mapping.dateColumn, descriptionColumn: mapping.descriptionColumn, referenceColumn: mapping.referenceColumn,
                amountColumn: mapping.amountColumn, moneyInColumn: mapping.moneyInColumn, moneyOutColumn: mapping.moneyOutColumn, feeColumn: mapping.feeColumn, levyColumn: mapping.levyColumn,
                balanceColumn: mapping.balanceColumn, chargeKeywords: mapping.chargeKeywords.join(','), dateFormat: mapping.dateFormat,
              },
            }),
          );
        }
        if (added.length) await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'statement-mapping', resourceRef: `${added.length} added`, summary: `${added.length} provider statement mapping${added.length === 1 ? '' : 's'} added` }, tx);
        return added;
      });
      refresh();
      return { ok: true, value: rows.map(statementMappingRecord) };
    }),
  );
}

// --- statement import and matching -------------------------------------------------------------------

export type ImportInput = { bankAccountId: string; mappingId: string; fileName: string; csv: string };
export type ImportResult = { statement: StatementImportRecord; matched: number; errors: { row: number; message: string }[] };

/**
 * Read a statement into the wallet's reconciliation. The fee and levy come
 * off each line so the line still matches the payment it settled; all of it,
 * plus any line that is only a charge, posts in one journal to Mobile Money
 * Charges & Levies — never left as an unmatched difference. Batches whose
 * reference or amount fits a line are matched and settled in the same step.
 */
export async function importStatement(entityId: string, input: ImportInput): Promise<ActionResult<ImportResult>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      if (!input.csv?.trim()) return fail('The file is empty.');
      if (input.csv.length > 2_000_000) return fail('That file is too large; split it by month.');

      const mapping = await prisma.statementMapping.findFirst({ where: { id: input.mappingId, entityId } });
      if (!mapping) return fail('Choose a statement mapping for this provider.');
      const spec: StatementMapping = {
        name: mapping.name, dateColumn: mapping.dateColumn, descriptionColumn: mapping.descriptionColumn, referenceColumn: mapping.referenceColumn,
        amountColumn: mapping.amountColumn, moneyInColumn: mapping.moneyInColumn, moneyOutColumn: mapping.moneyOutColumn, feeColumn: mapping.feeColumn,
        levyColumn: mapping.levyColumn, balanceColumn: mapping.balanceColumn,
        chargeKeywords: (mapping.chargeKeywords ?? '').split(',').map((word) => word.trim()).filter(Boolean),
        dateFormat: mapping.dateFormat,
      };
      const parsed = parseStatement(input.csv, spec);
      if (parsed.lines.length === 0) return fail(parsed.errors[0]?.message ?? 'No usable rows in that file.');

      const dates = parsed.lines.map((l) => l.date).sort();
      const result = await prisma.$transaction(async (tx) => {
        const wallet = await walletCode(tx, entityId, input.bankAccountId);
        await requireOpenPeriod(tx, entityId, dates[dates.length - 1]);

        const statement = await tx.statementImport.create({
          data: {
            entityId, bankAccountId: input.bankAccountId, mappingId: mapping.id, fileName: input.fileName.slice(0, 200) || 'statement.csv',
            fromDate: dateOf(dates[0]), toDate: dateOf(dates[dates.length - 1]), lineCount: parsed.lines.length, feeMinor: fromMinor(parsed.feeTotalMinor), createdById: principal.userId,
          },
        });

        // One journal for everything the provider took: fees, levies and charge-only lines.
        const names = await namesFor(tx, entityId);
        const feeJournalId = await postJournal(
          tx, entityId, chargesJournal(parsed.feeTotalMinor, wallet.code, names),
          dates[dates.length - 1], `${wallet.name} charges`, `Mobile money charges and levies on ${statement.fileName}`, principal,
        );
        if (feeJournalId) await tx.statementImport.update({ where: { id: statement.id }, data: { feeJournalEntryId: feeJournalId } });

        const open = await tx.farmerPaymentBatch.findMany({ where: { entityId, bankAccountId: input.bankAccountId, status: { in: ['DRAFT', 'EXPORTED'] } }, select: { id: true, reference: true, date: true, totalMinor: true, feeMinor: true } });
        const candidates = open.map((b) => ({ id: b.id, reference: b.reference, date: b.date.toISOString().slice(0, 10), totalMinor: toMinor(b.totalMinor), feeMinor: toMinor(b.feeMinor) }));
        const taken = new Set<string>();
        let matched = 0;

        for (const line of parsed.lines) {
          const hit = line.isCharge || line.amountMinor >= 0 ? null : matchBatch(line, candidates.filter((c) => !taken.has(c.id)));
          if (hit) {
            taken.add(hit.id);
            // The fee went with the import's charges journal, so the settlement posts the payment alone.
            await settleBatch(tx, entityId, hit.id, line.date, line.feeMinor + line.levyMinor, false, principal, `matched to ${statement.fileName}`);
            matched += 1;
          }
          await tx.statementLine.create({
            data: {
              entityId, importId: statement.id, bankAccountId: input.bankAccountId, date: dateOf(line.date), description: line.description.slice(0, 500), reference: line.reference,
              amountMinor: fromMinor(line.amountMinor), feeMinor: fromMinor(line.feeMinor), levyMinor: fromMinor(line.levyMinor),
              balanceMinor: line.balanceMinor === null ? null : fromMinor(line.balanceMinor),
              status: line.isCharge ? 'CHARGE' : hit ? 'MATCHED' : 'UNMATCHED',
              matchedBatchId: hit?.id ?? null,
              journalEntryId: line.isCharge ? feeJournalId : null,
            },
          });
        }

        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'statement-import', resourceRef: statement.fileName, summary: `${parsed.lines.length} line${parsed.lines.length === 1 ? '' : 's'} imported into ${wallet.name}: ${matched} batch${matched === 1 ? '' : 'es'} matched, ${(parsed.feeTotalMinor / 100).toFixed(2)} of charges posted`, metadata: { importId: statement.id, feeJournalEntryId: feeJournalId } }, tx);

        const full = await tx.statementImport.findUniqueOrThrow({ where: { id: statement.id }, include: statementImportInclude });
        return { statement: statementImportRecord(full), matched, errors: parsed.errors };
      });
      refresh();
      return { ok: true, value: result };
    }),
  );
}

/** Match one statement line to a batch by hand, settling that batch in the same step. */
export async function matchStatementLine(entityId: string, lineId: string, batchId: string): Promise<ActionResult<StatementImportRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const importId = await prisma.$transaction(async (tx) => {
        const line = await tx.statementLine.findFirst({ where: { id: lineId, entityId } });
        if (!line) throw new StockRefusal('Unknown statement line.');
        if (line.status !== 'UNMATCHED') throw new StockRefusal('That line is already matched.');
        const batch = await tx.farmerPaymentBatch.findFirst({ where: { id: batchId, entityId, bankAccountId: line.bankAccountId }, select: { id: true, totalMinor: true, reference: true } });
        if (!batch) throw new StockRefusal('That batch is not on this wallet.');
        if (toMinor(batch.totalMinor) !== Math.abs(toMinor(line.amountMinor))) throw new StockRefusal(`${batch.reference} is ${(toMinor(batch.totalMinor) / 100).toFixed(2)} but the statement line is ${(Math.abs(toMinor(line.amountMinor)) / 100).toFixed(2)}.`);
        // The fee was posted with the import; the settlement posts the payment alone.
        await settleBatch(tx, entityId, batch.id, line.date.toISOString().slice(0, 10), toMinor(line.feeMinor) + toMinor(line.levyMinor), false, principal, 'matched by hand');
        await tx.statementLine.update({ where: { id: line.id }, data: { status: 'MATCHED', matchedBatchId: batch.id } });
        return line.importId;
      });
      refresh();
      const full = await prisma.statementImport.findUniqueOrThrow({ where: { id: importId }, include: statementImportInclude });
      return { ok: true, value: statementImportRecord(full) };
    }),
  );
}

/** Note on an unmatched line why it is there (a transfer between our own wallets, say). */
export async function noteStatementLine(entityId: string, lineId: string, note: string): Promise<ActionResult<StatementImportRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const importId = await prisma.$transaction(async (tx) => {
        const line = await tx.statementLine.findFirst({ where: { id: lineId, entityId } });
        if (!line) throw new StockRefusal('Unknown statement line.');
        await tx.statementLine.update({ where: { id: line.id }, data: { note: note.trim().slice(0, 500) || null } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'statement-line', resourceRef: line.description.slice(0, 60), summary: `Statement line noted: ${note.trim().slice(0, 120)}` }, tx);
        return line.importId;
      });
      refresh();
      const full = await prisma.statementImport.findUniqueOrThrow({ where: { id: importId }, include: statementImportInclude });
      return { ok: true, value: statementImportRecord(full) };
    }),
  );
}

// --- wallets ------------------------------------------------------------------------------------------

export type WalletInput = { name: string; provider: string; number: string; currency: string };

/**
 * A mobile money wallet: a bank account with a provider and a number, its own
 * GL account, and the same reconciliation as any other bank account.
 */
export async function createWallet(entityId: string, input: WalletInput): Promise<ActionResult<{ id: string; name: string }>> {
  return withEntityAccess(entityId, 'rates:manage', (principal) =>
    refusable(async () => {
      const name = input.name.trim();
      const provider = input.provider.trim();
      const number = input.number.trim();
      if (!name) return fail('Give the wallet a name.');
      if (!provider) return fail('Name the provider (MTN MoMo, Telecel Cash, AT Money).');
      if (!/^[0-9+\- ]{6,20}$/.test(number)) return fail('Give the wallet number.');
      const codes = ['1002', '1003', '1004', '1006', '1007', '1008', '1009'];
      const row = await prisma.$transaction(async (tx) => {
        const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
        const taken = new Set((await tx.account.findMany({ where: { entityId, code: { in: codes } }, select: { code: true } })).map((a) => a.code));
        const code = codes.find((candidate) => !taken.has(candidate));
        if (!code) throw new StockRefusal('No spare bank account code in the 1002–1009 range.');
        const parent = await tx.account.findUnique({ where: { entityId_code: { entityId, code: '1001' } }, select: { id: true } });
        const account = await tx.account.create({ data: { entityId, code, name: `${name} (${provider})`, type: 'ASSET', category: 'bank', parentId: parent?.id ?? null } });
        const wallet = await tx.bankAccount.create({
          data: { entityId, name, currency: entity.functionalCurrency, kind: bankKindToPrisma['mobile-money' as BankAccountKind], provider, number, accountId: account.id },
        });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'bank-account', resourceRef: code, summary: `Mobile money wallet "${name}" (${provider} ${number}) added as ${code}` }, tx);
        return wallet;
      });
      refresh();
      return { ok: true, value: { id: row.id, name: row.name } };
    }),
  );
}

// --- the farmer's history ---------------------------------------------------------------------------------

export type FarmerHistoryReport = {
  farmer: FarmerRecord;
  events: {
    kind: 'delivery' | 'advance' | 'payment';
    date: string;
    description: string;
    grams: number;
    grossMinor: number;
    recoveredMinor: number;
    payableMinor: number;
    paidMinor: number;
    reference: string;
    evidence: string;
  }[];
  purchases: AgentPurchaseRecord[];
  advances: FarmerAdvanceRecord[];
};

const evidenceLabels: Record<string, string> = { SIGNATURE: 'Signature', THUMBPRINT: 'Thumbprint', REFERENCE: 'Reference' };

/** Everything about one farmer: deliveries, what was paid, advances and recoveries. */
export async function farmerHistoryReport(entityId: string, farmerId: string): Promise<ActionResult<FarmerHistoryReport>> {
  return withEntityAccess(entityId, 'reports:view', () =>
    refusable(async () => {
      const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId }, select: { type: true, name: true } });
      if (!holdsStock(entityTypeOf(entity.type))) return fail(`${entity.name} is an impact programme and buys no produce.`);
      const farmer = await prisma.farmer.findFirst({ where: { id: farmerId, entityId }, include: farmerInclude });
      if (!farmer) return fail('Unknown farmer.');

      const [purchases, advances, payments] = await Promise.all([
        prisma.agentPurchase.findMany({ where: { entityId, farmerId, status: 'POSTED' }, include: { ...purchaseInclude, item: { select: { name: true } } }, orderBy: { date: 'desc' } }),
        prisma.farmerAdvance.findMany({ where: { entityId, farmerId }, include: advanceInclude, orderBy: { date: 'desc' } }),
        prisma.farmerPayment.findMany({ where: { entityId, farmerId }, include: { batch: { select: { reference: true, date: true, status: true, bankAccount: { select: { name: true } } } } } }),
      ]);

      const events: FarmerHistoryReport['events'] = [
        ...purchases.map((purchase) => ({
          kind: 'delivery' as const,
          date: purchase.date.toISOString().slice(0, 10),
          description: `${formatKg(toMinor(purchase.grams))} ${purchase.item.name}`,
          grams: toMinor(purchase.grams),
          grossMinor: toMinor(purchase.priceMinor),
          recoveredMinor: toMinor(purchase.recoveredMinor),
          payableMinor: toMinor(purchase.payableMinor),
          paidMinor: purchase.settlement === 'FLOAT' ? toMinor(purchase.payableMinor) : purchase.payments.reduce((s, p) => s + toMinor(p.amountMinor), 0),
          reference: purchase.paymentRef ?? purchase.clientRef,
          evidence: purchase.evidenceKind ? evidenceLabels[purchase.evidenceKind] : purchase.settlement === 'PAYABLE' ? 'Paid centrally' : '',
        })),
        ...advances.map((advance) => ({
          kind: 'advance' as const,
          date: advance.date.toISOString().slice(0, 10),
          description: advance.note || 'Pre-season advance',
          grams: 0,
          grossMinor: 0,
          recoveredMinor: toMinor(advance.settledMinor),
          payableMinor: 0,
          paidMinor: toMinor(advance.amountMinor),
          reference: '',
          evidence: '',
        })),
        ...payments
          .filter((payment) => payment.batch.status === 'PAID')
          .map((payment) => ({
            kind: 'payment' as const,
            date: payment.batch.date.toISOString().slice(0, 10),
            description: `Paid in ${payment.batch.reference} from ${payment.batch.bankAccount.name}`,
            grams: 0,
            grossMinor: 0,
            recoveredMinor: 0,
            payableMinor: 0,
            paidMinor: toMinor(payment.amountMinor),
            reference: payment.paymentRef ?? payment.batch.reference,
            evidence: '',
          })),
      ].sort((a, b) => b.date.localeCompare(a.date));

      return {
        ok: true,
        value: {
          farmer: farmerRecord(farmer),
          events,
          purchases: purchases.map(purchaseRecord),
          advances: advances.map(farmerAdvanceRecord),
        },
      };
    }),
  );
}
