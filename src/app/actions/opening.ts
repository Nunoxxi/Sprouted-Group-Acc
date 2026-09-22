'use server';

/**
 * Server Functions for opening balances: the cut-over date, the Excel
 * template, uploading and posting each section, and going live.
 *
 * The invariant: the trial balance posts with its control accounts
 * redirected to 3090 Opening Balance Suspense; every detail import posts to
 * its control account against suspense. Suspense is therefore exactly the
 * difference between the detail and the trial balance, go-live is refused
 * while it is not zero, and nothing may be imported once an entity is live.
 */

import { refresh } from 'next/cache';
import { Prisma } from '@prisma/client';

import { recordAuditEvent } from '@/lib/audit';
import type { Permission, Principal } from '@/lib/authz';
import { authorizationFailure, requireEntityAccess } from '@/lib/dal';
import { seedChartForEntity } from '@/lib/data/chart.ts';
import { entityRecord, entityTypeOf } from '@/lib/data/mappers';
import { fromMinor } from '@/lib/data/money';
import { batchInclude, batchRecord, openingStatus, sectionToPrisma } from '@/lib/data/opening';
import { buildTemplate, parseWorkbook } from '@/lib/data/opening-xlsx';
import { moveBalance, StockRefusal } from '@/lib/data/stock';
import type { EntityRecord, OpeningBatchRecord, OpeningStatusRecord } from '@/lib/data/types';
import { convertMinor, type Currency } from '@/lib/fx';
import { formatKg, inventoryAccountCategory } from '@/lib/inventory';
import {
  checkTrialBalance,
  detailJournal,
  goLiveChecklist,
  openingAccounts,
  openingSections,
  sectionLabels,
  trialBalanceJournal,
  type ContractRow,
  type FarmerAdvanceRow,
  type FloatRow,
  type OpenDocumentRow,
  type OpeningSection,
  type RowError,
  type StockRow,
  type TrialBalanceRow,
} from '@/lib/opening';
import { prisma } from '@/lib/prisma';
import { holdsStock, type TradingJournalLine } from '@/lib/trading';

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

/** Opening balances may be touched only before go-live, and only with a cut-over date. */
async function requireSettingUp(entityId: string) {
  const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
  if (entity.liveAt) throw new StockRefusal(`${entity.name} went live on ${entity.liveAt.toISOString().slice(0, 10)}; opening balances are closed. Post a correcting journal instead.`);
  if (!entity.cutOverDate) throw new StockRefusal('Set the cut-over date first.');
  return entity;
}

async function namesFor(tx: Tx, entityId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await tx.account.findMany({ where: { entityId }, select: { code: true, name: true } })).map((a) => [a.code, a.name]));
}

/** An OPENING journal dated the cut-over date. Foreign lines carry their currency and cut-over rate. */
async function postOpeningJournal(
  tx: Tx,
  entityId: string,
  lines: TradingJournalLine[],
  date: string,
  reference: string,
  description: string,
  principal: Principal,
  foreignByCode?: Record<string, { currency: Currency; rate: string; txnAmountMinor: number }>,
): Promise<string | null> {
  if (lines.length === 0) return null;
  const debits = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amount, 0);
  const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amount, 0);
  if (debits !== credits) throw new Error('Opening journal does not balance; refusing to post');
  const accounts = await tx.account.findMany({ where: { entityId, code: { in: lines.map((l) => l.accountCode) } }, select: { id: true, code: true } });
  const idOf = new Map(accounts.map((a) => [a.code, a.id]));
  for (const line of lines) if (!idOf.has(line.accountCode)) throw new StockRefusal(`Account ${line.accountCode} is not in this entity's chart.`);
  const entity = await tx.entity.findUniqueOrThrow({ where: { id: entityId }, select: { functionalCurrency: true } });
  const entry = await tx.journalEntry.create({
    data: {
      entityId, kind: 'OPENING', reference, description, postedAt: dateOf(date), postedById: principal.userId,
      lines: {
        create: lines.map((line) => {
          const foreign = foreignByCode?.[line.accountCode];
          const txn = foreign ? { txnCurrency: foreign.currency, txnAmountMinor: fromMinor(foreign.txnAmountMinor), rate: new Prisma.Decimal(foreign.rate) } : { txnCurrency: entity.functionalCurrency, txnAmountMinor: fromMinor(line.amount), rate: new Prisma.Decimal(1) };
          return { entityId, accountId: idOf.get(line.accountCode) as string, ...txn, amountMinor: fromMinor(line.amount), direction: line.type === 'debit' ? ('MONEY_IN' as const) : ('MONEY_OUT' as const) };
        }),
      },
    },
    select: { id: true },
  });
  return entry.id;
}

// --- cut-over date and the template ------------------------------------------------------------

export async function setCutOverDate(entityId: string, date: string): Promise<ActionResult<EntityRecord>> {
  return withEntityAccess(entityId, 'entity:configure', (principal) =>
    refusable(async () => {
      const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
      if (entity.liveAt) return fail(`${entity.name} is already live; the cut-over date is fixed.`);
      dateOf(date);
      const posted = await prisma.openingBatch.count({ where: { entityId, status: 'POSTED' } });
      if (posted > 0) return fail('Opening balances have already been posted at the current cut-over date. Remove them before changing it.');
      const updated = await prisma.$transaction(async (tx) => {
        await seedChartForEntity(tx, entityId, entityTypeOf(entity.type));
        const row = await tx.entity.update({ where: { id: entityId }, data: { cutOverDate: dateOf(date) } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'entity', resourceRef: entityId, summary: `Cut-over date set to ${date}` }, tx);
        return row;
      });
      refresh();
      return { ok: true, value: entityRecord(updated) };
    }),
  );
}

/** The workbook for this entity, base64 so it can cross the Server Function boundary. */
export async function openingTemplate(entityId: string): Promise<ActionResult<{ fileName: string; base64: string }>> {
  return withEntityAccess(entityId, 'entity:configure', () =>
    refusable(async () => {
      const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
      const [accounts, contacts, grades, locations, agents] = await Promise.all([
        prisma.account.findMany({ where: { entityId, isActive: true }, select: { code: true, name: true, type: true, category: true }, orderBy: { code: 'asc' } }),
        prisma.contact.findMany({ where: { isActive: true }, select: { name: true, type: true }, orderBy: { name: 'asc' } }),
        prisma.item.findMany({ where: { entityId, isActive: true, commodityId: { not: null } }, include: { commodity: { select: { code: true } } }, orderBy: { code: 'asc' } }),
        prisma.stockLocation.findMany({ where: { entityId, isActive: true }, select: { code: true, name: true }, orderBy: { code: 'asc' } }),
        prisma.buyingAgent.findMany({ where: { entityId, isActive: true }, select: { name: true }, orderBy: { name: 'asc' } }),
      ]);
      const buffer = await buildTemplate({
        entity: { id: entity.id, name: entity.name, functionalCurrency: entity.functionalCurrency, cutOverDate: entity.cutOverDate ? entity.cutOverDate.toISOString().slice(0, 10) : null, holdsStock: holdsStock(entityTypeOf(entity.type)) },
        accounts,
        contacts: contacts.map((c) => ({ name: c.name, type: c.type.toLowerCase() })),
        grades: grades.map((g) => ({ commodityCode: g.commodity?.code ?? '', grade: g.grade ?? '', name: g.name })),
        locations,
        agents,
      });
      return { ok: true, value: { fileName: `sprouted-opening-${entity.id}.xlsx`, base64: buffer.toString('base64') } };
    }),
  );
}

// --- upload -------------------------------------------------------------------------------------

export type UploadResult = { batches: OpeningBatchRecord[]; errors: { section: OpeningSection; rows: RowError[] }[] };

/**
 * Parse an uploaded workbook into one draft batch per sheet that has rows.
 * A sheet with any error is not saved at all — the errors come back with
 * their row numbers so they can be fixed in the file.
 */
export async function uploadOpeningWorkbook(entityId: string, fileName: string, base64: string): Promise<ActionResult<UploadResult>> {
  return withEntityAccess(entityId, 'entity:configure', (principal) =>
    refusable(async () => {
      const entity = await requireSettingUp(entityId);
      let parsed;
      try {
        parsed = await parseWorkbook(Buffer.from(base64, 'base64'), entity.functionalCurrency);
      } catch {
        return fail('That file could not be read as an Excel workbook. Use the template.');
      }
      const chartCodes = new Set((await prisma.account.findMany({ where: { entityId }, select: { code: true } })).map((a) => a.code));
      const result: UploadResult = { batches: [], errors: [] };

      for (const section of openingSections) {
        const parsedSection = parsed.sections[section];
        if (!parsedSection || parsedSection.rows.length === 0) continue;
        let errors = [...parsedSection.errors];
        let rows: unknown[] = parsedSection.rows;

        if (section === 'trial-balance') {
          const check = checkTrialBalance(parsedSection.rows as TrialBalanceRow[], chartCodes, entity.functionalCurrency);
          errors = [...errors, ...check.errors];
          if (!check.balances) errors.push({ row: 0, message: `The trial balance does not balance: money in ${(check.debitsMinor / 100).toFixed(2)}, money out ${(check.creditsMinor / 100).toFixed(2)}, difference ${(check.differenceMinor / 100).toFixed(2)}.` });
          rows = (parsedSection.rows as TrialBalanceRow[]).map((r, i) => ({ ...r, functionalMinor: check.functionalRows[i].amountMinor }));
        }

        if (errors.length > 0) {
          result.errors.push({ section, rows: errors });
          continue;
        }
        const existing = await prisma.openingBatch.findFirst({ where: { entityId, section: sectionToPrisma[section], status: 'DRAFT' } });
        if (existing) await prisma.openingBatch.delete({ where: { id: existing.id } });
        const batch = await prisma.openingBatch.create({
          data: { entityId, section: sectionToPrisma[section], fileName, rowsJson: JSON.stringify(rows), rowCount: rows.length, createdById: principal.userId },
          include: batchInclude,
        });
        result.batches.push(batchRecord(batch));
      }

      if (result.batches.length === 0 && result.errors.length === 0) return fail('No rows found. Fill in at least one sheet of the template.');
      if (result.batches.length > 0) {
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'opening', resourceRef: fileName, summary: `Opening balances uploaded: ${result.batches.map((b) => `${sectionLabels[b.section]} (${b.rowCount})`).join(', ')}${result.errors.length ? `; ${result.errors.length} sheet(s) rejected` : ''}` });
        refresh();
      }
      return { ok: true, value: result };
    }),
  );
}

export async function discardOpeningBatch(entityId: string, batchId: string): Promise<ActionResult<OpeningStatusRecord>> {
  return withEntityAccess(entityId, 'entity:configure', (principal) =>
    refusable(async () => {
      await requireSettingUp(entityId);
      const batch = await prisma.openingBatch.findFirst({ where: { id: batchId, entityId } });
      if (!batch) return fail('Batch not found.');
      if (batch.status === 'POSTED') return fail('A posted batch cannot be discarded. Reverse it with a journal, or remove the opening balances entirely.');
      await prisma.openingBatch.delete({ where: { id: batch.id } });
      await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'opening', resourceRef: batch.fileName, summary: `Opening draft discarded: ${sectionLabels[batch.section === 'TRIAL_BALANCE' ? 'trial-balance' : batch.section === 'FARMER_ADVANCES' ? 'farmer-advances' : (batch.section.toLowerCase() as OpeningSection)]}` });
      refresh();
      return { ok: true, value: await openingStatus(entityId) };
    }),
  );
}

// --- posting ------------------------------------------------------------------------------------

/** Post one draft batch. Each section writes its own records and its own journal against suspense. */
export async function postOpeningBatch(entityId: string, batchId: string): Promise<ActionResult<OpeningStatusRecord>> {
  return withEntityAccess(entityId, 'document:post', (principal) =>
    refusable(async () => {
      const entity = await requireSettingUp(entityId);
      const cutOver = entity.cutOverDate!.toISOString().slice(0, 10);
      const draft = await prisma.openingBatch.findFirst({ where: { id: batchId, entityId } });
      if (!draft) return fail('Batch not found.');
      if (draft.status === 'POSTED') return fail('This batch has already been posted.');
      const section = (['TRIAL_BALANCE', 'FARMER_ADVANCES'].includes(draft.section) ? (draft.section === 'TRIAL_BALANCE' ? 'trial-balance' : 'farmer-advances') : draft.section.toLowerCase()) as OpeningSection;
      if (section !== 'trial-balance' && !(await prisma.openingBatch.findFirst({ where: { entityId, section: 'TRIAL_BALANCE', status: 'POSTED' } }))) {
        return fail('Post the trial balance first: the detail clears what it puts into suspense.');
      }

      await prisma.$transaction(async (tx) => {
        const claimed = await tx.openingBatch.updateMany({ where: { id: batchId, status: 'DRAFT' }, data: { status: 'POSTED', postedAt: new Date() } });
        if (claimed.count !== 1) throw new StockRefusal('This batch has already been posted.');
        const names = await namesFor(tx, entityId);
        const rows = JSON.parse(draft.rowsJson) as unknown[];
        let journalId: string | null = null;
        let summary = '';

        if (section === 'trial-balance') {
          const tbRows = rows as (TrialBalanceRow & { functionalMinor: number })[];
          const inventoryCodes = (await tx.account.findMany({ where: { entityId, category: inventoryAccountCategory }, select: { code: true } })).map((a) => a.code);
          const controlCodes = new Set([openingAccounts.receivables, openingAccounts.payables, openingAccounts.agentFloats, openingAccounts.farmerAdvances, ...inventoryCodes]);
          const lines = trialBalanceJournal(tbRows.map((r) => ({ accountCode: r.accountCode, amountMinor: r.functionalMinor, currency: r.currency, txnAmountMinor: r.amountMinor, rate: r.rate })), controlCodes, names);
          const foreign: Record<string, { currency: Currency; rate: string; txnAmountMinor: number }> = {};
          for (const r of tbRows) if (r.currency !== entity.functionalCurrency && !controlCodes.has(r.accountCode)) foreign[r.accountCode] = { currency: r.currency, rate: r.rate, txnAmountMinor: Math.abs(r.amountMinor) };
          journalId = await postOpeningJournal(tx, entityId, lines, cutOver, 'OPENING', `Opening trial balance at ${cutOver}`, principal, foreign);
          summary = `${tbRows.length} account balances; control accounts held in suspense pending the detail`;
        }

        if (section === 'invoices' || section === 'bills') {
          const docRows = rows as OpenDocumentRow[];
          const isInvoice = section === 'invoices';
          const control = isInvoice ? openingAccounts.receivables : openingAccounts.payables;
          const controlAccount = await tx.account.findFirstOrThrow({ where: { entityId, code: control } });
          const counter = await tx.account.findFirstOrThrow({ where: { entityId, code: openingAccounts.suspense } });
          let total = 0;
          for (const r of docRows) {
            const contact = await tx.contact.findFirst({ where: { name: r.contactName, isActive: true } });
            if (!contact) throw new StockRefusal(`Row ${r.row}: no contact named "${r.contactName}". Add it first, or correct the name.`);
            const functional = r.currency === entity.functionalCurrency ? r.outstandingMinor : convertMinor(r.outstandingMinor, r.rate);
            total += functional;
            // The opening document: an ordinary posted document, so payments settle it as usual.
            const entry = await tx.journalEntry.create({
              data: {
                entityId, kind: 'OPENING', reference: r.number, description: `Opening ${isInvoice ? 'invoice' : 'bill'} ${r.number} — ${contact.name}`, postedAt: dateOf(cutOver), postedById: principal.userId,
                lines: {
                  create: [
                    { entityId, accountId: controlAccount.id, contactId: contact.id, txnCurrency: r.currency, txnAmountMinor: fromMinor(r.outstandingMinor), rate: new Prisma.Decimal(r.rate), amountMinor: fromMinor(functional), direction: isInvoice ? ('MONEY_IN' as const) : ('MONEY_OUT' as const) },
                    { entityId, accountId: counter.id, txnCurrency: entity.functionalCurrency, txnAmountMinor: fromMinor(functional), rate: new Prisma.Decimal(1), amountMinor: fromMinor(functional), direction: isInvoice ? ('MONEY_OUT' as const) : ('MONEY_IN' as const) },
                  ],
                },
              },
              select: { id: true },
            });
            await tx.document.create({
              data: {
                entityId, kind: isInvoice ? 'INVOICE' : 'BILL', number: r.number, contactId: contact.id, date: dateOf(r.date), dueDate: dateOf(r.dueDate || r.date), status: 'AWAITING_PAYMENT',
                currency: r.currency, rate: new Prisma.Decimal(r.rate), rateDate: dateOf(cutOver), rateExact: true, vatApplied: false, journalEntryId: entry.id, createdById: principal.userId,
                lines: { create: [{ entityId, position: 0, description: r.note || `Opening balance at ${cutOver}`, quantity: 1, unitPriceMinor: fromMinor(r.outstandingMinor), accountId: counter.id, vatTreatment: 'EXEMPT' }] },
              },
            });
          }
          summary = `${docRows.length} open ${isInvoice ? 'invoices' : 'bills'} totalling ${(total / 100).toFixed(2)}`;
        }

        if (section === 'stock') {
          const stockRows = rows as StockRow[];
          let total = 0;
          let totalGrams = 0;
          const byAccount: Record<string, number> = {};
          for (const r of stockRows) {
            const item = await tx.item.findFirst({ where: { entityId, isActive: true, grade: r.grade, commodity: { code: r.commodityCode } }, include: { account: true, commodity: true } });
            if (!item) throw new StockRefusal(`Row ${r.row}: no grade "${r.grade}" of commodity ${r.commodityCode}.`);
            const location = await tx.stockLocation.findFirst({ where: { entityId, code: r.locationCode, isActive: true }, include: { account: true } });
            if (!location) throw new StockRefusal(`Row ${r.row}: no location ${r.locationCode}.`);
            await moveBalance(tx, entityId, item.id, location.id, r.grams, r.valueMinor);
            const lot = await tx.lot.create({
              data: { entityId, commodityId: item.commodityId as string, itemId: item.id, locationId: location.id, lotRef: r.lotRef || `OPEN-${r.commodityCode}-${r.locationCode}-${r.row}`, date: dateOf(cutOver), gramsIn: fromMinor(r.grams), createdById: principal.userId, note: `Opening stock at ${cutOver}` },
              select: { id: true },
            });
            await tx.stockMovement.create({ data: { entityId, kind: 'RECEIPT', date: dateOf(cutOver), itemId: item.id, toLocationId: location.id, quantityGrams: fromMinor(r.grams), valueMinor: fromMinor(r.valueMinor), lotId: lot.id, createdById: principal.userId, note: `Opening stock at ${cutOver}` } });
            const code = location.account?.code ?? item.account.code;
            byAccount[code] = (byAccount[code] ?? 0) + r.valueMinor;
            total += r.valueMinor;
            totalGrams += r.grams;
          }
          const lines: TradingJournalLine[] = [];
          for (const [code, amount] of Object.entries(byAccount)) lines.push(...detailJournal(code, amount, true, names));
          journalId = await postOpeningJournal(tx, entityId, lines, cutOver, 'OPENING', `Opening stock at ${cutOver}`, principal);
          await tx.stockMovement.updateMany({ where: { entityId, note: `Opening stock at ${cutOver}`, journalEntryId: null }, data: { journalEntryId: journalId } });
          summary = `${stockRows.length} stock rows, ${formatKg(totalGrams)} valued ${(total / 100).toFixed(2)}`;
        }

        if (section === 'floats') {
          const floatRows = rows as FloatRow[];
          let total = 0;
          for (const r of floatRows) {
            const agent = await tx.buyingAgent.findFirst({ where: { entityId, name: r.agentName, isActive: true } });
            if (!agent) throw new StockRefusal(`Row ${r.row}: no buying agent named "${r.agentName}". Add them under Buying first.`);
            await tx.floatAdvance.create({ data: { entityId, agentId: agent.id, date: dateOf(r.date), amountMinor: fromMinor(r.amountMinor), bankAccountId: null, createdById: principal.userId } });
            total += r.amountMinor;
          }
          journalId = await postOpeningJournal(tx, entityId, detailJournal(openingAccounts.agentFloats, total, true, names), cutOver, 'OPENING', `Opening agent floats at ${cutOver}`, principal);
          await tx.floatAdvance.updateMany({ where: { entityId, bankAccountId: null, journalEntryId: null }, data: { journalEntryId: journalId } });
          summary = `${floatRows.length} outstanding floats totalling ${(total / 100).toFixed(2)}`;
        }

        if (section === 'farmer-advances') {
          const advanceRows = rows as FarmerAdvanceRow[];
          let total = 0;
          for (const r of advanceRows) {
            await tx.farmerAdvance.create({ data: { entityId, farmerName: r.farmerName, community: r.community || null, district: r.district || null, date: dateOf(r.date), amountMinor: fromMinor(r.amountMinor), note: r.note || null, createdById: principal.userId } });
            total += r.amountMinor;
          }
          journalId = await postOpeningJournal(tx, entityId, detailJournal(openingAccounts.farmerAdvances, total, true, names), cutOver, 'OPENING', `Opening farmer advances at ${cutOver}`, principal);
          await tx.farmerAdvance.updateMany({ where: { entityId, journalEntryId: null }, data: { journalEntryId: journalId } });
          summary = `${advanceRows.length} farmer advances totalling ${(total / 100).toFixed(2)}`;
        }

        if (section === 'contracts') {
          const contractRows = rows as ContractRow[];
          for (const r of contractRows) {
            const buyer = await tx.contact.findFirst({ where: { name: r.buyerName, isActive: true } });
            if (!buyer) throw new StockRefusal(`Row ${r.row}: no contact named "${r.buyerName}".`);
            const item = await tx.item.findFirst({ where: { entityId, isActive: true, grade: r.grade, commodity: { code: r.commodityCode } } });
            if (!item) throw new StockRefusal(`Row ${r.row}: no grade "${r.grade}" of commodity ${r.commodityCode}.`);
            if (await tx.salesContract.findFirst({ where: { entityId, contractNo: r.contractNo } })) throw new StockRefusal(`Row ${r.row}: contract ${r.contractNo} already exists.`);
            const contract = await tx.salesContract.create({
              data: {
                entityId, contractNo: r.contractNo, buyerContactId: buyer.id, commodityId: item.commodityId as string, itemId: item.id, quantityGrams: fromMinor(r.grams),
                priceMinor: fromMinor(r.priceMinor), priceUnit: r.priceUnit === 'bag' ? 'BAG' : r.priceUnit === 'tonne' ? 'TONNE' : 'KG', currency: r.currency,
                contractRate: r.contractRate ? new Prisma.Decimal(r.contractRate) : null, deliveryTerms: r.deliveryTerms || 'as agreed', deliveryFrom: dateOf(r.deliveryFrom), deliveryTo: dateOf(r.deliveryTo),
                recognizeOn: r.recognizeOn === 'acceptance' ? 'ACCEPTANCE' : 'DELIVERY', saleType: r.saleType === 'domestic' ? 'DOMESTIC' : 'EXPORT',
                status: r.deliveredGrams >= r.grams ? 'CLOSED' : 'OPEN', note: `Imported at cut-over ${cutOver}`, createdById: principal.userId,
              },
              select: { id: true },
            });
            // What was delivered before the cut-over: quantity only. Its revenue and cost are already in the trial balance.
            if (r.deliveredGrams > 0) {
              await tx.contractDelivery.create({
                data: { entityId, contractId: contract.id, deliveryNo: 1, date: dateOf(cutOver), locationId: (await tx.stockLocation.findFirstOrThrow({ where: { entityId, isActive: true } })).id, grams: fromMinor(r.deliveredGrams), destination: 'Before cut-over', rate: new Prisma.Decimal(r.contractRate ?? '1.0'), revenueTxnMinor: 0n, revenueMinor: 0n, costMinor: 0n, status: 'BEFORE_CUTOVER', note: 'Delivered before the cut-over date; revenue and cost are in the opening trial balance.', createdById: principal.userId },
              });
            }
          }
          summary = `${contractRows.length} open contracts`;
        }

        await tx.openingBatch.update({ where: { id: batchId }, data: { journalEntryId: journalId } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'POST', resourceType: 'opening', resourceRef: sectionLabels[section], summary: `Opening ${sectionLabels[section].toLowerCase()} posted at ${cutOver}: ${summary}`, metadata: { batchId, journalEntryId: journalId, rows: rows.length } }, tx);
      });

      refresh();
      return { ok: true, value: await openingStatus(entityId) };
    }),
  );
}

// --- go live ------------------------------------------------------------------------------------

export async function openingChecklist(entityId: string): Promise<ActionResult<{ status: OpeningStatusRecord; items: { key: string; label: string; done: boolean; detail: string }[]; canGoLive: boolean }>> {
  return withEntityAccess(entityId, 'reports:view', () =>
    refusable(async () => {
      const status = await openingStatus(entityId);
      const tb = status.batches.find((b) => b.section === 'trial-balance' && b.status === 'posted');
      const foreignRowsWithoutRate = tb ? (tb.rows as { currency: string; rate: string }[]).filter((r) => r.currency !== 'GHS' && (!r.rate || r.rate === '1.0')).length : 0;
      const { items, canGoLive } = goLiveChecklist({
        cutOverDate: status.cutOverDate,
        liveAt: status.liveAt,
        trialBalancePosted: status.trialBalancePosted,
        trialBalanceBalances: status.trialBalancePosted,
        controls: status.controls,
        suspenseMinor: status.suspenseMinor,
        foreignRowsWithoutRate,
        contractsPosted: status.contractsPosted,
        contractsCount: status.contractsCount,
      });
      return { ok: true, value: { status, items, canGoLive } };
    }),
  );
}

/** Mark the entity live. Refused while anything on the checklist is outstanding. */
export async function goLive(entityId: string): Promise<ActionResult<EntityRecord>> {
  return withEntityAccess(entityId, 'entity:configure', (principal) =>
    refusable(async () => {
      const entity = await prisma.entity.findUniqueOrThrow({ where: { id: entityId } });
      if (entity.liveAt) return fail(`${entity.name} is already live.`);
      const checklist = await openingChecklist(entityId);
      if (!checklist.ok) return checklist;
      if (!checklist.value.canGoLive) {
        const outstanding = checklist.value.items.filter((i) => !i.done).map((i) => `${i.label} — ${i.detail}`);
        return fail(`Not ready: ${outstanding.join(' · ')}`);
      }
      const drafts = await prisma.openingBatch.count({ where: { entityId, status: 'DRAFT' } });
      if (drafts > 0) return fail(`${drafts} uploaded sheet(s) are still drafts. Post or discard them first.`);
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.entity.update({ where: { id: entityId }, data: { liveAt: new Date() } });
        await recordAuditEvent({ entityId, userId: principal.userId, userName: principal.name, action: 'EDIT', resourceType: 'entity', resourceRef: entityId, summary: `${entity.name} went live: opening balances at ${entity.cutOverDate?.toISOString().slice(0, 10)}, suspense zero`, metadata: { cutOverDate: entity.cutOverDate?.toISOString().slice(0, 10), controls: checklist.value.status.controls } }, tx);
        return row;
      });
      refresh();
      return { ok: true, value: entityRecord(updated) };
    }),
  );
}
